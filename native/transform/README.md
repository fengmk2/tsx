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
Classic and automatic JSX use the configured factories, fragments, import source,
and development mode. XML namespaced tags are supported. The TypeScript pass
retains imported classic factories and removes unused bindings in automatic mode.

ESM-to-CommonJS conversion, decorators, namespaces, enums, import attributes,
import-equals declarations, export assignments, parameter properties, and selected
class-field transforms still use esbuild. Source-map directives also select
esbuild so that existing input maps continue to compose correctly.

JSX compatibility fallback covers automatic JSX in CommonJS, a lone spread
attribute in classic JSX, object-literal spread attributes, and JSX pragma
comments. These cases differ in runtime receiver binding, object identity,
property evaluation, or directive handling. Unsupported JSX settings also use
esbuild. JSON continues to use the existing path.

The CommonJS path does not introduce strict mode. Code generation emits tsx's
filename banner before the source and accounts for it in generated map positions.
Files with a hashbang, ESM syntax, or top-level await use the compatibility path.

## JSX configuration

tsx resolves the application's `tsconfig.json` with its existing configuration
rules and passes the JSX settings to the native or WASM adapter. The compiler
does not perform a second configuration lookup.

These settings apply to files included by the selected configuration. Settings
from `extends` are preserved. `.tsx` files do not need `allowJs`. For `.jsx`
files selected through `include`, enable `compilerOptions.allowJs` so the
application's JSX settings apply.

| Application setting | Oxc behavior |
| --- | --- |
| `jsx: "react"`, or no JSX mode | Classic calls; defaults to `React.createElement` and `React.Fragment` |
| `jsx: "react-jsx"` | Automatic production runtime |
| `jsx: "react-jsxdev"` | Automatic development runtime with source location metadata |
| `jsxImportSource` | Package prefix for automatic runtime imports |
| `jsxFactory` / `jsxFragmentFactory` | Classic factory and fragment names; imports used only by JSX remain available |

For example, an application can select Hono's custom JSX runtime:

```json
{
    "compilerOptions": {
        "jsx": "react-jsx",
        "jsxImportSource": "hono/jsx"
    }
}
```

Oxc emits imports from `hono/jsx/jsx-runtime`. With `react-jsxdev`, it uses
`hono/jsx/jsx-dev-runtime`. The application supplies the runtime package; tsx
does not bundle React or substitute its own runtime. Other custom packages can
use the same mechanism if they expose the corresponding JSX runtime entry points.

For classic JSX, set `jsx: "react"`, `jsxFactory: "h"`, and
`jsxFragmentFactory: "Fragment"` to emit `h(...)` calls and use `Fragment`.
These settings apply to both native and WASM compilation. The compatibility
cases listed above still use esbuild with the original source and configuration.

## Build and distribution

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
CI workflow builds each target in `napi.json`, runs the transform tests, and
checks duplicate artifact hashes. `prepare-native-packages.js` then uses napi-rs
`create-npm-dirs` and `artifacts` with the native targets to generate `npm/`
platform packages. The main package references them through `optionalDependencies`
and excludes `.node` files from its tarball. The generated loader selects the
installed platform package. Local source builds can still load a binary directly
from `dist/native`.

Older npm versions can install both glibc and musl packages for the current Linux
CPU. The loader still selects the matching binary.

WASM stays in the main package rather than a CPU-filtered `wasm32` package. This
preserves the fallback when native addons or optional dependencies are disabled.
The release loader uses the final package version, and native packages publish
before the main package. Package names use the `packageName` prefix in `napi.json`.

The lockfiles record compatible CLI, Rust binding, and WASM runtime versions.
The WASM runtime retains Node 18 support; newer runtime releases raise the minimum Node
version. Early Node 18 releases have incompatible or unavailable WASI support, so
they retain native transforms and the final esbuild fallback. A native build alone
does not establish WASM compatibility.

From this directory, run `cargo test --locked` for the compiler gates. The pinned
toolchain is in `rust-toolchain.toml`. Use `pnpm build:native` from the repository
root to rebuild the optimized host addon and WASM. Use `--target <triple>` with
`scripts/build-native.js` to build one target. The adapter does not load WASM for
a syntax rejection from a working native compiler, because both use the same Oxc
compiler and eligibility rules.

This is a draft implementation. Complete Oxc syntax coverage remains unfinished.
The existing compatibility backend is still required; a passing test suite does
not establish equivalence for all input programs.
