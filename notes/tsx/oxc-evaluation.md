# Oxc-based tsx feasibility

## Decision

The current Oxc packages can accelerate some TypeScript workloads, but they cannot replace tsx's backend while preserving its full behavior. Do not switch the production backend on the strength of ESM benchmarks. This assessment covers npm `@oxc-node/core@1.0.1`, `oxc-transform@0.155.0`, and the tsx checkout at `4473971` with `esbuild@0.28.0`, reviewed on 2026-10-25. The [oxc-node source revision and APIs](../oxc-node/README.md) are recorded separately.

The implementation condition is full compatibility, not just faster execution of a supported subset. The current evaluation fails that condition. The changes therefore provide executable evaluation tools and regression coverage; they do not add a candidate dependency to tsx or change its runtime.

## Observable compatibility

[The evaluation script](../../scripts/oxc-evaluation.ts) starts a fresh Node process for each candidate and fixture. It checks the existing tsx result against an explicit expectation before comparing oxc-node. It clears configuration environment overrides, uses an isolated project, and disables tsx's transform cache.

Observed on macOS arm64, Node `24.22.1`:

| Input or behavior | tsx | oxc-node `1.0.1` |
| --- | --- | --- |
| Basic ESM TypeScript | Runs, prints `42` | Same result |
| Runtime ESM import/export in `.cts` | Runs | Rejects module syntax |
| Standard decorators | Runs decorator | Rejects decorators |
| Mutable namespace export | Mutation updates exported value | Rejects namespace |
| `export =` followed by a `module.exports` observation | Assignment occurs after module body | Assignment occurs at declaration |
| TypeScript under `node_modules` | Transforms dependency by default | Leaves dependency to Node; loading fails |

The dependency policy has an upstream API override, so it is an adapter requirement rather than an intrinsic compiler blocker. The module conversion and runtime semantics are compiler blockers. See [module output](../oxc-node/commonjs-output.md), [semantics](../oxc-node/semantic-compatibility.md), and [configuration](../oxc-node/configuration.md).

These examples disprove complete compatibility. Passing a later version through these examples alone would not prove complete compatibility.

## Integration options

| Approach | Remaining work or failure |
| --- | --- |
| Replace tsx's hooks with oxc-node's hooks | Changes module classification, configuration selection, dependency policy, runtime support, and public registration behavior, in addition to the compiler differences above. |
| Keep tsx's hooks and call `OxcTransformer` | Public calls lack per-file format/configuration controls, and the advertised CommonJS path still leaves ordinary ESM exports intact. |
| Keep tsx's hooks and call `oxc-transform` | Allows explicit options, but lacks complete CommonJS lowering and has the documented decorator, namespace, helper, and distribution gaps. |
| Call `transformModuleRunner` | Output requires a custom module executor and its import/export environment. It is not code that tsx can pass to Node's ordinary CommonJS compiler. `.cts` rejection still applies. |
| Run Oxc, then esbuild for module conversion | Two passes do not recover semantics already changed in the first pass, such as namespace mutations or export-assignment timing. |
| Choose Oxc for selected sources and use esbuild elsewhere | Requires a proven semantic eligibility gate, not only catching transform errors. Some incompatible transformations succeed. This does not satisfy the repository's full-backend contract by itself. |

An ESM-only implementation would also miss the independent esbuild calls in [CLI eval/print](../../src/cli.ts), [REPL evaluation](../../src/patch-repl.ts), and the diagnostic/export-descriptor assumptions in [CommonJS loading](../../src/cjs/api/module-extensions.ts).

The current [transform-backend contract](./transform-backend.md) also requires name preservation, fresh-realm execution, import-elision semantics, source-map locations, supported Node versions/platforms, and cache-independent behavior. A full migration must verify each of those, plus the resolver, CLI, watch, and scoped API suites. Existing tests are necessary but not a proof for arbitrary input programs.

## Reproduction

Keep candidate dependencies in a disposable directory rather than changing tsx's production dependency graph:

```sh
candidate_dir=$(mktemp -d)
npm install --prefix "$candidate_dir" --no-audit --no-fund \
  @oxc-node/core@1.0.1 oxc-transform@0.155.0
pnpm build
node ./dist/cli.mjs scripts/oxc-evaluation.ts \
  --candidate-dir "$candidate_dir" > compatibility.json
node scripts/benchmark/oxc.mjs \
  --candidate-dir "$candidate_dir" --runs 7 --modules 1000 --iterations 500 \
  > performance.json
```

The compatibility command exits successfully when the experiment completes; inspect its JSON `status` and individual results. A reference failure, timeout, or missing installation fails the command. The benchmark checks process exit codes and the evaluated graph total. Run measurements without other builds or tests, and use the same Node executable throughout.

## Performance observations

[Raw measurements](./oxc-benchmark.json) retain all seven samples for every case. These were collected on an otherwise idle Apple M4 Max, macOS arm64, Node `24.22.1`, using the package versions above. The runtime experiment uses `node --import`, so it measures hooks, resolution, transforms, and execution without either project's CLI wrapper. "Cold" means an empty transform cache, not an empty operating-system filesystem cache.

| Runtime workload | tsx median | oxc-node median |
| --- | ---: | ---: |
| Empty JavaScript entry, warm cache policy | 40.78 ms | 48.83 ms |
| 1,000-module ESM TypeScript tree, warm cache | 129.42 ms | 174.44 ms |
| Same tree, cold cache | 521.85 ms | 174.44 ms |
| Same tree, cache disabled | 414.73 ms | 174.44 ms |

Oxc-node has no transform cache; its one result is repeated for comparison. It is about 3.0 times as fast as cold tsx on this synthetic ESM graph, but takes about 35% longer than warm tsx. The projects use different hook strategies on this Node version, so the graph measurement is not an isolated measurement of their compilers.

| Transform batch (500 calls) | esbuild ESM | Oxc ESM | esbuild CJS | Oxc then esbuild CJS |
| --- | ---: | ---: | ---: | ---: |
| 104-byte source | 114.50 ms | 2.37 ms | 141.55 ms | 155.47 ms |
| 10,479-byte source | 399.29 ms | 54.93 ms | 418.72 ms | 567.84 ms |

These are medians after warmup, without tsx's transform cache. Both transformers generate maps; the second-pass measurement includes map composition. Pure Oxc ESM transformation is much faster, but it does not implement the full required semantics. The two-pass CJS experiment is approximately 10% and 36% slower on these sources, respectively, and still has semantic differences. The measurements support further compiler work, not a claim of a universally faster compatible tsx replacement.

## Validation boundary

The added [transform regression tests](../../tests/specs/transform.ts) exercise standard decorators, mutable namespaces, and Unicode stack locations through CommonJS, synchronous ESM, and asynchronous ESM. They also check live CommonJS re-exports and existing export-assignment timing. The focused transform/cache run passes all 33 tests.

The full local suite reports 229 passes and two failures on Node `24.22.1`: hook-composition observations and CommonJS namespace markers in `tsImport`. Both failures reproduce individually after archiving clean `4473971`, rebuilding, and running with the same Node executable. They are baseline failures, not evidence of an Oxc regression or a successful complete compatibility run. No production code is changed by this evaluation.

## Conditions for a production implementation

1. Supply complete per-file CommonJS conversion with compatible live bindings, re-exports, interop, `import.meta`, and top-level-await errors.
2. Resolve standard decorators, mutable namespaces, import elision, and export-assignment timing at the compiler layer. A fallback only on thrown errors is insufficient.
3. Expose the per-file options tsx needs and establish helper ownership without relying on dependencies resolvable from arbitrary user files.
4. Preserve the declared Node/platform installation contract, source maps, names, and existing public APIs.
5. Run the full compatibility matrix and end-to-end cold/warm benchmarks on the completed adapter. Accept a speed claim only for behaviorally equivalent output.

These are upstream/compiler and integration requirements, not a promise that changing one dependency will satisfy the task. Re-evaluate when the candidate APIs or semantics change.
