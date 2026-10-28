// CJS and ESM bundles must share the scope when both loader APIs are registered.
const compilerLoading = Symbol.for('tsx:compiler-loading');

type GlobalWithCompilerLoading = typeof globalThis & {
	[compilerLoading]?: number;
};

const state = globalThis as GlobalWithCompilerLoading;

export const isCompilerLoading = () => (state[compilerLoading] ?? 0) > 0;

// Generated native/WASM loaders and their transitive require() calls are
// compiler dependencies, not imports made by the program being transformed.
export const loadCompiler = <T>(load: () => T): T => {
	const previousDepth = state[compilerLoading] ?? 0;
	state[compilerLoading] = previousDepth + 1;
	try {
		return load();
	} finally {
		state[compilerLoading] = previousDepth;
	}
};
