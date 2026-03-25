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

/**
 * Serialize props for a client boundary's hydration data.
 * Returns a JSON string. The `children` prop is replaced with a tombstone
 * marker since children are server-rendered HTML between the boundary markers.
 *
 * We pre-process the props tree to handle types that JSON.stringify can't
 * represent (Dates, undefined, NaN, Infinity, BigInt, references) and
 * then stringify the result.
 */
export function serializeProps(props: {[string]: mixed}): string {
  const processed = processObject(props, true);
  return JSON.stringify(processed);
}

function processObject(
  obj: {[string]: mixed},
  isRoot: boolean,
): {[string]: mixed} {
  const result: {[string]: mixed} = {};
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (isRoot && key === 'children') {
      result[key] = {$t: 'T'};
      continue;
    }
    const processed = serializeValue(obj[key]);
    if (processed !== undefined) {
      result[key] = processed;
    }
  }
  return result;
}

function serializeValue(value: mixed): mixed {
  // Primitives pass through JSON natively (string, number, boolean, null).
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (typeof value === 'number') {
    if (Number.isNaN(value)) {
      return {$t: 'N'};
    }
    if (!Number.isFinite(value)) {
      return {$t: 'I', v: value > 0 ? 1 : -1};
    }
    return value;
  }

  if (typeof value === 'undefined') {
    return {$t: 'u'};
  }

  if (typeof value === 'bigint') {
    return {$t: 'n', v: value.toString()};
  }

  if (value instanceof Date) {
    return {$t: 'D', v: value.toISOString()};
  }

  // Server Action references (functions with $$typeof === SERVER_REFERENCE_TAG)
  if (typeof value === 'function') {
    if ((value: any).$$typeof === SERVER_REFERENCE_TAG) {
      return {
        $t: 'S',
        id: (value: any).$$id || '',
        bound: (value: any).$$bound || null,
      };
    }
    if ((value: any).$$typeof === CLIENT_REFERENCE_TAG) {
      return {
        $t: 'C',
        id: (value: any).$$id || '',
      };
    }
    // Regular functions can't be serialized — skip them.
    return undefined;
  }

  // Client references passed as props (e.g., component passed as prop)
  if (
    typeof value === 'object' &&
    value !== null &&
    (value: any).$$typeof === CLIENT_REFERENCE_TAG
  ) {
    return {
      $t: 'C',
      id: (value: any).$$id || '',
    };
  }

  // Server references as objects
  if (
    typeof value === 'object' &&
    value !== null &&
    (value: any).$$typeof === SERVER_REFERENCE_TAG
  ) {
    return {
      $t: 'S',
      id: (value: any).$$id || '',
      bound: (value: any).$$bound || null,
    };
  }

  // Arrays — recurse
  if (Array.isArray(value)) {
    const result = [];
    for (let i = 0; i < value.length; i++) {
      result.push(serializeValue(value[i]));
    }
    return result;
  }

  // Unsupported types — throw clear error
  if (
    typeof ReadableStream !== 'undefined' &&
    value instanceof ReadableStream
  ) {
    throw new Error(
      'ReadableStream props are not supported in fused mode. ' +
        'Use the standard Flight path for this component.',
    );
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

  // Plain objects — recurse via processObject
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      return processObject((value: any), false);
    }
    // Unknown object type — try to serialize as plain object
    return processObject((value: any), false);
  }

  // Symbols can't be serialized
  if (typeof value === 'symbol') {
    return undefined;
  }

  return value;
}
