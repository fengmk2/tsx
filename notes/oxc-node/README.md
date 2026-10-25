# oxc-node research

`@oxc-node/core` publishes a native transformer, Node loader hooks, and an isolated module importer.

This review used npm `@oxc-node/core@1.0.1` on macOS arm64 with Node `24.22.1`. The `v1.0.1` tag and upstream `HEAD` both resolved to [`6d5376df15df5446a91d01d53f3d7965d8b9708e`](https://github.com/oxc-project/oxc-node/tree/6d5376df15df5446a91d01d53f3d7965d8b9708e) on 2026-10-25. Its Rust dependency is Oxc `0.155.0` ([manifest](https://github.com/oxc-project/oxc-node/blob/6d5376df15df5446a91d01d53f3d7965d8b9708e/Cargo.toml#L65-L77)). Direct `oxc-transform` observations used npm `0.155.0` separately; the packages do not expose the same API.

| File | Covers |
| --- | --- |
| [commonjs-output.md](./commonjs-output.md) | Standalone transform, loader format selection, and module-runner output |
| [configuration.md](./configuration.md) | Configuration ownership, API options, JSX defaults, and helper resolution |
| [semantic-compatibility.md](./semantic-compatibility.md) | Decorators, namespaces, and export-assignment timing |
| [distribution.md](./distribution.md) | Runtime registration and native/WASI distribution |

The loader observations can be repeated with [the evaluation script](../../scripts/oxc-evaluation.ts). The script is a cross-tool comparison; these notes record only oxc-node's own behavior.
