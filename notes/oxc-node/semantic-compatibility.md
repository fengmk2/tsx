# Semantic compatibility

The observations below use npm `@oxc-node/core@1.0.1` and the source revision recorded in [the index](./README.md).

Standard TC39 decorators are rejected before transformation. Legacy decorators require an applicable config with `experimentalDecorators: true`; JavaScript files also need `allowJs` for that config to claim them ([decorator gate](https://github.com/oxc-project/oxc-node/blob/6d5376df15df5446a91d01d53f3d7965d8b9708e/src/lib.rs#L2346-L2363)). Observed input `function dec(value, context) { return value; } @dec class Example {}` throws the explicit standard-decorators-not-supported error.

Oxc transformer diagnostics are fatal in oxc-node, including warnings ([diagnostic handling](https://github.com/oxc-project/oxc-node/blob/6d5376df15df5446a91d01d53f3d7965d8b9708e/src/lib.rs#L2481-L2500)). Observed input below throws a diagnostic for a mutable namespace export:

<!-- eslint-skip -->

```ts
namespace N {
  export let count = 0;
  export function inc() { count++; }
}
N.inc();
console.log(N.count);
```

The direct npm `oxc-transform@0.155.0` API instead returns a warning and output that prints `0`: the local `count` changes, but the namespace property does not. See [Oxc namespace implementation evidence](../oxc-transform/semantic-compatibility.md).

TypeScript `export =` lowers at its source position. Observed standalone transformation of the following code prints `42` when executed with a fresh CommonJS `module` object:

```ts
const value = 42
export = value
console.log(module.exports)
```

The generated `module.exports = value` precedes the log. This ordering follows Oxc's [TypeScript module transform](../oxc-transform/semantic-compatibility.md). Cross-tool compatibility judgments about the result belong to the integration notes, not this tool contract.
