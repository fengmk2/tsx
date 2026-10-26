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

`pnpm build` builds the JavaScript entries, the host native binary, and a WASM
version of this crate. napi-rs generates the platform loader at
`dist/native/index.cjs`. It tries the matching native binary, then the bundled
`transform.wasi.cjs` loader and WASM file. The adapter also tries the direct WASM
entry if the native protocol is stale. Compiler loading occurs only after a cache
miss and supported-option checks. Both formats expose the same protocol and
transform function; syntax rejected by either format goes directly to esbuild
with the original source.

The package includes WASM and its runtime dependencies on every platform. It does
not depend on package managers selecting a `wasm32` optional package. The native
CI workflow builds each target in `napi.json`, runs the transform tests, checks
duplicate artifact hashes, and assembles all binaries into the root package.
Bundling the full set trades a larger download for a self-contained artifact set.

The CLI, Rust bindings, and WASM runtime use compatible pinned versions. The WASM
runtime retains Node 18 support; newer runtime releases raise the minimum Node
version. Early Node 18 releases have incompatible or unavailable WASI support, so
they retain native transforms and the final esbuild fallback. A native build alone
does not establish WASM compatibility.

From this directory, run `cargo test --locked` for the compiler gates. The pinned
toolchain is in `rust-toolchain.toml`. Use `pnpm build:native` from the repository
root to rebuild the optimized host addon and WASM. Use `--target <triple>` with
`scripts/build-native.mjs` to build one target. The adapter does not load WASM for
a syntax rejection from a working native compiler, because both use the same Oxc
compiler and eligibility rules.

This is a draft implementation. Complete Oxc syntax coverage remains unfinished.
The existing compatibility backend is still required; a passing test suite does
not establish equivalence for all input programs.
