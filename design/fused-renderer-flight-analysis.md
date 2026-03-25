# Flight Wire Format and Client Boundary Detection Analysis

Analysis of `packages/react-server/src/ReactFlightServer.js` and
`packages/react-server-dom-webpack/src/` to understand how Flight identifies
server vs client components and serializes them over the wire.

## 1. How Flight Detects Client Components

### The `isClientReference()` check

Location: `packages/react-server-dom-webpack/src/ReactFlightWebpackReferences.js:29`

```js
const CLIENT_REFERENCE_TAG = Symbol.for('react.client.reference');

export function isClientReference(reference: Object): boolean {
  return reference.$$typeof === CLIENT_REFERENCE_TAG;
}
```

A client component is any function/object whose `$$typeof` property is
`Symbol.for('react.client.reference')`. This is set by the bundler at build
time via `registerClientReference()`.

### Client Reference Shape

```js
type ClientReference<T> = {
  $$typeof: Symbol('react.client.reference'),
  $$id: string,      // e.g. "src/components/Button.tsx#default" or "src/components/Button.tsx#Button"
  $$async: boolean,   // true if the module is async (dynamic import)
};
```

The `$$id` encodes `modulePath#exportName`. The bundler plugin creates these
proxy objects for every export from a `'use client'` module.

### Server Reference Shape (for Server Actions)

```js
type ServerReference<T> = T & {
  $$typeof: Symbol('react.server.reference'),
  $$id: string,       // action identifier
  $$bound: null | Array<ReactClientValue>,  // bound closure args
};
```

### How Flight dispatches in `renderElement()`

Location: `ReactFlightServer.js:2179`

```
if (typeof type === 'function' && !isClientReference(type))
  → Server Component: call renderFunctionComponent() — executes the function
else if (type === REACT_FRAGMENT_TYPE && key === null)
  → Fragment: render children directly
else if (typeof type === 'object' && !isClientReference(type))
  → Object types: Lazy, ForwardRef, Memo — unwrap and recurse
else if (typeof type === 'string')
  → Host element (div, span): pass through to client
else
  → Client element: call renderClientElement() — serialize module reference
```

**Key: the check is `isClientReference(type)`.** If `type` has `$$typeof ===
CLIENT_REFERENCE_TAG`, Flight does NOT call the function. It serializes a module
reference instead.

## 2. Flight Wire Format

### Row format

Every Flight chunk is a row:
```
<id-hex>:<tag><json>\n
```

Where `<id-hex>` is the chunk ID in hexadecimal, `<tag>` is a single character,
and `<json>` is the serialized payload.

### Chunk types (tags)

| Tag | Name | Content | Example |
|-----|------|---------|---------|
| (none) | Model | JSON value (the tree) | `0:["$","div",null,{"children":"Hello"}]\n` |
| `I` | Import | Module reference metadata | `1:I["src/Button.js",["chunk-abc.js"],"Button"]\n` |
| `E` | Error | Error info | `2:E{"digest":"abc","message":"..."}\n` |
| `H` | Hint | Resource hint (preload) | `:HL["stylesheet","styles.css"]\n` |
| `D` | Debug | Debug info (DEV only) | `3:D{"name":"App","env":"Server"}\n` |
| `S` | Symbol | Well-known symbol ref | `4:S"react.fragment"\n` |
| `P` | Postpone | Postponed marker | `5:P{}\n` |
| `T` | Text | String value | `6:T"hello world"\n` |
| `B` | Blob/Binary | Binary data | `7:B<binary>\n` |

### Model chunk format (the tree)

React elements are serialized as tuples:
```
[REACT_ELEMENT_TYPE, type, key, props]
```

Where `type` is either:
- A string (`"div"`, `"span"`) for host elements
- A reference to an import chunk (`"$L1"`) for client components
- Other React types (fragments, context, etc.)

### Import chunk format

When Flight encounters a client component, it emits an Import chunk:
```
<id>:I<json>\n
```

The JSON payload is `ClientReferenceMetadata`:
```js
type ImportMetadata =
  | [id: string, chunks: Array<string>, name: string, async: 1]
  | [id: string, chunks: Array<string>, name: string];
```

- `id`: The module ID in the bundler (e.g., webpack module ID)
- `chunks`: Array of chunk ID / filename pairs (double-indexed: `[chunkId, filename, chunkId, filename, ...]`)
- `name`: The export name (e.g., `"default"`, `"Button"`)
- `async`: Present as `1` if the module is async

### Example: A page with a client component

```jsx
// Server Component
function Page() {
  return <Layout><ClientButton label="Click" /></Layout>;
}
```

Flight output:
```
1:I["./src/ClientButton.tsx",["client-chunk-abc.js","client-chunk-abc.js"],"default"]
0:["$","div",null,{"className":"layout","children":["$","$L1",null,{"label":"Click"}]}]
```

Breakdown:
- Row `1:I[...]` — registers the client module reference (chunk URL + export)
- Row `0:[...]` — the tree model. `"$L1"` is a lazy reference to chunk 1 (the client component)
- The client component's props (`{"label":"Click"}`) are serialized inline in the model

## 3. Props Serialization at Client Boundaries

When Flight serializes a client element via `renderClientElement()`:

```js
function renderClientElement(request, task, type, key, props, validated) {
  // ... key path handling ...
  const element = [REACT_ELEMENT_TYPE, type, key, props];
  return element;
}
```

The `type` at this point is already a reference to an Import chunk (via
`serializeClientReference()`). The `props` are serialized through the normal
model serialization (`renderModelDestructive` → `stringify`).

**Props serialization handles:**
- Primitives (string, number, boolean, null, undefined)
- Arrays and plain objects (recursive serialization)
- Dates → `"$D<iso-string>"`
- BigInt → `"$n<string>"`
- Symbols → reference to Symbol chunk
- React elements in props → recursive (client elements become references)
- Server components in props → **executed and resolved before serialization**
- Thenables/Promises → outlined as lazy chunks
- Client references (functions) → Import chunks
- Server references (actions) → `"$F<id>"` with bound args
- Maps → `"$Q<id>"` referencing an outlined entries array
- Sets → `"$W<id>"` referencing an outlined values array
- TypedArrays → binary chunks
- ReadableStreams → streamed async chunks
- Iterables/AsyncIterables → streamed sequences

### What the fused renderer needs from this

At a client boundary, the fused renderer needs to serialize **only the props**
of that client component (not the entire tree). The serialization requirements
are the same as Flight's — we need to handle the same value types. The key
difference:

- **Server component children in props**: Flight resolves these to their output
  before serialization. In the fused renderer, server component children rendered
  as `children` prop of a client component are already HTML. We need a
  tombstone/reference saying "this subtree is server-rendered DOM, don't
  reconstruct it."

## 4. How Flight Handles Async Server Components

When `renderFunctionComponent()` calls `Component(props)` and the result is a
thenable (async component), it goes through `processServerComponentReturnValue()`:

```js
if (typeof result.then === 'function') {
  return createLazyWrapperAroundWakeable(request, task, result);
}
```

This wraps the Promise as a lazy reference. When `retryTask()` later processes
the model and encounters a thenable, the catch block handles it:

```js
if (typeof x.then === 'function') {
  task.status = PENDING;
  task.thenableState = getThenableStateAfterSuspending();
  const ping = task.ping;
  x.then(ping, ping);
  return;
}
```

The task stays PENDING and gets re-queued when the Promise resolves. This is the
same pattern as Fizz's suspension — thenable → ping → retry.

## 5. Module Reference Resolution

### Build time (bundler plugin)

The webpack plugin scans for `'use client'` directives and creates proxy modules:
```js
// Original: src/Button.tsx with 'use client'
// Becomes on the server: a proxy object with
{
  $$typeof: Symbol.for('react.client.reference'),
  $$id: 'src/Button.tsx#default',
  $$async: false
}
```

### Manifest (ClientManifest)

The bundler emits a manifest mapping module IDs to chunk information:
```js
type ClientManifest = {
  [id: string]: {
    id: string,        // webpack module ID
    chunks: string[],  // chunk filenames for loading
    name: string,      // export name
    async?: boolean,
  }
};
```

### Resolution at serialization time

`resolveClientReferenceMetadata(config, clientReference)` looks up the client
reference in the manifest:

```js
function resolveClientReferenceMetadata(config, clientReference) {
  const modulePath = clientReference.$$id;
  // Look up in manifest, extract id + chunks + name
  const resolvedModuleData = config[modulePath];
  return [resolvedModuleData.id, resolvedModuleData.chunks, name];
}
```

The manifest is needed to translate server-side module paths into
client-loadable chunk URLs.

## 6. Implications for the Fused Renderer

### Client component detection in Fizz

The fused renderer needs `isClientReference()` available in Fizz. Currently it's
only imported in the Flight server. Options:

1. **Import the same function** — `isClientReference` is defined per-bundler
   (webpack, turbopack, etc.) via the config layer. Fizz would need a parallel
   config mechanism.
2. **Check `$$typeof` directly** — Since `CLIENT_REFERENCE_TAG =
   Symbol.for('react.client.reference')`, Fizz can check
   `type.$$typeof === Symbol.for('react.client.reference')` without importing
   the bundler-specific function. This is simpler and avoids config coupling.

### What to extract at client boundaries

For each client component, the fused renderer needs:

| Field | Source | Purpose |
|-------|--------|---------|
| Module ID | `type.$$id` | Tells the client which module to load |
| Chunks | From manifest via `resolveClientReferenceMetadata` | Chunk URLs for dynamic import |
| Export name | Extracted from `$$id` or manifest | Which export from the module |
| Async flag | `type.$$async` or manifest | Whether to use dynamic import |
| Serialized props | Props object, serialized | Client needs props to create the element |

### Manifest access

The fused renderer needs access to the same `ClientManifest` that Flight uses.
This means `createRequest()` in Fizz needs to accept a `bundlerConfig` parameter
(same as Flight's `createRequest` does). The framework passes this at the top
level — it's the same manifest.

### Server component detection

A server component is simply: `typeof type === 'function' && !isClientReference(type)`.
There's no special tag — it's the absence of the client reference marker. This is
exactly what Flight checks at `ReactFlightServer.js:2206`.

### Server Actions in props

Server Actions (functions with `$$typeof === SERVER_REFERENCE_TAG`) can appear
in client component props. The fused renderer needs to serialize these as
action references so the client can call them. The existing Flight serialization
format (`"$F<id>"` with bound args) should be reused.
