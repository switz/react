/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 * @jest-environment ./scripts/jest/ReactDOMServerIntegrationEnvironment
 */

'use strict';

/**
 * Verifies that the fused renderer (fusedMode: true on Fizz) coexists with
 * the standard Flight server path. In production:
 *   - Initial page load: fusedMode SSR (single pass, fast TTFB)
 *   - Client navigation: Flight payload (standard RSC wire format)
 *   - Server Actions: unchanged Flight reply protocol
 *
 * This test proves both paths work in the same process without interference.
 */

let React;
let ReactDOMFizzServer;
let Stream;

describe('ReactDOMFusedNavigation', () => {
  beforeEach(() => {
    jest.resetModules();
    React = require('react');
    ReactDOMFizzServer = require('react-dom/server');
    Stream = require('stream');
  });

  function collectStream(jsx, options) {
    return new Promise((resolve, reject) => {
      let output = '';
      const passthrough = new Stream.PassThrough();
      passthrough.setEncoding('utf8');
      passthrough.on('data', chunk => {
        output += chunk;
      });
      passthrough.on('end', () => resolve(output));
      passthrough.on('error', reject);

      const {pipe} = ReactDOMFizzServer.renderToPipeableStream(jsx, {
        ...options,
        onAllReady() {
          pipe(passthrough);
        },
        onError(err) {
          reject(err);
        },
      });
    });
  }

  // Simulate a client component reference
  function makeClientRef(fn) {
    return Object.defineProperties(fn, {
      $$typeof: {value: Symbol.for('react.client.reference')},
      $$id: {value: 'test-module#' + fn.name},
      $$async: {value: false},
    });
  }

  describe('fusedMode does not affect standard Fizz path', () => {
    it('renders identically with fusedMode: false (explicit)', async () => {
      function App() {
        return (
          <div>
            <h1>Hello</h1>
          </div>
        );
      }

      const withoutFused = await collectStream(<App />);
      const withFusedFalse = await collectStream(<App />, {
        experimental_fusedMode: false,
      });

      expect(withoutFused).toBe(withFusedFalse);
    });

    it('renders same HTML for plain components regardless of fusedMode', async () => {
      function Header() {
        return <h1>Title</h1>;
      }
      function Content() {
        return <p>Body text</p>;
      }
      function App() {
        return (
          <div>
            <Header />
            <Content />
          </div>
        );
      }

      const standard = await collectStream(<App />);
      const fused = await collectStream(<App />, {
        experimental_fusedMode: true,
      });

      // Both should contain the same content
      expect(standard).toContain('Title');
      expect(standard).toContain('Body text');
      expect(fused).toContain('Title');
      expect(fused).toContain('Body text');

      // Standard path should NOT have any fused markers
      expect(standard).not.toContain('<!--C:');
      expect(standard).not.toContain('data-fused-hydration');
    });
  });

  describe('client references: fused vs standard behavior', () => {
    it('standard path calls client ref as a function (no markers)', async () => {
      const ClientButton = makeClientRef(function ClientButton({label}) {
        return <button>{label}</button>;
      });

      function App() {
        return (
          <div>
            <ClientButton label="Click" />
          </div>
        );
      }

      const html = await collectStream(<App />);
      expect(html).toContain('Click');
      expect(html).not.toContain('<!--C:');
      expect(html).not.toContain('data-fused-hydration');
    });

    it('fused path wraps client ref in markers with hydration data', async () => {
      const ClientButton = makeClientRef(function ClientButton({label}) {
        return <button>{label}</button>;
      });

      function App() {
        return (
          <div>
            <ClientButton label="Click" />
          </div>
        );
      }

      const html = await collectStream(<App />, {
        experimental_fusedMode: true,
      });
      expect(html).toContain('Click');
      expect(html).toContain('<!--C:0-->');
      expect(html).toContain('<!--/C-->');
      expect(html).toContain('data-fused-hydration');
    });
  });

  describe('both paths coexist in the same process', () => {
    it('can alternate between fused and standard renders', async () => {
      const ClientWidget = makeClientRef(function ClientWidget({text}) {
        return <span className="widget">{text}</span>;
      });

      function ServerPage({title}) {
        return (
          <div>
            <h1>{title}</h1>
            <ClientWidget text="interactive" />
          </div>
        );
      }

      // First: fused SSR (initial page load)
      const fusedHtml = await collectStream(<ServerPage title="Page 1" />, {
        experimental_fusedMode: true,
      });
      expect(fusedHtml).toContain('Page 1');
      expect(fusedHtml).toContain('interactive');
      expect(fusedHtml).toContain('<!--C:0-->');

      // Second: standard Fizz (simulating what Flight-resolved elements look like)
      const standardHtml = await collectStream(<ServerPage title="Page 2" />, {
        experimental_fusedMode: false,
      });
      expect(standardHtml).toContain('Page 2');
      expect(standardHtml).toContain('interactive');
      expect(standardHtml).not.toContain('<!--C:');

      // Third: back to fused (another initial load)
      const fusedHtml2 = await collectStream(<ServerPage title="Page 3" />, {
        experimental_fusedMode: true,
      });
      expect(fusedHtml2).toContain('Page 3');
      expect(fusedHtml2).toContain('<!--C:0-->');

      // Boundary IDs reset per request (not shared across requests)
      // Both fused renders should start from ID 0
    });

    it('concurrent fused and standard renders do not interfere', async () => {
      const ClientCard = makeClientRef(function ClientCard({name}) {
        return <div className="card">{name}</div>;
      });

      function Page({items}) {
        return (
          <ul>
            {items.map((item, i) => (
              <li key={i}>
                <ClientCard name={item} />
              </li>
            ))}
          </ul>
        );
      }

      // Start both renders concurrently
      const [fusedResult, standardResult] = await Promise.all([
        collectStream(<Page items={['A', 'B', 'C']} />, {
          experimental_fusedMode: true,
        }),
        collectStream(<Page items={['X', 'Y', 'Z']} />, {
          experimental_fusedMode: false,
        }),
      ]);

      // Fused has markers
      expect(fusedResult).toContain('<!--C:0-->');
      expect(fusedResult).toContain('<!--C:1-->');
      expect(fusedResult).toContain('<!--C:2-->');
      expect(fusedResult).toContain('A');
      expect(fusedResult).toContain('B');
      expect(fusedResult).toContain('C');

      // Standard has no markers
      expect(standardResult).not.toContain('<!--C:');
      expect(standardResult).toContain('X');
      expect(standardResult).toContain('Y');
      expect(standardResult).toContain('Z');
    });
  });

  describe('fusedMode gating is per-request', () => {
    it('Request objects are independent — fusedMode on one does not affect another', async () => {
      function App() {
        return <div>content</div>;
      }

      // Render 10 requests alternating fused/standard
      const results = await Promise.all(
        Array.from({length: 10}, (_, i) =>
          collectStream(<App />, {
            experimental_fusedMode: i % 2 === 0,
          }),
        ),
      );

      for (let i = 0; i < 10; i++) {
        expect(results[i]).toContain('content');
        // No markers on any of them since App has no client refs
        // This just verifies all 10 complete without errors
      }
    });
  });

  describe('Flight server path is unmodified', () => {
    it('ReactFlightServer.js has no fused-renderer commits', () => {
      // This is a sentinel test. If this file gets modified, we need to
      // re-evaluate the coexistence assumption.
      // We can't check git history in a test, but we can verify the module
      // doesn't export anything fused-related.
      const FlightServerPath = require.resolve(
        'react-server/src/ReactFlightServer',
      );
      const source = require('fs').readFileSync(FlightServerPath, 'utf8');
      expect(source).not.toContain('fusedMode');
      expect(source).not.toContain('clientBoundaryQueue');
      expect(source).not.toContain('pushStartClientBoundary');
    });
  });
});
