'use strict';

/**
 * Pipeline runners for the fused renderer benchmark.
 * Extracted from fused-renderer-bench.js to keep files under 500 lines.
 */

const {performance} = require('perf_hooks');
const {PassThrough, Readable} = require('stream');

function collectStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function collectStreamWithTTFB(stream, startTime) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let ttfb = null;
    stream.on('data', chunk => {
      if (ttfb === null) ttfb = performance.now() - startTime;
      chunks.push(chunk);
    });
    stream.on('end', () =>
      resolve({
        buffer: Buffer.concat(chunks),
        ttfb: ttfb || 0,
        totalMs: performance.now() - startTime,
      })
    );
    stream.on('error', reject);
  });
}

/**
 * Creates pipeline runner functions bound to the given React packages and
 * webpack maps. Returns {runFullPipeline, runIsolatedPhases}.
 */
function createPipelineRunners({
  FlightServer,
  FlightClient,
  ReactDOMServer,
  React,
  webpackClientMap,
  ssrModuleMap,
}) {
  /**
   * Full three-pass pipeline: Flight serialize → Flight deserialize → Fizz render.
   * Measures TTFB for both Flight and Fizz streams.
   */
  async function runFullPipeline(scenario) {
    const result = {
      flightSerializeMs: 0,
      flightTTFB: 0,
      flightDeserializeMs: 0,
      fizzRenderMs: 0,
      fizzTTFB: 0,
      totalMs: 0,
      totalTTFB: 0,
      flightPayloadBytes: 0,
      htmlOutputBytes: 0,
      memBefore: 0,
      memAfter: 0,
      memDelta: 0,
    };

    if (global.gc) global.gc();
    result.memBefore = process.memoryUsage().heapUsed;
    const totalStart = performance.now();

    // Phase 1: Flight serialization (async — includes data fetches)
    const flightStart = performance.now();
    const flightStream = new PassThrough();
    const flightPipeable = FlightServer.renderToPipeableStream(
      scenario.tree,
      webpackClientMap
    );
    const flightCollect = collectStreamWithTTFB(flightStream, flightStart);
    flightPipeable.pipe(flightStream);
    const flightResult = await flightCollect;
    result.flightSerializeMs = flightResult.totalMs;
    result.flightTTFB = flightResult.ttfb;
    result.flightPayloadBytes = flightResult.buffer.length;

    // Phase 2: Flight deserialization
    const deserStart = performance.now();
    const flightReadable = new Readable({
      read() {
        this.push(flightResult.buffer);
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
    const htmlCollect = collectStreamWithTTFB(htmlStream, fizzStart);
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
          onError() {},
        }
      );
    });
    htmlStream.end();
    const htmlResult = await htmlCollect;
    result.fizzRenderMs = htmlResult.totalMs;
    result.fizzTTFB = htmlResult.ttfb;
    result.htmlOutputBytes = htmlResult.buffer.length;

    result.totalMs = performance.now() - totalStart;
    result.totalTTFB =
      result.flightSerializeMs + result.flightDeserializeMs + result.fizzTTFB;

    if (global.gc) global.gc();
    result.memAfter = process.memoryUsage().heapUsed;
    result.memDelta = result.memAfter - result.memBefore;
    return result;
  }

  /**
   * Isolated phase measurement: Flight+fetch separate from Fizz-only.
   * Used to compute the pure serialization overhead.
   */
  async function runIsolatedPhases(scenario) {
    const result = {
      flightTotalMs: 0,
      flightPayloadBytes: 0,
      fizzOnlyMs: 0,
      fizzOnlyTTFB: 0,
      htmlOutputBytes: 0,
    };

    // Phase A: Flight resolves everything (includes data fetching)
    const flightStart = performance.now();
    const flightStream = new PassThrough();
    const flightPipeable = FlightServer.renderToPipeableStream(
      scenario.tree,
      webpackClientMap
    );
    const flightCollect = collectStream(flightStream);
    flightPipeable.pipe(flightStream);
    const flightBuffer = await flightCollect;
    result.flightTotalMs = performance.now() - flightStart;
    result.flightPayloadBytes = flightBuffer.length;

    // Deserialize (off the clock — fusion wouldn't need this)
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

    // Phase B: Fizz rendering of pre-resolved tree (no data fetch)
    function ClientRoot() {
      return React.use(flightResponse);
    }
    const fizzStart = performance.now();
    const htmlStream = new PassThrough();
    const htmlCollect = collectStreamWithTTFB(htmlStream, fizzStart);
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
          onError() {},
        }
      );
    });
    htmlStream.end();
    const htmlResult = await htmlCollect;
    result.fizzOnlyMs = htmlResult.totalMs;
    result.fizzOnlyTTFB = htmlResult.ttfb;
    result.htmlOutputBytes = htmlResult.buffer.length;

    return result;
  }

  return {runFullPipeline, runIsolatedPhases};
}

module.exports = {createPipelineRunners};
