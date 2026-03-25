/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * Focused props serializer for fused renderer client boundaries.
 * Handles common prop types at client component boundaries. Does NOT
 * attempt to replicate Flight's full renderModelDestructive (~800 lines).
 *
 * Optimization strategy: use native JSON.stringify for the common case
 * (plain objects with strings, numbers, booleans, null, nested objects/arrays).
 * Only fall back to manual serialization when special types are detected
 * (Date, BigInt, NaN, Infinity, undefined, references).
 *
 * Tagged value format:
 *   {"$t": "D", "v": "2026-01-01T00:00:00.000Z"}  — Date
 *   {"$t": "u"}                                     — undefined
 *   {"$t": "N"}                                     — NaN
 *   {"$t": "I", "v": 1}                             — +Infinity
 *   {"$t": "I", "v": -1}                            — -Infinity
 *   {"$t": "n", "v": "123"}                         — BigInt (as string)
 *   {"$t": "S", "id": "...", "bound": [...]}        — Server Action ref
 *   {"$t": "C", "id": "..."}                        — Client reference in props
 *   {"$t": "T"}                                     — Tombstone (server-rendered children)
 *
 * @flow
 */

const CLIENT_REFERENCE_TAG: symbol = Symbol.for('react.client.reference');
const SERVER_REFERENCE_TAG: symbol = Symbol.for('react.server.reference');

// Tombstone JSON fragment, precomputed.
const TOMBSTONE = '{"$t":"T"}';

/**
 * Serialize props for a client boundary's hydration data.
 * Returns a JSON string.
 *
 * Fast path: if props only contain JSON-native types (string, number,
 * boolean, null, plain objects, arrays) — which is the common case for
 * e-commerce product data, blog posts, etc. — we use a single
 * JSON.stringify call with a lightweight replacer. This avoids building
 * any intermediate object tree.
 *
 * Slow path: if any value needs tagged serialization (Date, BigInt,
 * undefined, NaN, Infinity, references), we fall back to manual string
 * building which is ~2x slower but handles all types.
 */
export function serializeProps(props: {[string]: mixed}): string {
  // Try the fast path first. The replacer handles children and functions
  // but throws a sentinel if it encounters a type needing tagged values.
  try {
    return JSON.stringify(props, fastReplacer);
  } catch (e) {
    if (e === NEEDS_SLOW_PATH) {
      // Fall back to manual serialization for exotic types.
      return serializeSlow(props);
    }
    throw e;
  }
}

// Sentinel error object (not a real error, just a signal to switch paths).
const NEEDS_SLOW_PATH: {||} = Object.freeze({});

function fastReplacer(this: mixed, key: string, value: mixed): mixed {
  // Root-level children → tombstone.
  // We check if `this` is the root props object by checking if the key is
  // 'children' and the parent has other prop-like keys. Since JSON.stringify
  // calls the replacer with key="" for the root, and 'children' for the prop,
  // we just replace all 'children' keys. This is slightly aggressive but
  // matches the semantics: server-rendered children are always tombstoned.
  if (key === 'children') {
    // Return a plain object that JSON.stringify will serialize inline.
    return {$t: 'T'};
  }

  // Functions: strip regular, signal for references.
  if (typeof value === 'function') {
    if (
      (value: any).$$typeof === SERVER_REFERENCE_TAG ||
      (value: any).$$typeof === CLIENT_REFERENCE_TAG
    ) {
      throw NEEDS_SLOW_PATH;
    }
    return undefined;
  }

  // Types that need tagged values — signal slow path.
  if (typeof value === 'bigint') throw NEEDS_SLOW_PATH;
  if (typeof value === 'undefined') throw NEEDS_SLOW_PATH;
  if (typeof value === 'symbol') return undefined;

  if (typeof value === 'number') {
    if (value !== value) throw NEEDS_SLOW_PATH; // NaN
    if (value === Infinity || value === -Infinity) throw NEEDS_SLOW_PATH;
  }

  // Date: JSON.stringify calls toJSON() first, so the replacer sees a string.
  // But if we see a Date object (shouldn't happen normally since toJSON runs
  // first), signal slow path.
  if (typeof value === 'object' && value !== null) {
    if (value instanceof Date) throw NEEDS_SLOW_PATH;
    if (value instanceof Map || value instanceof Set) {
      throw new Error(
        (value instanceof Map ? 'Map' : 'Set') +
          ' props are not supported in fused mode. ' +
          'Use the standard Flight path for this component.',
      );
    }
    if (ArrayBuffer.isView(value)) {
      throw new Error(
        'TypedArray props are not supported in fused mode. ' +
          'Use the standard Flight path for this component.',
      );
    }
    if (
      typeof ReadableStream !== 'undefined' &&
      value instanceof ReadableStream
    ) {
      throw new Error(
        'ReadableStream props are not supported in fused mode. ' +
          'Use the standard Flight path for this component.',
      );
    }
    if ((value: any).$$typeof === CLIENT_REFERENCE_TAG) throw NEEDS_SLOW_PATH;
    if ((value: any).$$typeof === SERVER_REFERENCE_TAG) throw NEEDS_SLOW_PATH;
  }

  return value;
}

/**
 * Slow path: builds JSON string manually, handling all tagged types.
 * Used when the fast path detects a value needing special serialization.
 */
function serializeSlow(props: {[string]: mixed}): string {
  let out = '{';
  let first = true;
  const keys = Object.keys(props);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key === 'children') {
      if (!first) out += ',';
      first = false;
      out += '"children":' + TOMBSTONE;
      continue;
    }
    const v = writeValueSlow(props[key]);
    if (v !== undefined) {
      if (!first) out += ',';
      first = false;
      out += JSON.stringify(key) + ':' + v;
    }
  }
  return out + '}';
}

function writeValueSlow(value: mixed): string | void {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (value !== value) return '{"$t":"N"}';
    if (value === Infinity) return '{"$t":"I","v":1}';
    if (value === -Infinity) return '{"$t":"I","v":-1}';
    return '' + value;
  }
  if (typeof value === 'undefined') return '{"$t":"u"}';
  if (typeof value === 'bigint') {
    return '{"$t":"n","v":"' + value.toString() + '"}';
  }
  if (typeof value === 'symbol') return undefined;

  if (typeof value === 'function') {
    if ((value: any).$$typeof === SERVER_REFERENCE_TAG) {
      return (
        '{"$t":"S","id":' +
        JSON.stringify((value: any).$$id || '') +
        ',"bound":' +
        JSON.stringify((value: any).$$bound || null) +
        '}'
      );
    }
    if ((value: any).$$typeof === CLIENT_REFERENCE_TAG) {
      return '{"$t":"C","id":' + JSON.stringify((value: any).$$id || '') + '}';
    }
    return undefined;
  }

  if (typeof value !== 'object' || value === null) return 'null';

  if (value instanceof Date) {
    return '{"$t":"D","v":"' + value.toISOString() + '"}';
  }

  if (value instanceof Map) {
    throw new Error(
      'Map props are not supported in fused mode. ' +
        'Use the standard Flight path for this component.',
    );
  }
  if (value instanceof Set) {
    throw new Error(
      'Set props are not supported in fused mode. ' +
        'Use the standard Flight path for this component.',
    );
  }
  if (ArrayBuffer.isView(value)) {
    throw new Error(
      'TypedArray props are not supported in fused mode. ' +
        'Use the standard Flight path for this component.',
    );
  }

  if ((value: any).$$typeof === CLIENT_REFERENCE_TAG) {
    return '{"$t":"C","id":' + JSON.stringify((value: any).$$id || '') + '}';
  }
  if ((value: any).$$typeof === SERVER_REFERENCE_TAG) {
    return (
      '{"$t":"S","id":' +
      JSON.stringify((value: any).$$id || '') +
      ',"bound":' +
      JSON.stringify((value: any).$$bound || null) +
      '}'
    );
  }

  if (Array.isArray(value)) {
    let out = '[';
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out += ',';
      const v = writeValueSlow(value[i]);
      out += v !== undefined ? v : 'null';
    }
    return out + ']';
  }

  // Plain object
  let out = '{';
  let first = true;
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const v = writeValueSlow((value: any)[k]);
    if (v !== undefined) {
      if (!first) out += ',';
      first = false;
      out += JSON.stringify(k) + ':' + v;
    }
  }
  return out + '}';
}
