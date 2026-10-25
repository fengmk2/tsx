# Native transform adapter

This crate integrates Oxc's parser, semantic analysis, transformer, and code
generator with tsx's existing loader. It uses the same compiler as oxc-node, but
accepts per-file options and leaves module resolution and configuration discovery
with tsx.

The compiler parses each input once. An AST visitor checks compatibility before
the TypeScript transform removes syntax. The same AST then passes through semantic
analysis, transformation, and code generation. A rejected input returns `null`;
tsx sends the original source to esbuild. Diagnostics and external runtime helpers
also select this fallback. The adapter does not rewrite generated helpers or parse
generated output to repair compiler differences.

The current native paths support ESM and files that already use CommonJS syntax.
ESM-to-CommonJS conversion, decorators, namespaces, enums, JSX, import attributes,
import-equals declarations, export assignments, parameter properties, and selected
class-field transforms still use esbuild. Source-map directives also select
esbuild so that existing input maps continue to compose correctly.

The CommonJS path does not introduce strict mode. Code generation emits tsx's
filename banner before the source and accounts for it in generated map positions.
Files with a hashbang, ESM syntax, or top-level await use the compatibility path.

`pnpm build` builds the JavaScript entries and this crate, then places the host
artifact at `dist/transform-native.node`. The runtime loads it only after a cache
miss and checks its protocol version. An unavailable, incompatible, or stale
artifact leaves the esbuild path available. Both backends are represented in the
cache identity, even when the native artifact is not loaded.

From this directory, run `cargo test --locked` for the compiler gates. The pinned
toolchain is in `rust-toolchain.toml`. Use `pnpm build:native` from the repository
root to rebuild and copy the optimized addon.

This is a draft implementation. A full native compiler and multi-platform release
assembly remain separate requirements. The existing compatibility backend is
still required; a passing test suite does not establish equivalence for all input
programs.
