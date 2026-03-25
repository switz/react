'use strict';

/**
 * Concurrent throughput benchmark for the fused renderer analysis.
 *
 * Measures what happens to a real single-threaded Node.js server under load:
 * - Throughput (req/s) at varying concurrency levels
 * - Latency percentiles (p50, p95, p99)
 * - Heap pressure from intermediate Flight wire format buffers
 *
 * This is the benchmark that matters for the go/no-go decision.
 * Wall-clock time per request is misleading — CPU contention under
 * concurrent load is what kills real servers.
 *
 * Usage: NODE_ENV=production node --expose-gc scripts/bench/fused-renderer-concurrent.js
 */

const {performance} = require('perf_hooks');
const {PassThrough, Readable} = require('stream');
const path = require('path');
const url = require('url');
const Module = require('module');

// ---------------------------------------------------------------------------
// React package setup (same as fused-renderer-bench.js)
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

const origResolve = Module._resolveFilename;
let curReact = SERVER_REACT_PATH;
Module._resolveFilename = function (req, p, m, o) {
  if (req === 'react') return curReact;
  if (req === 'react-dom') return REACT_DOM_PATH;
  return origResolve.call(this, req, p, m, o);
};

let modIdx = 0;
const clientMods = {};
const clientMap = {};
const ssrMap = {};
global.__webpack_chunk_load__ = function (id) {
  return Promise.resolve();
};
global.__webpack_require__ = function (id) {
  return clientMods[id];
};
global.__webpack_get_script_filename__ = function (id) {
  return id;
};

function clientExports(mod) {
  const idx = '' + modIdx++;
  clientMods[idx] = mod;
  const fp = url.pathToFileURL(idx).href;
  clientMap[fp] = {id: idx, chunks: [], name: '*'};
  ssrMap[idx] = {'*': {id: idx, chunks: [], name: '*'}};
  const ref = Object.defineProperties(function () {}, {
    $$typeof: {value: Symbol.for('react.client.reference')},
    $$id: {value: fp},
    $$async: {value: false},
  });
  if (typeof mod === 'function') Object.assign(ref, mod);
  return ref;
}

curReact = SERVER_REACT_PATH;
const SReact = require(SERVER_REACT_PATH);
const FlightSrv = require(path.join(
  BUILD_DIR,
  'react-server-dom-webpack/cjs/react-server-dom-webpack-server.node.production.js'
));
delete require.cache[SERVER_REACT_PATH];
curReact = CLIENT_REACT_PATH;
const React = require(CLIENT_REACT_PATH);
const RDOM = require(path.join(
  BUILD_DIR,
  'react-dom/cjs/react-dom-server.node.production.js'
));
const FlightCli = require(path.join(
  BUILD_DIR,
  'react-server-dom-webpack/cjs/react-server-dom-webpack-client.node.production.js'
));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collect(s) {
  return new Promise((res, rej) => {
    const c = [];
    s.on('data', d => c.push(d));
    s.on('end', () => res(Buffer.concat(c)));
    s.on('error', rej);
  });
}

function percentile(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor((s.length * p) / 100)];
}

// ---------------------------------------------------------------------------
// Test app: 226-product e-commerce PLP (sync, CPU-bound)
// ---------------------------------------------------------------------------

const {generateProduct} = require('./fused-renderer-data');
const products = Array.from({length: 226}, (_, i) => generateProduct(i));

const ClientCard = clientExports(function ClientCard({product}) {
  const e = React.createElement;
  return e(
    'div',
    {className: 'card', 'data-id': product.id},
    e('img', {src: product.images[0].url, alt: product.images[0].alt}),
    e('h3', null, product.name),
    e('p', null, product.description.slice(0, 150)),
    e(
      'div',
      {className: 'price'},
      e('span', null, product.price.formatted),
      e('s', null, '$' + product.price.compareAt)
    ),
    e('div', {className: 'rating'}, '★★★★ (' + product.rating.count + ')'),
    e(
      'div',
      {className: 'actions'},
      e('button', null, 'Add to Cart'),
      e('button', null, '♡')
    )
  );
});

function ServerApp() {
  const e = SReact.createElement;
  return e(
    'div',
    {id: 'app'},
    e(
      'header',
      null,
      e('h1', null, 'Store'),
      e(
        'nav',
        null,
        ...['Home', 'Products', 'About', 'Contact', 'Help'].map(x =>
          e('a', {key: x, href: '#'}, x)
        )
      )
    ),
    e(
      'main',
      null,
      e('h2', null, '226 Products'),
      ...products.map((p, i) => e(ClientCard, {key: i, product: p}))
    ),
    e(
      'footer',
      null,
      ...['About', 'Privacy', 'Terms', 'Help', 'Careers'].map(x =>
        e('a', {key: x, href: '#'}, x)
      )
    )
  );
}

// ---------------------------------------------------------------------------
// Request handlers
// ---------------------------------------------------------------------------

// Pre-resolved tree for Fizz-only tests
let preResolved = null;

async function initPreResolved() {
  const fs = new PassThrough();
  FlightSrv.renderToPipeableStream(
    SReact.createElement(ServerApp),
    clientMap
  ).pipe(fs);
  const fb = await collect(fs);
  const fr = new Readable({
    read() {
      this.push(fb);
      this.push(null);
    },
  });
  preResolved = FlightCli.createFromNodeStream(fr, {
    moduleMap: ssrMap,
    moduleLoading: {prefix: '/'},
    serverModuleMap: null,
  });
  await preResolved;
}

async function doFizzOnly() {
  const start = performance.now();
  function Root() {
    return React.use(preResolved);
  }
  const hs = new PassThrough();
  const hc = collect(hs);
  await new Promise((res, rej) => {
    const p = RDOM.renderToPipeableStream(React.createElement(Root), {
      onShellReady() {
        p.pipe(hs);
      },
      onAllReady() {
        res();
      },
      onShellError: rej,
      onError() {},
    });
  });
  hs.end();
  await hc;
  return performance.now() - start;
}

async function doFullPipeline() {
  const start = performance.now();
  const fs = new PassThrough();
  FlightSrv.renderToPipeableStream(
    SReact.createElement(ServerApp),
    clientMap
  ).pipe(fs);
  const fb = await collect(fs);
  const fr = new Readable({
    read() {
      this.push(fb);
      this.push(null);
    },
  });
  const resp = FlightCli.createFromNodeStream(fr, {
    moduleMap: ssrMap,
    moduleLoading: {prefix: '/'},
    serverModuleMap: null,
  });
  await resp;
  function Root() {
    return React.use(resp);
  }
  const hs = new PassThrough();
  const hc = collect(hs);
  await new Promise((res, rej) => {
    const p = RDOM.renderToPipeableStream(React.createElement(Root), {
      onShellReady() {
        p.pipe(hs);
      },
      onAllReady() {
        res();
      },
      onShellError: rej,
      onError() {},
    });
  });
  hs.end();
  await hc;
  return performance.now() - start;
}

async function doFusedMode() {
  const start = performance.now();
  // In fused mode, the tree goes directly to Fizz with server component
  // functions and client reference proxies still present. No Flight at all.
  // Fizz calls server component functions inline and wraps client refs
  // in <!--C:ID--> markers with hydration data scripts.
  const hs = new PassThrough();
  const hc = collect(hs);
  await new Promise((res, rej) => {
    const p = RDOM.renderToPipeableStream(SReact.createElement(ServerApp), {
      experimental_fusedMode: true,
      onShellReady() {
        p.pipe(hs);
      },
      onAllReady() {
        res();
      },
      onShellError: rej,
      onError() {},
    });
  });
  hs.end();
  await hc;
  return performance.now() - start;
}

// ---------------------------------------------------------------------------
// Concurrent runner
// ---------------------------------------------------------------------------

async function runConcurrent(fn, concurrency, totalRequests) {
  const latencies = [];
  let completed = 0;
  let inFlight = 0;

  const batchStart = performance.now();

  if (global.gc) global.gc();
  const memBefore = process.memoryUsage();
  let peakHeap = memBefore.heapUsed;

  await new Promise(resolve => {
    function launch() {
      while (inFlight < concurrency && completed + inFlight < totalRequests) {
        inFlight++;
        fn().then(latency => {
          latencies.push(latency);
          inFlight--;
          completed++;
          const mem = process.memoryUsage();
          if (mem.heapUsed > peakHeap) peakHeap = mem.heapUsed;
          if (completed >= totalRequests) resolve();
          else launch();
        });
      }
    }
    launch();
  });

  const batchMs = performance.now() - batchStart;

  if (global.gc) global.gc();

  return {
    throughput: Math.round((totalRequests / batchMs) * 1000),
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    peakHeapDeltaMB: (peakHeap - memBefore.heapUsed) / 1024 / 1024,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const TOTAL_REQUESTS = 200;
const CONCURRENCIES = [1, 5, 10, 25, 50];

function fmtRow(r) {
  return [
    String(r.throughput).padStart(6),
    (r.p50.toFixed(1) + 'ms').padStart(8),
    (r.p95.toFixed(1) + 'ms').padStart(8),
    (r.p99.toFixed(1) + 'ms').padStart(8),
    (r.peakHeapDeltaMB.toFixed(0) + 'MB').padStart(6),
  ].join(' | ');
}

async function main() {
  console.log('Concurrent Throughput Benchmark: 226-product PLP');
  console.log('Single Node.js thread, no I/O waits, pure CPU contention');
  console.log(
    'GC:',
    typeof global.gc === 'function' ? 'exposed' : 'NOT exposed'
  );
  console.log('');

  await initPreResolved();

  // Warmup
  for (let i = 0; i < 15; i++) await doFullPipeline();
  for (let i = 0; i < 15; i++) await doFizzOnly();
  for (let i = 0; i < 15; i++) await doFusedMode();

  const fizzResults = [];
  const fullResults = [];
  const fusedResults = [];

  console.log('--- Fizz Only (theoretical ceiling) ---');
  console.log('    c | req/s  |      p50 |      p95 |      p99 |  Heap');
  console.log('  ----|--------|----------|----------|----------|------');
  for (const c of CONCURRENCIES) {
    const r = await runConcurrent(doFizzOnly, c, TOTAL_REQUESTS);
    fizzResults.push({c, ...r});
    console.log('  %s | %s', String(c).padStart(3), fmtRow(r));
  }

  console.log('');
  console.log('--- Full Flight→Fizz Pipeline (baseline) ---');
  console.log('    c | req/s  |      p50 |      p95 |      p99 |  Heap');
  console.log('  ----|--------|----------|----------|----------|------');
  for (const c of CONCURRENCIES) {
    const r = await runConcurrent(doFullPipeline, c, TOTAL_REQUESTS);
    fullResults.push({c, ...r});
    console.log('  %s | %s', String(c).padStart(3), fmtRow(r));
  }

  console.log('');
  console.log('--- Fused Renderer (our implementation) ---');
  console.log('    c | req/s  |      p50 |      p95 |      p99 |  Heap');
  console.log('  ----|--------|----------|----------|----------|------');
  for (const c of CONCURRENCIES) {
    const r = await runConcurrent(doFusedMode, c, TOTAL_REQUESTS);
    fusedResults.push({c, ...r});
    console.log('  %s | %s', String(c).padStart(3), fmtRow(r));
  }

  console.log('');
  console.log('--- Comparison ---');
  console.log(
    '    c | Fizz req/s | Full req/s | Fused req/s | Full→Fused | Fused vs Ceiling'
  );
  console.log(
    '  ----|------------|------------|-------------|------------|----------------'
  );
  for (let i = 0; i < CONCURRENCIES.length; i++) {
    const f = fizzResults[i];
    const p = fullResults[i];
    const u = fusedResults[i];
    console.log(
      '  %s | %s | %s | %s |     %sx |     %s%%',
      String(CONCURRENCIES[i]).padStart(3),
      String(f.throughput).padStart(10),
      String(p.throughput).padStart(10),
      String(u.throughput).padStart(11),
      (u.throughput / p.throughput).toFixed(1).padStart(5),
      ((u.throughput / f.throughput) * 100).toFixed(0).padStart(5)
    );
  }

  // JSON output
  const jsonPath = path.join(
    __dirname,
    'fused-renderer-concurrent-results.json'
  );
  require('fs').writeFileSync(
    jsonPath,
    JSON.stringify({fizzResults, fullResults, fusedResults}, null, 2)
  );
  console.log('\nRaw results:', jsonPath);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
