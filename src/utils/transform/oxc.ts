import { createRequire } from 'node:module';
import path from 'node:path';
import type { TransformOptions, TsconfigRaw } from 'esbuild';
import { loadCompiler } from '../compiler-loading.js';
import type { Transformed } from './apply-transformers.js';

// Bump this when either the native protocol or its compatibility policy changes.
// Reading the cache identity must not initialize the native binding.
export const oxcBackendVersion = 'oxc-0.155.0:tsx-native-4';

type NativeOptions = {
	target: string;
	lang: 'js' | 'jsx' | 'ts' | 'tsx';
	sourceType: 'module' | 'commonjs';
	sourceMap: true;
	banner?: string;
	footer?: string;
	onlyRemoveTypeImports: boolean;
	useDefineForClassFields: boolean;
	jsx: {
		runtime: 'classic' | 'automatic';
		pragma: string;
		pragmaFrag: string;
		importSource: string;
		development: boolean;
	};
};

type NativeBinding = {
	backendVersion: () => string;
	transformSync: (
		filename: string,
		source: string,
		options: string,
	) => {
		code: string;
		map: string;
	} | null;
};

let binding: NativeBinding | undefined | false;

const loadBinding = () => {
	if (binding === undefined) {
		// A loader can re-enter transformation while resolving the binding.
		binding = false;
		const require = createRequire(import.meta.url);
		for (const load of [
			() => require('#native-transform'),
			() => require('#wasm-transform'),
		]) {
			try {
				const candidate: NativeBinding = loadCompiler(load);
				if (
					typeof candidate.transformSync === 'function'
					&& candidate.backendVersion() === oxcBackendVersion
				) {
					binding = candidate;
					break;
				}
			} catch {
				// The generated loader tries native then WASM. The direct WASM
				// entry also handles a stale native protocol or a missing loader.
			}
		}
	}
	return binding;
};

const supportedOptions = new Set([
	'format',
	'loader',
	'sourcefile',
	'target',
	'sourcemap',
	'sourcesContent',
	'minifyWhitespace',
	'keepNames',
	'tsconfigRaw',
	'platform',
	'banner',
	'footer',
	'jsx',
	'jsxFactory',
	'jsxFragment',
	'jsxImportSource',
	'jsxDev',
]);

const languageByExtension: Record<string, NativeOptions['lang']> = {
	'.js': 'js',
	'.mjs': 'js',
	'.cjs': 'js',
	'.jsx': 'jsx',
	'.ts': 'ts',
	'.mts': 'ts',
	'.cts': 'ts',
	'.tsx': 'tsx',
	'': 'js',
};

const languageForOptions = (options: TransformOptions) => {
	const { loader } = options;
	if (loader && loader !== 'default') {
		return loader === 'ts' || loader === 'tsx' || loader === 'js' || loader === 'jsx'
			? loader
			: undefined;
	}
	return languageByExtension[path.extname(options.sourcefile!.split('?')[0])];
};

const supportsOptions = (options: TransformOptions) => !(
	(options.format !== 'esm' && options.format !== 'cjs')
	|| !options.sourcefile
	|| options.sourcemap !== true
	|| options.target !== `node${process.versions.node}`
	|| options.keepNames !== true
	|| options.minifyWhitespace !== true
	|| typeof options.tsconfigRaw === 'string'
	|| (options.format === 'esm' && Boolean(options.banner || options.footer))
	|| Object.keys(options).some(key => (
		options[key as keyof TransformOptions] !== undefined && !supportedOptions.has(key)
	))
);

const supportsCompilerOptions = (compilerOptions: NonNullable<TsconfigRaw['compilerOptions']>) => {
	for (const key of [
		'alwaysStrict',
		'strict',
		'experimentalDecorators',
		'preserveValueImports',
		'verbatimModuleSyntax',
		'useDefineForClassFields',
	] as const) {
		if (compilerOptions[key] !== undefined && typeof compilerOptions[key] !== 'boolean') {
			return false;
		}
	}
	return compilerOptions.target === undefined || typeof compilerOptions.target === 'string';
};

const getUseDefineForClassFields = (compilerOptions: NonNullable<TsconfigRaw['compilerOptions']>) => {
	const configTarget = compilerOptions.target?.toLowerCase();
	if (configTarget && !/^es(?:[356]|201[5-9]|202[0-6]|next)$/.test(configTarget)) {
		return;
	}
	return compilerOptions.useDefineForClassFields ?? (
		!configTarget || configTarget === 'esnext' || Number(configTarget.slice(2)) >= 2022
	);
};

const jsxFactoryPattern = /^[A-Z_$][\w$]*(?:\.[A-Z_$][\w$]*)*$/i;

const getJsxOptions = (
	options: TransformOptions,
	compilerOptions: NonNullable<TsconfigRaw['compilerOptions']>,
): NativeOptions['jsx'] | undefined => {
	const configuredMode = compilerOptions.jsx;
	if (
		(configuredMode !== undefined && typeof configuredMode !== 'string')
		|| (options.jsx !== undefined && options.jsx !== 'transform' && options.jsx !== 'automatic')
		|| (options.jsxDev !== undefined && typeof options.jsxDev !== 'boolean')
		|| [
			options.jsxFactory,
			options.jsxFragment,
			options.jsxImportSource,
			compilerOptions.jsxFactory,
			compilerOptions.jsxFragmentFactory,
			compilerOptions.jsxImportSource,
		].some(value => value !== undefined && typeof value !== 'string')
		|| [options.jsxFactory, options.jsxFragment]
			.some(value => typeof value === 'string' && !jsxFactoryPattern.test(value))
	) {
		return;
	}
	const configuredJsx = configuredMode?.toLowerCase();
	if (configuredJsx !== undefined && !['react', 'react-jsx', 'react-jsxdev'].includes(configuredJsx)) {
		return;
	}
	// esbuild applies recognized tsconfig JSX settings after its API options.
	const jsxMode = configuredJsx ?? options.jsx;
	const pragma = compilerOptions.jsxFactory ?? options.jsxFactory ?? 'React.createElement';
	const pragmaFrag = compilerOptions.jsxFragmentFactory ?? options.jsxFragment ?? 'React.Fragment';
	const importSource = compilerOptions.jsxImportSource ?? options.jsxImportSource ?? 'react';
	if (
		typeof pragma !== 'string' || !jsxFactoryPattern.test(pragma)
		|| typeof pragmaFrag !== 'string' || !jsxFactoryPattern.test(pragmaFrag)
		|| typeof importSource !== 'string' || !importSource
	) {
		return;
	}

	const automatic = jsxMode === 'automatic' || jsxMode === 'react-jsx' || jsxMode === 'react-jsxdev';
	return {
		runtime: automatic ? 'automatic' : 'classic',
		pragma,
		pragmaFrag,
		importSource,
		development: automatic && (options.jsxDev === true || jsxMode === 'react-jsxdev'),
	};
};

const getNativeOptions = (options: TransformOptions): NativeOptions | undefined => {
	if (!supportsOptions(options) || typeof options.tsconfigRaw === 'string') {
		return;
	}
	if (
		options.tsconfigRaw !== undefined
		&& (!options.tsconfigRaw || typeof options.tsconfigRaw !== 'object' || Array.isArray(options.tsconfigRaw))
	) {
		return;
	}
	const lang = languageForOptions(options);
	const rawCompilerOptions = options.tsconfigRaw?.compilerOptions;
	if (
		rawCompilerOptions !== undefined
		&& (!rawCompilerOptions || typeof rawCompilerOptions !== 'object' || Array.isArray(rawCompilerOptions))
	) {
		return;
	}
	const compilerOptions = rawCompilerOptions ?? {};
	if (!supportsCompilerOptions(compilerOptions)) {
		return;
	}
	if (options.format === 'cjs' && (compilerOptions.alwaysStrict ?? compilerOptions.strict)) {
		return;
	}
	// Legacy import preservation differs from verbatim mode for empty imports
	// and bindings explicitly marked as types. Keep that policy with esbuild.
	if (compilerOptions.preserveValueImports && !compilerOptions.verbatimModuleSyntax) {
		return;
	}
	const useDefineForClassFields = getUseDefineForClassFields(compilerOptions);
	const jsx = getJsxOptions(options, compilerOptions);
	if (!lang || useDefineForClassFields === undefined || !jsx) {
		return;
	}
	const onlyRemoveTypeImports = Boolean(compilerOptions.verbatimModuleSyntax);
	if (
		!onlyRemoveTypeImports
		&& compilerOptions.importsNotUsedAsValues
		&& compilerOptions.importsNotUsedAsValues !== 'remove'
	) {
		return;
	}
	return {
		target: options.target as string,
		lang,
		sourceType: options.format === 'cjs' ? 'commonjs' : 'module',
		sourceMap: true,
		banner: options.banner,
		footer: options.footer,
		onlyRemoveTypeImports,
		useDefineForClassFields,
		jsx,
	};
};

export const attemptOxcTransform = (
	code: string,
	options: TransformOptions,
): Transformed | undefined => {
	const nativeOptions = getNativeOptions(options);
	if (!nativeOptions) {
		return;
	}
	const native = loadBinding();
	if (!native) {
		return;
	}

	try {
		// Source eligibility belongs to the native AST pass, not text matching.
		// A rejected source is transformed from the original text by esbuild.
		const result = native.transformSync(options.sourcefile!, code, JSON.stringify(nativeOptions));
		if (!result) {
			return;
		}
		const map = JSON.parse(result.map) as Transformed['map'];
		if (options.sourcesContent === false) {
			delete map.sourcesContent;
		}
		return {
			code: result.code,
			map,
		};
	} catch {
		// Keep existing error names, messages, and source locations on failures.
	}
};
