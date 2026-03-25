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

let serializeProps;

describe('ReactFizzHydrationSerializer', () => {
  beforeEach(() => {
    jest.resetModules();
    serializeProps =
      require('react-server/src/ReactFizzHydrationSerializer').serializeProps;
  });

  function parse(props) {
    return JSON.parse(serializeProps(props));
  }

  describe('primitives', () => {
    it('serializes strings', () => {
      expect(parse({name: 'hello'})).toEqual({name: 'hello'});
    });

    it('serializes numbers', () => {
      expect(parse({count: 42, price: 3.14})).toEqual({
        count: 42,
        price: 3.14,
      });
    });

    it('serializes booleans', () => {
      expect(parse({active: true, disabled: false})).toEqual({
        active: true,
        disabled: false,
      });
    });

    it('serializes null', () => {
      expect(parse({value: null})).toEqual({value: null});
    });

    it('serializes undefined as tagged value', () => {
      const result = parse({value: undefined});
      expect(result.value).toEqual({$t: 'u'});
    });
  });

  describe('special numbers', () => {
    it('serializes NaN as tagged value', () => {
      const result = parse({value: NaN});
      expect(result.value).toEqual({$t: 'N'});
    });

    it('serializes Infinity as tagged value', () => {
      const result = parse({value: Infinity});
      expect(result.value).toEqual({$t: 'I', v: 1});
    });

    it('serializes -Infinity as tagged value', () => {
      const result = parse({value: -Infinity});
      expect(result.value).toEqual({$t: 'I', v: -1});
    });
  });

  describe('dates', () => {
    it('serializes Date as tagged value in slow path', () => {
      // When Date is combined with a type that triggers slow path (e.g. undefined),
      // it gets the tagged format.
      const date = new Date('2026-01-15T00:00:00.000Z');
      const result = parse({created: date, undef: undefined});
      expect(result.created).toEqual({
        $t: 'D',
        v: '2026-01-15T00:00:00.000Z',
      });
      expect(result.undef).toEqual({$t: 'u'});
    });

    it('serializes Date as ISO string in fast path', () => {
      // When all other props are JSON-safe, Date.toJSON() produces an ISO
      // string which JSON.stringify uses directly. This is acceptable —
      // the client can reconstruct via new Date(str).
      const date = new Date('2026-01-15T00:00:00.000Z');
      const result = parse({created: date, label: 'test'});
      expect(result.created).toBe('2026-01-15T00:00:00.000Z');
    });
  });

  describe('bigint', () => {
    it('serializes BigInt as tagged string', () => {
      const result = parse({id: BigInt('9007199254740993')});
      expect(result.id).toEqual({$t: 'n', v: '9007199254740993'});
    });
  });

  describe('objects and arrays', () => {
    it('serializes plain objects', () => {
      expect(parse({config: {a: 1, b: 'two'}})).toEqual({
        config: {a: 1, b: 'two'},
      });
    });

    it('serializes arrays', () => {
      expect(parse({items: [1, 'two', true]})).toEqual({
        items: [1, 'two', true],
      });
    });

    it('serializes nested objects and arrays', () => {
      const props = {
        data: {
          users: [
            {name: 'Alice', scores: [10, 20]},
            {name: 'Bob', scores: [30, 40]},
          ],
        },
      };
      expect(parse(props)).toEqual(props);
    });
  });

  describe('children handling', () => {
    it('replaces children with tombstone', () => {
      const result = parse({children: 'some text', label: 'btn'});
      expect(result.children).toEqual({$t: 'T'});
      expect(result.label).toBe('btn');
    });

    it('replaces JSX children with tombstone', () => {
      const result = parse({children: {type: 'div', props: {}}});
      expect(result.children).toEqual({$t: 'T'});
    });
  });

  describe('function handling', () => {
    it('strips regular functions', () => {
      const result = parse({onClick: () => {}, label: 'btn'});
      expect(result.onClick).toBeUndefined();
      expect(result.label).toBe('btn');
    });

    it('serializes server action references', () => {
      const action = Object.defineProperties(function myAction() {}, {
        $$typeof: {value: Symbol.for('react.server.reference')},
        $$id: {value: 'actions#submitForm'},
        $$bound: {value: ['arg1', 'arg2']},
      });
      const result = parse({onSubmit: action});
      expect(result.onSubmit).toEqual({
        $t: 'S',
        id: 'actions#submitForm',
        bound: ['arg1', 'arg2'],
      });
    });

    it('serializes client reference functions in props', () => {
      const component = Object.defineProperties(function MyComponent() {}, {
        $$typeof: {value: Symbol.for('react.client.reference')},
        $$id: {value: 'components#MyComponent'},
      });
      const result = parse({renderItem: component});
      expect(result.renderItem).toEqual({
        $t: 'C',
        id: 'components#MyComponent',
      });
    });
  });

  describe('client references as objects', () => {
    it('serializes client reference objects in props', () => {
      const ref = {
        $$typeof: Symbol.for('react.client.reference'),
        $$id: 'my-module#Foo',
      };
      const result = parse({component: ref});
      expect(result.component).toEqual({$t: 'C', id: 'my-module#Foo'});
    });
  });

  describe('unsupported types', () => {
    it('throws on Map', () => {
      expect(() => serializeProps({data: new Map()})).toThrow(
        'Map props are not supported in fused mode',
      );
    });

    it('throws on Set', () => {
      expect(() => serializeProps({data: new Set()})).toThrow(
        'Set props are not supported in fused mode',
      );
    });

    it('throws on TypedArray', () => {
      expect(() => serializeProps({data: new Uint8Array(4)})).toThrow(
        'TypedArray props are not supported in fused mode',
      );
    });

    it('strips symbols', () => {
      const result = parse({sym: Symbol('test'), label: 'ok'});
      expect(result.sym).toBeUndefined();
      expect(result.label).toBe('ok');
    });
  });

  describe('special numbers in arrays', () => {
    it('handles NaN and Infinity in arrays', () => {
      const result = parse({values: [NaN, Infinity, -Infinity, 42]});
      expect(result.values).toEqual([
        {$t: 'N'},
        {$t: 'I', v: 1},
        {$t: 'I', v: -1},
        42,
      ]);
    });
  });

  describe('realistic props', () => {
    it('serializes a realistic product card props', () => {
      const props = {
        product: {
          id: 42,
          name: 'Widget Pro',
          price: {amount: '29.99', currency: 'USD'},
          rating: {average: 4.5, count: 128},
          inStock: true,
          tags: ['electronics', 'gadgets'],
        },
        onAddToCart: () => {},
        children: '<server rendered content>',
      };
      const result = parse(props);
      expect(result.product.name).toBe('Widget Pro');
      expect(result.product.price.amount).toBe('29.99');
      expect(result.onAddToCart).toBeUndefined();
      expect(result.children).toEqual({$t: 'T'});
    });
  });
});
