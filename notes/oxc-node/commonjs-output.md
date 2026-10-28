# CommonJS output

`OxcTransformer` accepts a working directory and optional helper module name; `transform` and `transformAsync` receive only a path and source. There is no output-format option ([declarations](https://github.com/oxc-project/oxc-node/blob/6d5376df15df5446a91d01d53f3d7965d8b9708e/packages/core/index.d.ts#L25-L29)). Both paths select the internal `Module::CommonJS` option ([synchronous implementation](https://github.com/oxc-project/oxc-node/blob/6d5376df15df5446a91d01d53f3d7965d8b9708e/src/lib.rs#L1918-L1938), [asynchronous implementation](https://github.com/oxc-project/oxc-node/blob/6d5376df15df5446a91d01d53f3d7965d8b9708e/src/lib.rs#L1834-L1872)). That option does not implement general ESM-to-CJS lowering.

Observed with npm `@oxc-node/core@1.0.1`:

```js
new OxcTransformer(process.cwd())
    .transform('example.ts', 'export const value: number = 42;')
    .source()
// "use strict";
// export const value = 42;
```

The ordinary export remains. Changing the filename to `example.cts` throws a dedicated unsupported-module-syntax error. The implementation explicitly rejects `.cts` containing runtime ESM declarations after removing type-only declarations; `import.meta` gets the same diagnostic ([classification and error](https://github.com/oxc-project/oxc-node/blob/6d5376df15df5446a91d01d53f3d7965d8b9708e/src/lib.rs#L2100-L2138), [post-transform check](https://github.com/oxc-project/oxc-node/blob/6d5376df15df5446a91d01d53f3d7965d8b9708e/src/lib.rs#L2502-L2514)).

The registered load hook can report ambiguous `.ts` and `.js` files as ES modules when their syntax requires it. This is a format change, not CommonJS compilation; the standalone API and CommonJS extension hook cannot return a format to Node ([format selection](https://github.com/oxc-project/oxc-node/blob/6d5376df15df5446a91d01d53f3d7965d8b9708e/src/lib.rs#L2294-L2320)).

`transformModuleRunner(path, source, sync)` is a separate API for `@oxc-node/core/importer`. It converts module syntax to calls and references owned by that importer, including `__vite_ssr_import__` and `__vite_ssr_exports__` ([API and implementation](https://github.com/oxc-project/oxc-node/blob/6d5376df15df5446a91d01d53f3d7965d8b9708e/src/lib.rs#L1734-L1802)). Observed with `sync: true`, `export const value = 42` becomes a getter definition on `__vite_ssr_exports__` followed by the declaration. It requires the module-runner environment and does not emit a standalone Node CommonJS module. The `.cts` syntax rejection still runs before the runner transform.
