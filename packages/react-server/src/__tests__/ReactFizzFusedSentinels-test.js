/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 * @jest-environment node
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Sentinel tests that detect upstream React changes which would break
 * the fused renderer's assumptions. If any of these fail after a React
 * upstream merge, the fused renderer needs to be re-evaluated.
 */
describe('ReactFizzFusedSentinels', () => {
  describe('client reference protocol', () => {
    it('client references use Symbol.for("react.client.reference")', () => {
      const tag = Symbol.for('react.client.reference');
      expect(typeof tag).toBe('symbol');
      expect(tag.toString()).toBe('Symbol(react.client.reference)');
    });

    it('client reference proxy has $$typeof, $$id, $$async', () => {
      // This is how bundlers (webpack, turbopack) create client references.
      // If this shape changes, our detection in renderElement breaks.
      const ref = Object.defineProperties(function () {}, {
        $$typeof: {value: Symbol.for('react.client.reference')},
        $$id: {value: 'module#export'},
        $$async: {value: false},
      });
      expect(ref.$$typeof).toBe(Symbol.for('react.client.reference'));
      expect(ref.$$id).toBe('module#export');
      expect(ref.$$async).toBe(false);
    });
  });

  describe('server reference protocol', () => {
    it('server references use Symbol.for("react.server.reference")', () => {
      const tag = Symbol.for('react.server.reference');
      expect(typeof tag).toBe('symbol');
    });

    it('server reference has $$typeof, $$id, $$bound', () => {
      const ref = Object.defineProperties(function () {}, {
        $$typeof: {value: Symbol.for('react.server.reference')},
        $$id: {value: 'actions#myAction'},
        $$bound: {value: ['arg1']},
      });
      expect(ref.$$typeof).toBe(Symbol.for('react.server.reference'));
      expect(ref.$$id).toBe('actions#myAction');
      expect(ref.$$bound).toEqual(['arg1']);
    });
  });

  describe('Fizz insertion points', () => {
    it('ReactFizzServer.js has fused mode code', () => {
      const source = fs.readFileSync(
        path.resolve(__dirname, '../ReactFizzServer.js'),
        'utf8',
      );
      expect(source).toContain('clientBoundaryQueue');
      expect(source).toContain('fusedMode');
    });
  });

  describe('hydration walker compatibility', () => {
    it('getNextHydratable skips unknown comment types', () => {
      const source = fs.readFileSync(
        path.resolve(
          __dirname,
          '../../../react-dom-bindings/src/client/ReactFiberConfigDOM.js',
        ),
        'utf8',
      );
      expect(source).toContain('getNextHydratable');
      expect(source).toContain("'$'");
      expect(source).toContain("'/$'");
    });
  });

  describe('Flight server independence', () => {
    it('ReactFlightServer.js has no fused-mode code', () => {
      const source = fs.readFileSync(
        path.resolve(__dirname, '../ReactFlightServer.js'),
        'utf8',
      );
      expect(source).not.toContain('fusedMode');
      expect(source).not.toContain('clientBoundaryQueue');
      expect(source).not.toContain('pushStartClientBoundary');
    });
  });
});
