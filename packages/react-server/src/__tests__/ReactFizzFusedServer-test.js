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

let buffer = '';
let hasErrored = false;
let fatalError = undefined;
let writable;

describe('ReactFizzFusedServer', () => {
  beforeEach(() => {
    jest.resetModules();
    React = require('react');
    ReactDOMFizzServer = require('react-dom/server');
    Stream = require('stream');
    Suspense = React.Suspense;

    buffer = '';
    hasErrored = false;
    fatalError = undefined;
    writable = new Stream.PassThrough();
    writable.setEncoding('utf8');
    writable.on('data', chunk => {
      buffer += chunk;
    });
    writable.on('error', error => {
      hasErrored = true;
      fatalError = error;
    });
  });

  async function act(callback) {
    await callback();
    // Await one turn around the event loop.
    await new Promise(resolve => {
      setImmediate(resolve);
    });
    if (hasErrored) {
      throw fatalError;
    }
  }

  async function waitForAll() {
    // Flush all timers and microtasks
    jest.runAllTimers();
    await new Promise(resolve => setImmediate(resolve));
  }

  function getOutput() {
    return buffer;
  }

  // Helper: render and collect full HTML output
  async function renderToString(jsx, options) {
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

  describe('fusedMode: false (default)', () => {
    it('renders a normal function component unchanged', async () => {
      function App() {
        return <div>Hello World</div>;
      }

      const html = await renderToString(<App />);
      expect(html).toContain('Hello World');
    });

    it('does not treat function components differently without fusedMode', async () => {
      // A function that looks like a server component (plain function)
      // should render normally when fusedMode is not enabled.
      function ServerComponent() {
        return <span>server content</span>;
      }

      function App() {
        return (
          <div>
            <ServerComponent />
          </div>
        );
      }

      const html = await renderToString(<App />);
      expect(html).toContain('server content');
    });
  });

  describe('fusedMode: true', () => {
    it('renders a sync server component to correct HTML', async () => {
      function ServerHeader() {
        return <h1>Server Rendered Header</h1>;
      }

      function ServerContent() {
        return <p>Content from server component</p>;
      }

      function App() {
        return (
          <div>
            <ServerHeader />
            <ServerContent />
          </div>
        );
      }

      const html = await renderToString(<App />, {
        experimental_fusedMode: true,
      });
      expect(html).toContain('Server Rendered Header');
      expect(html).toContain('Content from server component');
    });

    it('renders nested server components', async () => {
      function Inner() {
        return <span>inner</span>;
      }

      function Middle() {
        return (
          <div>
            <Inner />
          </div>
        );
      }

      function Outer() {
        return (
          <section>
            <Middle />
          </section>
        );
      }

      const html = await renderToString(<Outer />, {
        experimental_fusedMode: true,
      });
      expect(html).toContain('<section>');
      expect(html).toContain('<span>inner</span>');
    });

    it('passes props through to server components', async () => {
      function Greeting({name, count}) {
        return (
          <div>
            Hello {name}, you have {count} items
          </div>
        );
      }

      const html = await renderToString(<Greeting name="World" count={42} />, {
        experimental_fusedMode: true,
      });
      // Fizz inserts comment nodes between text nodes
      expect(html).toContain('Hello');
      expect(html).toContain('World');
      expect(html).toContain('42');
      expect(html).toContain('items');
    });

    it('renders async server components via Suspense', async () => {
      let resolve;
      const promise = new Promise(r => {
        resolve = r;
      });

      async function AsyncComponent() {
        await promise;
        return <div>async content loaded</div>;
      }

      function App() {
        return (
          <Suspense fallback={<span>Loading...</span>}>
            <AsyncComponent />
          </Suspense>
        );
      }

      let html;
      const {pipe} = ReactDOMFizzServer.renderToPipeableStream(<App />, {
        experimental_fusedMode: true,
        onAllReady() {
          // Collect output after everything resolves
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

      // Resolve the async component
      resolve();
      await waitForAll();
      await new Promise(resolve => setImmediate(resolve));

      expect(html).toContain('async content loaded');
    });

    it('streams shell immediately while async components resolve', async () => {
      let resolve;
      const promise = new Promise(r => {
        resolve = r;
      });

      async function SlowComponent() {
        await promise;
        return <div>slow content</div>;
      }

      function App() {
        return (
          <div>
            <h1>Shell</h1>
            <Suspense fallback={<span>Loading...</span>}>
              <SlowComponent />
            </Suspense>
          </div>
        );
      }

      const {pipe} = ReactDOMFizzServer.renderToPipeableStream(<App />, {
        experimental_fusedMode: true,
        onShellReady() {
          pipe(writable);
        },
      });

      // After shell is ready, the fallback should be in the output
      await new Promise(resolve => setImmediate(resolve));
      expect(getOutput()).toContain('Shell');
      expect(getOutput()).toContain('Loading...');

      // Resolve the slow component
      resolve();
      await waitForAll();
      await new Promise(resolve => setImmediate(resolve));

      // Now the slow content should be streamed
      expect(getOutput()).toContain('slow content');
    });

    it('handles server component that returns null', async () => {
      function NullComponent() {
        return null;
      }

      function App() {
        return (
          <div>
            <NullComponent />
            <span>after null</span>
          </div>
        );
      }

      const html = await renderToString(<App />, {
        experimental_fusedMode: true,
      });
      expect(html).toContain('after null');
    });

    it('handles server component that returns a fragment', async () => {
      function MultiReturn() {
        return (
          <>
            <li>one</li>
            <li>two</li>
            <li>three</li>
          </>
        );
      }

      function App() {
        return (
          <ul>
            <MultiReturn />
          </ul>
        );
      }

      const html = await renderToString(<App />, {
        experimental_fusedMode: true,
      });
      expect(html).toContain('<li>one</li>');
      expect(html).toContain('<li>two</li>');
      expect(html).toContain('<li>three</li>');
    });

    it('wraps client reference in boundary markers', async () => {
      const ClientComponent = Object.defineProperties(
        function ClientComponent({label}) {
          return <button>{label}</button>;
        },
        {
          $$typeof: {value: Symbol.for('react.client.reference')},
          $$id: {value: 'test-module#ClientComponent'},
          $$async: {value: false},
        },
      );

      function App() {
        return (
          <div>
            <ClientComponent label="Click me" />
          </div>
        );
      }

      const html = await renderToString(<App />, {
        experimental_fusedMode: true,
      });
      // Should still render the HTML
      expect(html).toContain('Click me');
      // Should have boundary markers
      expect(html).toContain('<!--C:0-->');
      expect(html).toContain('<!--/C-->');
      // Markers should wrap the button
      const startIdx = html.indexOf('<!--C:0-->');
      const buttonIdx = html.indexOf('<button>');
      const endIdx = html.indexOf('<!--/C-->');
      expect(startIdx).toBeLessThan(buttonIdx);
      expect(buttonIdx).toBeLessThan(endIdx);
    });

    it('emits consolidated hydration script for client boundaries', async () => {
      const ClientComponent = Object.defineProperties(
        function ClientComponent({label}) {
          return <button>{label}</button>;
        },
        {
          $$typeof: {value: Symbol.for('react.client.reference')},
          $$id: {value: 'my-module#default'},
          $$async: {value: false},
        },
      );

      function App() {
        return (
          <div>
            <ClientComponent label="Click me" />
          </div>
        );
      }

      const html = await renderToString(<App />, {
        experimental_fusedMode: true,
      });
      // Should contain a consolidated hydration script with module ref
      expect(html).toContain('__FUSED');
      expect(html).toContain('my-module#default');
    });

    it('assigns unique IDs to multiple client boundaries', async () => {
      const ClientA = Object.defineProperties(
        function ClientA() {
          return <span>A</span>;
        },
        {
          $$typeof: {value: Symbol.for('react.client.reference')},
          $$id: {value: 'module-a#A'},
          $$async: {value: false},
        },
      );

      const ClientB = Object.defineProperties(
        function ClientB() {
          return <span>B</span>;
        },
        {
          $$typeof: {value: Symbol.for('react.client.reference')},
          $$id: {value: 'module-b#B'},
          $$async: {value: false},
        },
      );

      function App() {
        return (
          <div>
            <ClientA />
            <ClientB />
          </div>
        );
      }

      const html = await renderToString(<App />, {
        experimental_fusedMode: true,
      });
      expect(html).toContain('<!--C:0-->');
      expect(html).toContain('<!--C:1-->');
      // Two hydration scripts
      // Consolidated hydration script contains both module refs
      expect(html).toContain('__FUSED');
      expect(html).toContain('module-a#A');
      expect(html).toContain('module-b#B');
    });

    it('handles nested server-in-client-in-server', async () => {
      function ServerOuter() {
        return (
          <section>
            <h1>Server Outer</h1>
            <ClientMiddle />
          </section>
        );
      }

      const ClientMiddle = Object.defineProperties(
        function ClientMiddle() {
          return (
            <div className="client">
              <ServerInner />
            </div>
          );
        },
        {
          $$typeof: {value: Symbol.for('react.client.reference')},
          $$id: {value: 'client-middle#default'},
          $$async: {value: false},
        },
      );

      function ServerInner() {
        return <p>Server Inner Content</p>;
      }

      const html = await renderToString(<ServerOuter />, {
        experimental_fusedMode: true,
      });
      expect(html).toContain('Server Outer');
      expect(html).toContain('Server Inner Content');
      // Client boundary should wrap the ClientMiddle output
      expect(html).toContain('<!--C:0-->');
      expect(html).toContain('<!--/C-->');
      // The inner server content should be INSIDE the markers
      const startIdx = html.indexOf('<!--C:0-->');
      const innerIdx = html.indexOf('Server Inner Content');
      const endIdx = html.indexOf('<!--/C-->');
      expect(startIdx).toBeLessThan(innerIdx);
      expect(innerIdx).toBeLessThan(endIdx);
    });

    it('emits module ref in consolidated hydration data (props deferred)', async () => {
      const ClientComponent = Object.defineProperties(
        function ClientComponent({title, count, active}) {
          return (
            <div>
              {title} - {count} - {active ? 'yes' : 'no'}
            </div>
          );
        },
        {
          $$typeof: {value: Symbol.for('react.client.reference')},
          $$id: {value: 'props-test#default'},
          $$async: {value: false},
        },
      );

      const html = await renderToString(
        <ClientComponent title="Hello" count={42} active={true} />,
        {experimental_fusedMode: true},
      );
      // Consolidated hydration script contains module ref
      expect(html).toContain('__FUSED');
      expect(html).toContain('props-test#default');
      // HTML still contains rendered content
      expect(html).toContain('Hello');
      expect(html).toContain('42');
    });

    it('does not emit markers or hydration data when fusedMode is false', async () => {
      const ClientComponent = Object.defineProperties(
        function ClientComponent({label}) {
          return <button>{label}</button>;
        },
        {
          $$typeof: {value: Symbol.for('react.client.reference')},
          $$id: {value: 'test-module#ClientComponent'},
          $$async: {value: false},
        },
      );

      function App() {
        return (
          <div>
            <ClientComponent label="Click me" />
          </div>
        );
      }

      const html = await renderToString(<App />);
      expect(html).toContain('Click me');
      // No markers
      expect(html).not.toContain('<!--C:');
      expect(html).not.toContain('<!--/C-->');
      // No hydration scripts
      expect(html).not.toContain('__FUSED');
    });
  });
});
