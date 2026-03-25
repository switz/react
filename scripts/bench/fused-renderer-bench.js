'use strict';

/**
 * Fused Renderer Performance Validation Benchmark (v2 — realistic)
 *
 * Measures the Flight→Fizz pipeline overhead with realistic scenarios:
 * async server components, Suspense boundaries, real prop sizes.
 *
 * Usage: NODE_ENV=production node --expose-gc scripts/bench/fused-renderer-bench.js
 */

const {performance} = require('perf_hooks');
const path = require('path');
const url = require('url');
const Module = require('module');

// ---------------------------------------------------------------------------
// Setup: resolve built React packages
// ---------------------------------------------------------------------------

const BUILD_DIR = path.resolve(__dirname, '../../build/oss-experimental');

const SERVER_REACT_PATH = path.join(
  BUILD_DIR,
  'react/cjs/react.react-server.production.js'
);
const CLIENT_REACT_PATH = path.join(BUILD_DIR, 'react/cjs/react.production.js');
const REACT_DOM_PATH = path.join(
  BUILD_DIR,
  'react-dom/cjs/react-dom.production.js'
);

const originalResolve = Module._resolveFilename;
let currentReactPath = SERVER_REACT_PATH;

Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'react') return currentReactPath;
  if (request === 'react-dom') return REACT_DOM_PATH;
  return originalResolve.call(this, request, parent, isMain, options);
};

// ---------------------------------------------------------------------------
// Webpack mock
// ---------------------------------------------------------------------------

let webpackModuleIdx = 0;
const webpackClientModules = {};
const webpackClientMap = {};
const ssrModuleMap = {};

global.__webpack_chunk_load__ = function (id) {
  return Promise.resolve();
};
global.__webpack_require__ = function (id) {
  return webpackClientModules[id];
};
global.__webpack_get_script_filename__ = function (id) {
  return id;
};

function clientExports(moduleExports) {
  const idx = '' + webpackModuleIdx++;
  webpackClientModules[idx] = moduleExports;
  const filepath = url.pathToFileURL(idx).href;
  webpackClientMap[filepath] = {id: idx, chunks: [], name: '*'};
  ssrModuleMap[idx] = {'*': {id: idx, chunks: [], name: '*'}};
  const ref = Object.defineProperties(function () {}, {
    $$typeof: {value: Symbol.for('react.client.reference')},
    $$id: {value: filepath},
    $$async: {value: false},
  });
  if (typeof moduleExports === 'function') {
    Object.assign(ref, moduleExports);
    ref.displayName = moduleExports.name;
  } else if (typeof moduleExports === 'object') {
    Object.assign(ref, moduleExports);
  }
  return ref;
}

// ---------------------------------------------------------------------------
// Load React packages
// ---------------------------------------------------------------------------

currentReactPath = SERVER_REACT_PATH;
const ServerReact = require(SERVER_REACT_PATH);
const FlightServer = require(path.join(
  BUILD_DIR,
  'react-server-dom-webpack/cjs/react-server-dom-webpack-server.node.production.js'
));

delete require.cache[SERVER_REACT_PATH];
currentReactPath = CLIENT_REACT_PATH;
const React = require(CLIENT_REACT_PATH);
const ReactDOMServer = require(path.join(
  BUILD_DIR,
  'react-dom/cjs/react-dom-server.node.production.js'
));
const FlightClient = require(path.join(
  BUILD_DIR,
  'react-server-dom-webpack/cjs/react-server-dom-webpack-client.node.production.js'
));

// ---------------------------------------------------------------------------
// Pipeline runners (extracted to separate file)
// ---------------------------------------------------------------------------

const {createPipelineRunners} = require('./fused-renderer-pipelines');
const {runFullPipeline, runIsolatedPhases} = createPipelineRunners({
  FlightServer,
  FlightClient,
  ReactDOMServer,
  React,
  webpackClientMap,
  ssrModuleMap,
});

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function formatMs(ms) {
  return ms.toFixed(2) + 'ms';
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(
    arr.reduce((acc, v) => acc + (v - m) ** 2, 0) / (arr.length - 1)
  );
}

// ---------------------------------------------------------------------------
// Benchmark runner
// ---------------------------------------------------------------------------

const WARMUP_RUNS = 3;
const MEASURED_RUNS = 15;

async function benchmarkScenario(scenarioBuilder) {
  const scenario = scenarioBuilder();

  console.log(`\n${'='.repeat(72)}`);
  console.log(`Scenario: ${scenario.name}`);
  console.log(`Description: ${scenario.description}`);
  console.log('='.repeat(72));

  console.log(`  Warming up (${WARMUP_RUNS} runs)...`);
  for (let i = 0; i < WARMUP_RUNS; i++) {
    const s = scenarioBuilder();
    await runFullPipeline(s);
  }

  console.log(`  Measuring full pipeline (${MEASURED_RUNS} runs)...`);
  const fullResults = [];
  for (let i = 0; i < MEASURED_RUNS; i++) {
    const s = scenarioBuilder();
    fullResults.push(await runFullPipeline(s));
  }

  console.log(`  Measuring isolated phases (${MEASURED_RUNS} runs)...`);
  const isoResults = [];
  for (let i = 0; i < MEASURED_RUNS; i++) {
    const s = scenarioBuilder();
    isoResults.push(await runIsolatedPhases(s));
  }

  // Aggregate
  const field = (arr, key) => ({
    median: median(arr.map(r => r[key])),
    mean: mean(arr.map(r => r[key])),
    stdev: stdev(arr.map(r => r[key])),
  });

  const full = {
    flightSerialize: field(fullResults, 'flightSerializeMs'),
    flightDeserialize: field(fullResults, 'flightDeserializeMs'),
    fizzRender: field(fullResults, 'fizzRenderMs'),
    total: field(fullResults, 'totalMs'),
    totalTTFB: field(fullResults, 'totalTTFB'),
    flightPayloadBytes: median(fullResults.map(r => r.flightPayloadBytes)),
    htmlOutputBytes: median(fullResults.map(r => r.htmlOutputBytes)),
    memDelta: median(fullResults.map(r => r.memDelta)),
  };

  const iso = {
    flightTotal: field(isoResults, 'flightTotalMs'),
    fizzOnly: field(isoResults, 'fizzOnlyMs'),
  };

  // Serialization overhead = total - (data fetch time) - (pure Fizz cost)
  const serializationOverheadMs =
    full.total.median - (iso.flightTotal.median + iso.fizzOnly.median);
  const serializationOverheadPct =
    (Math.max(0, serializationOverheadMs) / full.total.median) * 100;

  // Print results
  console.log('\n  --- Full Pipeline (median of %d runs) ---', MEASURED_RUNS);
  console.log(
    '  Flight serialize (incl data fetch): %s (±%s)',
    formatMs(full.flightSerialize.median),
    formatMs(full.flightSerialize.stdev)
  );
  console.log(
    '  Flight deserialize:                 %s (±%s)',
    formatMs(full.flightDeserialize.median),
    formatMs(full.flightDeserialize.stdev)
  );
  console.log(
    '  Fizz render (after deser):          %s (±%s)',
    formatMs(full.fizzRender.median),
    formatMs(full.fizzRender.stdev)
  );
  console.log(
    '  End-to-end total:                   %s (±%s)',
    formatMs(full.total.median),
    formatMs(full.total.stdev)
  );
  console.log(
    '  End-to-end TTFB:                    %s',
    formatMs(full.totalTTFB.median)
  );

  console.log('\n  --- Isolated Phases ---');
  console.log(
    '  Flight total (data fetch + ser):    %s (±%s)',
    formatMs(iso.flightTotal.median),
    formatMs(iso.flightTotal.stdev)
  );
  console.log(
    '  Fizz-only (pre-resolved, no fetch): %s (±%s)',
    formatMs(iso.fizzOnly.median),
    formatMs(iso.fizzOnly.stdev)
  );

  console.log('\n  --- Overhead That Fusion Eliminates ---');
  console.log(
    '  Serialization overhead:   %s (%s%% of total)',
    formatMs(Math.max(0, serializationOverheadMs)),
    Math.max(0, serializationOverheadPct).toFixed(1)
  );
  console.log(
    '  Flight deserialize alone: %s',
    formatMs(full.flightDeserialize.median)
  );
  console.log(
    '  Formula: total(%s) - flightWithFetch(%s) - fizzOnly(%s)',
    formatMs(full.total.median),
    formatMs(iso.flightTotal.median),
    formatMs(iso.fizzOnly.median)
  );

  console.log('\n  --- Payload Sizes ---');
  console.log(
    '  Flight wire format:    %s (eliminated by fusion)',
    formatBytes(full.flightPayloadBytes)
  );
  console.log('  HTML output:           %s', formatBytes(full.htmlOutputBytes));

  console.log('\n  --- Memory ---');
  console.log(
    '  Heap delta (median):   %s',
    formatBytes(Math.abs(full.memDelta))
  );

  return {
    scenario: scenario.name,
    full,
    iso,
    serializationOverheadMs: Math.max(0, serializationOverheadMs),
    serializationOverheadPct: Math.max(0, serializationOverheadPct),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(
    '╔════════════════════════════════════════════════════════════════════════╗'
  );
  console.log(
    '║  Fused Renderer Performance Validation (v2 — realistic scenarios)   ║'
  );
  console.log(
    '║  Async server components · Suspense · Real prop sizes               ║'
  );
  console.log(
    '╚════════════════════════════════════════════════════════════════════════╝'
  );
  console.log('');
  console.log('Node.js:', process.version);
  console.log('Warmup:', WARMUP_RUNS, '· Measured:', MEASURED_RUNS);
  console.log(
    'GC:',
    typeof global.gc === 'function'
      ? 'exposed'
      : 'not exposed (use --expose-gc)'
  );

  const {createScenarios} = require('./fused-renderer-scenarios');
  const scenarios = createScenarios(ServerReact, React, clientExports);
  const allResults = [];

  for (const builder of scenarios) {
    try {
      allResults.push(await benchmarkScenario(builder));
    } catch (err) {
      console.error(`  ERROR: ${err.message}\n${err.stack}`);
    }
  }

  // Summary table
  console.log('\n');
  console.log(
    '╔════════════════════════════════════════════════════════════════════════╗'
  );
  console.log(
    '║                          SUMMARY TABLE                              ║'
  );
  console.log(
    '╚════════════════════════════════════════════════════════════════════════╝'
  );
  console.log('');
  console.log(
    'Scenario        | Total     | Fetch+Ser  | Fizz Only | Ser Ovrhd  | Ovrhd %  | Wire      | HTML'
  );
  console.log(
    '----------------|-----------|------------|-----------|------------|----------|-----------|----------'
  );
  for (const r of allResults) {
    const name = r.scenario.padEnd(15);
    const total = formatMs(r.full.total.median).padStart(9);
    const fetchSer = formatMs(r.iso.flightTotal.median).padStart(10);
    const fizzOnly = formatMs(r.iso.fizzOnly.median).padStart(9);
    const overhead = formatMs(r.serializationOverheadMs).padStart(10);
    const pct = (r.serializationOverheadPct.toFixed(1) + '%').padStart(8);
    const wire = formatBytes(r.full.flightPayloadBytes).padStart(9);
    const html = formatBytes(r.full.htmlOutputBytes).padStart(9);
    console.log(
      `${name} | ${total} | ${fetchSer} | ${fizzOnly} | ${overhead} | ${pct} | ${wire} | ${html}`
    );
  }
  console.log('');
  console.log('Total      = end-to-end (Flight serialize + deser + Fizz)');
  console.log(
    'Fetch+Ser  = Flight total (server component execution + serialization)'
  );
  console.log(
    'Fizz Only  = Fizz rendering pre-resolved tree (no fetch, no Flight)'
  );
  console.log(
    'Ser Ovrhd  = Total - Fetch+Ser - Fizz Only = pure serialization overhead'
  );
  console.log(
    'Ovrhd %    = what fusion actually eliminates (data fetch time excluded)'
  );

  const jsonPath = path.join(__dirname, 'fused-renderer-bench-results.json');
  require('fs').writeFileSync(jsonPath, JSON.stringify(allResults, null, 2));
  console.log(`\nRaw results: ${jsonPath}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
