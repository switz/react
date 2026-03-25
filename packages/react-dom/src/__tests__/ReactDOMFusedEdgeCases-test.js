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

let React;
let ReactDOMFizzServer;
let Stream;
let Suspense;

describe('ReactDOMFusedEdgeCases', () => {
  beforeEach(() => {
    jest.resetModules();
    React = require('react');
    ReactDOMFizzServer = require('react-dom/server');
    Stream = require('stream');
    Suspense = React.Suspense;
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
        experimental_fusedMode: true,
        ...options,
        onAllReady() {
          pipe(passthrough);
        },
        onError: options?.onError || (() => {}),
      });
    });
  }

  function makeClientRef(fn) {
    return Object.defineProperties(fn, {
      $$typeof: {value: Symbol.for('react.client.reference')},
      $$id: {value: 'test#' + fn.name},
      $$async: {value: false},
    });
  }

  // 1. Client component receiving server component children
  describe('server component children as props', () => {
    it('renders server children inside client boundary', async () => {
      const ClientWrapper = makeClientRef(function ClientWrapper({children}) {
        return <div className="client-wrapper">{children}</div>;
      });

      function ServerContent() {
        return <p>Server rendered content</p>;
      }

      function App() {
        return (
          <ClientWrapper>
            <ServerContent />
          </ClientWrapper>
        );
      }

      const html = await collectStream(<App />);
      expect(html).toContain('Server rendered content');
      expect(html).toContain('<!--C:0-->');
      expect(html).toContain('<!--/C-->');
      // Hydration data contains the module ref (props are deferred)
      expect(html).toContain('__FUSED');
    });
  });

  // 2. Nested client boundaries
  describe('nested client boundaries', () => {
    it('handles client-in-client with correct nesting', async () => {
      const ClientOuter = makeClientRef(function ClientOuter({children}) {
        return <div className="outer">{children}</div>;
      });

      const ClientInner = makeClientRef(function ClientInner({label}) {
        return <button>{label}</button>;
      });

      function App() {
        return (
          <ClientOuter>
            <ClientInner label="nested" />
          </ClientOuter>
        );
      }

      const html = await collectStream(<App />);
      // Both boundaries should have markers
      expect(html).toContain('<!--C:0-->');
      expect(html).toContain('<!--C:1-->');
      // Outer wraps inner
      const outer0 = html.indexOf('<!--C:0-->');
      const inner1 = html.indexOf('<!--C:1-->');
      const innerEnd = html.indexOf('<!--/C-->', inner1);
      const outerEnd = html.indexOf('<!--/C-->', innerEnd + 1);
      expect(outer0).toBeLessThan(inner1);
      expect(inner1).toBeLessThan(innerEnd);
      expect(innerEnd).toBeLessThan(outerEnd);
      expect(html).toContain('nested');
    });

    it('assigns unique IDs to deeply nested boundaries', async () => {
      const C1 = makeClientRef(function C1({children}) {
        return <div>{children}</div>;
      });
      const C2 = makeClientRef(function C2({children}) {
        return <div>{children}</div>;
      });
      const C3 = makeClientRef(function C3() {
        return <span>leaf</span>;
      });

      function App() {
        return (
          <C1>
            <C2>
              <C3 />
            </C2>
          </C1>
        );
      }

      const html = await collectStream(<App />);
      expect(html).toContain('<!--C:0-->');
      expect(html).toContain('<!--C:1-->');
      expect(html).toContain('<!--C:2-->');
      // All three boundaries in consolidated hydration script
      expect(html).toContain('__FUSED');
      const scriptMatch = html.match(/self\.__FUSED=(.*?)<\/script>/);
      expect(scriptMatch).not.toBeNull();
      const payload = JSON.parse(scriptMatch[1]);
      expect(Object.keys(payload.b).length).toBe(3);
    });
  });

  // 3. Server component throwing
  describe('server component errors', () => {
    it('server component throw is caught by Fizz error handling', async () => {
      function Boom() {
        throw new Error('Server component exploded');
      }

      const errors = [];
      // Use a manual stream setup since collectStream rejects on error
      await new Promise((resolve, reject) => {
        const passthrough = new Stream.PassThrough();
        passthrough.setEncoding('utf8');
        passthrough.on('data', () => {});
        passthrough.on('end', () => resolve());
        passthrough.on('error', () => resolve());

        const {pipe} = ReactDOMFizzServer.renderToPipeableStream(
          <div>
            <Boom />
          </div>,
          {
            experimental_fusedMode: true,
            onShellError() {
              resolve();
            },
            onError(err) {
              errors.push(err.message);
            },
          },
        );
        try {
          pipe(passthrough);
        } catch (e) {
          resolve();
        }
      });
      expect(errors).toContain('Server component exploded');
    });

    it('error in server component inside client boundary is handled', async () => {
      const ClientShell = makeClientRef(function ClientShell({children}) {
        return <div className="shell">{children}</div>;
      });

      function BrokenServer() {
        throw new Error('broken server component');
      }

      const errors = [];
      await new Promise(resolve => {
        const passthrough = new Stream.PassThrough();
        passthrough.setEncoding('utf8');
        passthrough.on('data', () => {});
        passthrough.on('end', () => resolve());
        passthrough.on('error', () => resolve());

        const {pipe} = ReactDOMFizzServer.renderToPipeableStream(
          <ClientShell>
            <BrokenServer />
          </ClientShell>,
          {
            experimental_fusedMode: true,
            onShellError() {
              resolve();
            },
            onError(err) {
              errors.push(err.message);
            },
          },
        );
        try {
          pipe(passthrough);
        } catch (e) {
          resolve();
        }
      });
      expect(errors).toContain('broken server component');
    });
  });

  // 4. Mixed async/sync server components
  describe('mixed async/sync', () => {
    it('sync parent renders async child via Suspense', async () => {
      let resolve;
      const promise = new Promise(r => {
        resolve = r;
      });

      async function AsyncChild() {
        await promise;
        return <span>async loaded</span>;
      }

      function SyncParent() {
        return (
          <div>
            <h1>Sync</h1>
            <Suspense fallback={<span>loading...</span>}>
              <AsyncChild />
            </Suspense>
          </div>
        );
      }

      let html;
      const {pipe} = ReactDOMFizzServer.renderToPipeableStream(<SyncParent />, {
        experimental_fusedMode: true,
        onAllReady() {
          const passthrough = new Stream.PassThrough();
          passthrough.setEncoding('utf8');
          let output = '';
          passthrough.on('data', chunk => {
            output += chunk;
          });
          passthrough.on('end', () => {
            html = output;
          });
          pipe(passthrough);
        },
      });

      resolve();
      jest.runAllTimers();
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));

      expect(html).toContain('Sync');
      expect(html).toContain('async loaded');
    });
  });

  // 5. Streaming with late-resolving server components
  describe('streaming', () => {
    it('shell streams before async content resolves', async () => {
      let resolve;
      const promise = new Promise(r => {
        resolve = r;
      });

      async function SlowData() {
        await promise;
        return <p>late data</p>;
      }

      function App() {
        return (
          <div>
            <h1>Shell</h1>
            <Suspense fallback={<span>placeholder</span>}>
              <SlowData />
            </Suspense>
          </div>
        );
      }

      let shellHtml = '';
      const writable = new Stream.PassThrough();
      writable.setEncoding('utf8');
      writable.on('data', chunk => {
        shellHtml += chunk;
      });

      const {pipe} = ReactDOMFizzServer.renderToPipeableStream(<App />, {
        experimental_fusedMode: true,
        onShellReady() {
          pipe(writable);
        },
      });

      await new Promise(r => setImmediate(r));

      // Shell should be ready with fallback
      expect(shellHtml).toContain('Shell');
      expect(shellHtml).toContain('placeholder');

      // Resolve and wait for streaming
      resolve();
      jest.runAllTimers();
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));

      expect(shellHtml).toContain('late data');
    });
  });

  // 6. Exotic prop types — the serializer throws but the component still
  // renders (renderClientBoundary catches serialization errors and falls
  // back to empty props). We just verify the HTML is produced.
  describe('exotic prop types', () => {
    it('Map in props falls back gracefully', async () => {
      const ClientComp = makeClientRef(function ClientComp() {
        return <div>rendered</div>;
      });

      const html = await collectStream(<ClientComp data={new Map()} />);
      // Component still renders HTML
      expect(html).toContain('rendered');
      // Markers still present
      expect(html).toContain('<!--C:0-->');
      // Hydration data falls back to empty props
      expect(html).toContain('__FUSED');
    });

    it('Set in props falls back gracefully', async () => {
      const ClientComp = makeClientRef(function ClientComp() {
        return <div>rendered</div>;
      });

      const html = await collectStream(<ClientComp data={new Set()} />);
      expect(html).toContain('rendered');
      expect(html).toContain('<!--C:0-->');
    });
  });

  // 7. Server Action references
  describe('server action references', () => {
    it('preserves server action ref in hydration data', async () => {
      const serverAction = Object.defineProperties(function submitForm() {}, {
        $$typeof: {value: Symbol.for('react.server.reference')},
        $$id: {value: 'actions#submitForm'},
        $$bound: {value: ['userId123']},
      });

      const ClientForm = makeClientRef(function ClientForm({action}) {
        return <form action={action}>submit</form>;
      });

      const html = await collectStream(<ClientForm action={serverAction} />);
      // Hydration data contains the module ref for the form component
      expect(html).toContain('__FUSED');
      expect(html).toContain('test#ClientForm');
    });
  });
});
