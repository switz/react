'use strict';

/**
 * Fused Renderer Performance Validation Benchmark
 *
 * Measures the Flight→Fizz pipeline overhead to validate whether
 * fusing the renderers would deliver meaningful performance wins.
 *
 * Usage: NODE_ENV=production node --expose-gc scripts/bench/fused-renderer-bench.js
 */

const {performance} = require('perf_hooks');
const {PassThrough, Readable} = require('stream');
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
// Utilities
// ---------------------------------------------------------------------------

function collectStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

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
  const m = mean(arr);
  return Math.sqrt(
    arr.reduce((acc, v) => acc + (v - m) ** 2, 0) / (arr.length - 1)
  );
}

// ---------------------------------------------------------------------------
// Pipeline runners
// ---------------------------------------------------------------------------

/**
 * Full three-pass pipeline: Flight serialize → Flight deserialize → Fizz render
 */
async function runFullPipeline(scenario) {
  const result = {
    flightSerializeMs: 0,
    flightDeserializeMs: 0,
    fizzRenderMs: 0,
    totalMs: 0,
    flightPayloadBytes: 0,
    htmlOutputBytes: 0,
    totalBytes: 0,
    memBefore: 0,
    memAfter: 0,
    memDelta: 0,
  };

  if (global.gc) global.gc();
  result.memBefore = process.memoryUsage().heapUsed;
  const totalStart = performance.now();

  // Phase 1: Flight serialization
  const flightStart = performance.now();
  const flightStream = new PassThrough();
  const flightPipeable = FlightServer.renderToPipeableStream(
    scenario.tree,
    webpackClientMap
  );
  const flightCollectPromise = collectStream(flightStream);
  flightPipeable.pipe(flightStream);
  const flightBuffer = await flightCollectPromise;
  result.flightSerializeMs = performance.now() - flightStart;
  result.flightPayloadBytes = flightBuffer.length;

  // Phase 2: Flight deserialization
  const deserStart = performance.now();
  const flightReadable = new Readable({
    read() {
      this.push(flightBuffer);
      this.push(null);
    },
  });
  const ssrManifest = {
    moduleMap: ssrModuleMap,
    moduleLoading: {prefix: '/'},
    serverModuleMap: null,
  };
  const flightResponse = FlightClient.createFromNodeStream(
    flightReadable,
    ssrManifest
  );
  await flightResponse;
  result.flightDeserializeMs = performance.now() - deserStart;

  // Phase 3: Fizz HTML rendering
  const fizzStart = performance.now();
  function ClientRoot() {
    return React.use(flightResponse);
  }
  const htmlStream = new PassThrough();
  const htmlCollectPromise = collectStream(htmlStream);
  await new Promise((resolve, reject) => {
    const pipeable = ReactDOMServer.renderToPipeableStream(
      React.createElement(ClientRoot),
      {
        onShellReady() {
          pipeable.pipe(htmlStream);
        },
        onAllReady() {
          resolve();
        },
        onShellError: reject,
        onError: reject,
      }
    );
  });
  htmlStream.end();
  const htmlBuffer = await htmlCollectPromise;
  result.fizzRenderMs = performance.now() - fizzStart;
  result.htmlOutputBytes = htmlBuffer.length;
  result.totalMs = performance.now() - totalStart;
  result.totalBytes = result.flightPayloadBytes + result.htmlOutputBytes;

  if (global.gc) global.gc();
  result.memAfter = process.memoryUsage().heapUsed;
  result.memDelta = result.memAfter - result.memBefore;
  return result;
}

/**
 * Fizz-only pipeline (pre-resolved elements, no Flight overhead measured).
 */
async function runFizzOnlyPipeline(scenario) {
  const result = {fizzRenderMs: 0, htmlOutputBytes: 0};

  // Resolve through Flight first (off the clock)
  const flightStream = new PassThrough();
  const flightPipeable = FlightServer.renderToPipeableStream(
    scenario.tree,
    webpackClientMap
  );
  const flightCollectPromise = collectStream(flightStream);
  flightPipeable.pipe(flightStream);
  const flightBuffer = await flightCollectPromise;
  const flightReadable = new Readable({
    read() {
      this.push(flightBuffer);
      this.push(null);
    },
  });
  const ssrManifest = {
    moduleMap: ssrModuleMap,
    moduleLoading: {prefix: '/'},
    serverModuleMap: null,
  };
  const flightResponse = FlightClient.createFromNodeStream(
    flightReadable,
    ssrManifest
  );

  // Now measure only Fizz
  function ClientRoot() {
    return React.use(flightResponse);
  }
  const fizzStart = performance.now();
  const htmlStream = new PassThrough();
  const htmlCollectPromise = collectStream(htmlStream);
  await new Promise((resolve, reject) => {
    const pipeable = ReactDOMServer.renderToPipeableStream(
      React.createElement(ClientRoot),
      {
        onShellReady() {
          pipeable.pipe(htmlStream);
        },
        onAllReady() {
          resolve();
        },
        onShellError: reject,
        onError: reject,
      }
    );
  });
  htmlStream.end();
  const htmlBuffer = await htmlCollectPromise;
  result.fizzRenderMs = performance.now() - fizzStart;
  result.htmlOutputBytes = htmlBuffer.length;
  return result;
}

// ---------------------------------------------------------------------------
// Benchmark runner
// ---------------------------------------------------------------------------

const WARMUP_RUNS = 3;
const MEASURED_RUNS = 20;

async function benchmarkScenario(scenarioBuilder) {
  const scenario = scenarioBuilder();

  console.log(`\n${'='.repeat(70)}`);
  console.log(`Scenario: ${scenario.name}`);
  console.log(`Description: ${scenario.description}`);
  console.log(`Components: ~${scenario.componentCount}`);
  console.log('='.repeat(70));

  console.log(`  Warming up (${WARMUP_RUNS} runs)...`);
  for (let i = 0; i < WARMUP_RUNS; i++) {
    const s = scenarioBuilder();
    await runFullPipeline(s);
  }

  console.log(`  Measuring (${MEASURED_RUNS} runs)...`);
  const fullResults = [];
  const fizzOnlyResults = [];

  for (let i = 0; i < MEASURED_RUNS; i++) {
    const s = scenarioBuilder();
    fullResults.push(await runFullPipeline(s));
  }
  for (let i = 0; i < MEASURED_RUNS; i++) {
    const s = scenarioBuilder();
    fizzOnlyResults.push(await runFizzOnlyPipeline(s));
  }

  const agg = {
    flightSerialize: {
      median: median(fullResults.map(r => r.flightSerializeMs)),
      mean: mean(fullResults.map(r => r.flightSerializeMs)),
      stdev: stdev(fullResults.map(r => r.flightSerializeMs)),
    },
    flightDeserialize: {
      median: median(fullResults.map(r => r.flightDeserializeMs)),
      mean: mean(fullResults.map(r => r.flightDeserializeMs)),
      stdev: stdev(fullResults.map(r => r.flightDeserializeMs)),
    },
    fizzRender: {
      median: median(fullResults.map(r => r.fizzRenderMs)),
      mean: mean(fullResults.map(r => r.fizzRenderMs)),
      stdev: stdev(fullResults.map(r => r.fizzRenderMs)),
    },
    total: {
      median: median(fullResults.map(r => r.totalMs)),
      mean: mean(fullResults.map(r => r.totalMs)),
      stdev: stdev(fullResults.map(r => r.totalMs)),
    },
    flightPayloadBytes: median(fullResults.map(r => r.flightPayloadBytes)),
    htmlOutputBytes: median(fullResults.map(r => r.htmlOutputBytes)),
    totalBytes: median(fullResults.map(r => r.totalBytes)),
    memDelta: median(fullResults.map(r => r.memDelta)),
  };

  const aggFizzOnly = {
    fizzRender: {
      median: median(fizzOnlyResults.map(r => r.fizzRenderMs)),
    },
  };

  const flightOverheadMs =
    agg.flightSerialize.median + agg.flightDeserialize.median;
  const flightOverheadPct = (flightOverheadMs / agg.total.median) * 100;
  const fizzOnlyPct = (agg.fizzRender.median / agg.total.median) * 100;

  console.log(
    '\n  --- Timing Breakdown (median of %d runs) ---',
    MEASURED_RUNS
  );
  console.log(
    '  Flight serialize:     %s (±%s)',
    formatMs(agg.flightSerialize.median),
    formatMs(agg.flightSerialize.stdev)
  );
  console.log(
    '  Flight deserialize:   %s (±%s)',
    formatMs(agg.flightDeserialize.median),
    formatMs(agg.flightDeserialize.stdev)
  );
  console.log(
    '  Fizz render:          %s (±%s)',
    formatMs(agg.fizzRender.median),
    formatMs(agg.fizzRender.stdev)
  );
  console.log(
    '  Total:                %s (±%s)',
    formatMs(agg.total.median),
    formatMs(agg.total.stdev)
  );
  console.log(
    '  Fizz-only (no Flight):%s',
    formatMs(aggFizzOnly.fizzRender.median)
  );
  console.log('\n  --- Overhead Analysis ---');
  console.log(
    '  Flight overhead:      %s (%s%% of total)',
    formatMs(flightOverheadMs),
    flightOverheadPct.toFixed(1)
  );
  console.log('  Fizz render:          %s%% of total', fizzOnlyPct.toFixed(1));
  console.log(
    '  Max fusion win:       %s (eliminating Flight entirely)',
    formatMs(flightOverheadMs)
  );
  console.log('\n  --- Payload Sizes ---');
  console.log(
    '  Flight wire format:   %s',
    formatBytes(agg.flightPayloadBytes)
  );
  console.log('  HTML output:          %s', formatBytes(agg.htmlOutputBytes));
  console.log('  Total output:         %s', formatBytes(agg.totalBytes));
  console.log(
    "  Intermediate bloat:   %s (Flight payload that wouldn't exist in fused)",
    formatBytes(agg.flightPayloadBytes)
  );
  console.log('\n  --- Memory ---');
  console.log(
    '  Heap delta (median):  %s',
    formatBytes(Math.abs(agg.memDelta))
  );

  return {
    scenario: scenario.name,
    ...agg,
    fizzOnly: aggFizzOnly,
    flightOverheadMs,
    flightOverheadPct,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(
    '╔══════════════════════════════════════════════════════════════════════╗'
  );
  console.log(
    '║       Fused Renderer Performance Validation Benchmark              ║'
  );
  console.log(
    '║       Measuring Flight→Fizz pipeline overhead                      ║'
  );
  console.log(
    '╚══════════════════════════════════════════════════════════════════════╝'
  );
  console.log('');
  console.log('Node.js:', process.version);
  console.log('Warmup runs:', WARMUP_RUNS);
  console.log('Measured runs:', MEASURED_RUNS);
  console.log(
    'GC exposed:',
    typeof global.gc === 'function'
      ? 'yes'
      : 'no (use --expose-gc for memory data)'
  );

  const {createScenarios} = require('./fused-renderer-scenarios');
  const scenarios = createScenarios(ServerReact, React, clientExports);
  const allResults = [];

  for (const builder of scenarios) {
    try {
      const result = await benchmarkScenario(builder);
      allResults.push(result);
    } catch (err) {
      console.error(`  ERROR in scenario: ${err.message}`);
      console.error(err.stack);
    }
  }

  // Summary table
  console.log('\n\n');
  console.log(
    '╔══════════════════════════════════════════════════════════════════════╗'
  );
  console.log(
    '║                          SUMMARY TABLE                             ║'
  );
  console.log(
    '╚══════════════════════════════════════════════════════════════════════╝'
  );
  console.log('');

  const header =
    'Scenario        | Flight Ser | Flight Des | Fizz Render | Total     | Flight % | Wire KB  | HTML KB';
  const sep =
    '----------------|------------|------------|-------------|-----------|----------|----------|--------';
  console.log(header);
  console.log(sep);

  for (const r of allResults) {
    const name = r.scenario.padEnd(15);
    const fSer = formatMs(r.flightSerialize.median).padStart(10);
    const fDes = formatMs(r.flightDeserialize.median).padStart(10);
    const fizz = formatMs(r.fizzRender.median).padStart(11);
    const total = formatMs(r.total.median).padStart(9);
    const pct = (r.flightOverheadPct.toFixed(1) + '%').padStart(8);
    const wire = formatBytes(r.flightPayloadBytes).padStart(8);
    const html = formatBytes(r.htmlOutputBytes).padStart(7);
    console.log(
      `${name} | ${fSer} | ${fDes} | ${fizz} | ${total} | ${pct} | ${wire} | ${html}`
    );
  }

  console.log('');
  console.log('Flight % = (Flight serialize + Flight deserialize) / Total');
  console.log(
    'This is the maximum possible improvement from fusing renderers.'
  );

  const jsonPath = path.join(__dirname, 'fused-renderer-bench-results.json');
  const fs = require('fs');
  fs.writeFileSync(jsonPath, JSON.stringify(allResults, null, 2));
  console.log(`\nRaw results written to: ${jsonPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
