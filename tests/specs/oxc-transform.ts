import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, test, expect } from 'manten';
import { createFixture } from 'fs-fixture';
import { execaNode } from 'execa';
import {
	buildSync as esbuildBuildSync,
	transformSync as esbuildTransformSync,
	type TransformOptions,
} from 'esbuild';
import { attemptOxcTransform, oxcBackendVersion } from '../../src/utils/transform/oxc.js';
import { cacheConfig } from '../../src/utils/transform/get-esbuild-options.js';
import { transform, transformEsmSync, transformSync } from '../../src/utils/transform/index.js';
import { inlineSourceMap } from '../../src/source-map.js';

const options: TransformOptions = {
	...cacheConfig,
	format: 'esm',
	sourcefile: '/native-transform.ts',
};

const importOutput = (code: string) => import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

const bundleAdapter = () => esbuildBuildSync({
	entryPoints: [fileURLToPath(new URL('../../src/utils/transform/oxc.ts', import.meta.url))],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: `node${process.versions.node}`,
	write: false,
}).outputFiles[0].text;

export const oxcTransformSpec = () => describe('Oxc transform', () => {
	test('loads the generated compiler binding for the active Node mode', () => {
		const require = createRequire(import.meta.url);
		const binding = require('#native-transform');
		expect(binding.backendVersion()).toBe(oxcBackendVersion);
		const loadedNativeArtifacts = Object.keys(require.cache).filter(filename => (
			path.basename(filename).startsWith('transform.') && filename.endsWith('.node')
		));
		if (process.execArgv.includes('--no-addons')) {
			expect(loadedNativeArtifacts).toStrictEqual([]);
			assert(require.cache[require.resolve('#wasm-transform')], 'Disabled addons must select the bundled WASM compiler');
		} else {
			expect(loadedNativeArtifacts.length).toBe(1);
		}
	});

	describe('Oxc path', () => {
		test('transforms eligible TypeScript with the selected Oxc binding', async () => {
			const result = attemptOxcTransform(`
				interface Value { value: number }
				export const makeValue = (value: number): Value => ({ value });
				export const answer: Value = makeValue(42);
			`, options);
			assert(result, 'Eligible TypeScript must use Oxc when its artifact is installed');
			const loaded = await importOutput(result.code);
			expect(loaded.answer).toStrictEqual({ value: 42 });
			expect(loaded.makeValue.name).toBe('makeValue');
		});

		test('classifies syntax from the AST rather than strings and comments', async () => {
			const result = attemptOxcTransform(`
				// namespace enum import Alias = Name.Type; @decorator
				export const text: string = 'namespace enum @decorator';
			`, options);
			assert(result);
			const loaded = await importOutput(result.code);
			expect(loaded.text).toBe('namespace enum @decorator');
		});

		test('preserves nested function names and fresh-realm execution', async () => {
			const result = attemptOxcTransform(`
				export const factory = () => {
					const nested = (value: number) => value + 1;
					return nested;
				};
			`, options);
			assert(result);
			const { factory } = await importOutput(result.code);
			expect(factory.name).toBe('factory');
			expect(factory().name).toBe('nested');
			expect(runInNewContext(`(${factory.toString()})()(41)`)).toBe(42);
		});

		test('preserves source identity and sourcesContent policy', () => {
			const source = 'export const value: number = 42;';
			for (const sourcesContent of [false, true]) {
				const sourcefile = '/quoted " source.mts?namespace=one';
				const result = attemptOxcTransform(source, {
					...options,
					sourcefile,
					sourcesContent,
				});
				assert(result);
				expect(result.map.sources).toStrictEqual([sourcefile]);
				expect(result.map.sourcesContent).toStrictEqual(sourcesContent ? [source] : undefined);
			}
		});

		test('maps native output errors after Unicode to the original column', async () => {
			await using fixture = await createFixture();
			const sourcefile = fixture.getPath('original.ts');
			const errorLine = 'const icon = "😀"; throw new Error("native-map");';
			const result = attemptOxcTransform(`export const value: number = 42;\n${errorLine}`, {
				...options,
				sourcefile,
			});
			assert(result);
			await fixture.writeFile('output.mjs', inlineSourceMap(result));
			const { exitCode, stderr } = await execaNode(fixture.getPath('output.mjs'), {
				nodeOptions: ['--enable-source-maps'],
				reject: false,
			});
			expect(exitCode).toBe(1);
			expect(stderr).toContain(`${sourcefile}:2:${errorLine.indexOf('new Error') + 1}`);
		});

		test('transforms CommonJS TypeScript without imposing strict mode', () => {
			const result = attemptOxcTransform(`
				const named = function () {};
				function getThis() { return this; }
				const value: number = 42;
				module.exports = { value, name: named.name, sloppy: getThis() === globalThis };
			`, {
				...options,
				format: 'cjs',
				banner: '__filename="/source.cts";(()=>{',
				footer: '})()',
			});
			assert(result);
			const module = { exports: {} };
			runInNewContext(result.code, { module });
			expect({ ...module.exports }).toStrictEqual({
				value: 42,
				name: 'named',
				sloppy: true,
			});
		});

		test('maps CommonJS errors after the filename banner to original source', async () => {
			await using fixture = await createFixture();
			const sourcefile = fixture.getPath('original.cts');
			const errorLine = 'const icon = "😀"; throw new Error("native-cjs-map");';
			const result = attemptOxcTransform(`const value: number = 42;\n${errorLine}`, {
				...options,
				sourcefile,
				format: 'cjs',
				banner: `__filename=${JSON.stringify(sourcefile)};(()=>{`,
				footer: '})()',
			});
			assert(result);
			await fixture.writeFile('output.cjs', inlineSourceMap(result));
			const { exitCode, stderr } = await execaNode(fixture.getPath('output.cjs'), {
				nodeOptions: ['--enable-source-maps'],
				reject: false,
			});
			expect(exitCode).toBe(1);
			expect(stderr).toContain(`${sourcefile}:2:${errorLine.indexOf('new Error') + 1}`);
		});

		test('preserves CommonJS directives and top-level return', () => {
			for (const [source, expected] of [
				['"use strict"; module.exports = (function () { return this === undefined; })();', true],
				['module.exports = 42; return; throw new Error("unreachable");', 42],
			] as const) {
				const result = attemptOxcTransform(source, {
					...options,
					format: 'cjs',
					banner: '__filename="/source.cts";(()=>{',
					footer: '})()',
				});
				assert(result);
				const module = { exports: {} };
				runInNewContext(result.code, { module });
				expect(module.exports).toBe(expected);
			}
		});
	});

	test('retains compatibility fallback when both compiler artifacts are missing', async () => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({
				type: 'module',
				imports: {
					'#native-transform': './missing-native.cjs',
					'#wasm-transform': './missing-wasm.cjs',
				},
			}),
			'adapter.mjs': bundleAdapter(),
		});
		const adapter = await import(pathToFileURL(fixture.getPath('adapter.mjs')).href);
		expect(adapter.attemptOxcTransform('export const value: number = 42;', options)).toBeUndefined();
	});

	test('tries WASM when the native binding has an incompatible protocol', async () => {
		const transformedCode = 'export const value = 42;';
		await using fixture = await createFixture({
			'package.json': JSON.stringify({
				type: 'module',
				imports: {
					'#native-transform': './native.cjs',
					'#wasm-transform': './wasm.cjs',
				},
			}),
			'adapter.mjs': bundleAdapter(),
			'native.cjs': `module.exports = {
				backendVersion: () => 'incompatible-protocol',
				transformSync() { throw new Error('The incompatible compiler must not run'); },
			};`,
			'wasm.cjs': `module.exports = {
				backendVersion: () => ${JSON.stringify(oxcBackendVersion)},
				transformSync: (filename, source) => ({
					code: ${JSON.stringify(transformedCode)},
					map: JSON.stringify({ version: 3, sources: [filename], sourcesContent: [source], names: [], mappings: '' }),
				}),
			};`,
		});
		const adapter = await import(pathToFileURL(fixture.getPath('adapter.mjs')).href);
		const originalSource = 'export const value: number = 42;';
		const result = adapter.attemptOxcTransform(originalSource, {
			...options,
			sourcesContent: true,
		});
		assert(result);
		expect(result.code).toBe(transformedCode);
		expect(result.map.sourcesContent).toStrictEqual([originalSource]);
	});

	test('preserves CommonJS module conversion through the compatibility backend', () => {
		const source = 'export const value: number = 42;';
		expect(attemptOxcTransform(source, {
			...options,
			format: 'cjs',
		})).toBeUndefined();
		const result = transformSync(source, '/esm-in-commonjs.cts');
		const module = { exports: {} };
		runInNewContext(result.code, { module });
		expect(module.exports).toMatchObject({ value: 42 });
	});

	test('preserves explicit and configured strict mode for CommonJS', () => {
		for (const source of [
			'module.exports = (function () { return this === undefined; })();',
			'"use strict"; module.exports = (function () { return this === undefined; })();',
		]) {
			const result = transformSync(source, '/strict.cts', {
				tsconfigRaw: { compilerOptions: { alwaysStrict: true } },
			});
			const module = { exports: {} };
			runInNewContext(result.code, { module });
			expect(module.exports).toBe(true);
		}
	});

	test('declines unsupported syntax before returning transformed output', () => {
		for (const source of [
			'namespace Counter { export let value = 1; } export { Counter };',
			'function decorate(value) { return value; } @decorate class Example {} export { Example };',
			'enum State { Ready, Done } export { State };',
			'import { Value } from "./dependency.mjs"; import /* comment */ Alias = Value.Type; export const answer = 42;',
			'import fs = require("node:fs"); export const value = fs.existsSync;',
			'const value = 42; export = value;',
		]) {
			expect(attemptOxcTransform(source, options)).toBeUndefined();
		}
	});

	test('declines unsupported transform options', () => {
		const source = 'export const value: number = 42;';
		for (const overrides of [
			{ banner: 'globalThis.before = true;' },
			{ define: { value: 'anotherValue' } },
			{ target: 'node18' },
			{ keepNames: false },
			{ minifyWhitespace: false },
			{ jsx: 'preserve' },
			{ jsxFactory: 'invalid factory' },
			{ tsconfigRaw: '{"compilerOptions":{}}' },
			{ tsconfigRaw: { compilerOptions: { importsNotUsedAsValues: 'preserve' } } },
		] satisfies TransformOptions[]) {
			expect(attemptOxcTransform(source, {
				...options,
				...overrides,
			})).toBeUndefined();
		}
	});

	test('declines malformed compiler options rather than reinterpreting their values', () => {
		for (const compilerOptions of [
			{ target: 2020 },
			{ target: 'es2000' },
			{ verbatimModuleSyntax: 'false' },
			{ preserveValueImports: 'false' },
			{ useDefineForClassFields: 'false' },
			{ alwaysStrict: 'false' },
		]) {
			expect(attemptOxcTransform('export const value: number = 42;', {
				...options,
				tsconfigRaw: { compilerOptions } as TransformOptions['tsconfigRaw'],
			})).toBeUndefined();
		}
	});

	for (const [mode, transformSource] of [
		['sync', transformEsmSync],
		['async', transform],
	] as const) {
		describe(`${mode} integration`, () => {
			for (const [label, compilerOptions, expectedEvaluations] of [
				['default', {}, 0],
				['verbatim', { verbatimModuleSyntax: true }, 1],
				['legacy preserveValueImports', { preserveValueImports: true }, 0],
				['explicit non-verbatim', {
					verbatimModuleSyntax: false,
					preserveValueImports: true,
				}, 0],
				['verbatim overrides legacy preservation', {
					verbatimModuleSyntax: true,
					preserveValueImports: false,
				}, 1],
				['verbatim with legacy preservation', {
					verbatimModuleSyntax: true,
					preserveValueImports: true,
				}, 1],
			] as const) {
				test(`${label} preserves empty and type-only dependency evaluation behavior`, async () => {
					await using fixture = await createFixture({
						'dependency.mjs': 'globalThis.evaluations = (globalThis.evaluations ?? 0) + 1; export const value = 42;',
					});
					for (const declaration of [
						'import {}',
						'import { type value }',
						'export {}',
						'export { type value }',
					]) {
						const result = await transformSource(`
							${declaration} from './dependency.mjs';
							console.log(globalThis.evaluations ?? 0);
						`, fixture.getPath('original.ts'), {
							tsconfigRaw: { compilerOptions },
						});
						await fixture.writeFile('output.mjs', result.code);
						const { stdout } = await execaNode(fixture.getPath('output.mjs'));
						expect(stdout).toBe(String(expectedEvaluations));
					}
				});
			}

			test('composes an incoming source map through the compatibility backend', async () => {
				await using fixture = await createFixture();
				const originalPath = fixture.getPath('original.ts');
				const intermediate = esbuildTransformSync('export const value = 1;\n\nthrow new Error("input-map");', {
					loader: 'ts',
					format: 'esm',
					sourcefile: originalPath,
					sourcemap: 'external',
					minifyWhitespace: true,
				});
				const inputMap = Buffer.from(intermediate.map).toString('base64');
				const source = `${intermediate.code}\n//# sourceMappingURL=data:application/json;base64,${inputMap}`;
				expect(attemptOxcTransform(source, options)).toBeUndefined();
				const result = await transformSource(source, fixture.getPath('intermediate.ts'));
				await fixture.writeFile('output.mjs', inlineSourceMap(result));
				const { exitCode, stderr } = await execaNode(fixture.getPath('output.mjs'), {
					nodeOptions: ['--enable-source-maps'],
					reject: false,
				});
				expect(exitCode).toBe(1);
				// esbuild can lowercase Windows drive letters when composing source maps.
				const normalizeDriveLetter = (value: string) => value.replaceAll(/\b[A-Z]:(?=\\)/g, drive => drive.toLowerCase());
				expect(normalizeDriveLetter(stderr)).toContain(`${normalizeDriveLetter(originalPath)}:3:7`);
			});

			test('executes eligible ESM TypeScript', async () => {
				const result = await transformSource('export const value: number = 42;', `/eligible-${mode}.ts`);
				const loaded = await importOutput(result.code);
				expect(loaded.value).toBe(42);
			});

			test('uses the original source for namespace fallback', async () => {
				const result = await transformSource(`
					namespace Counter {
						export let value = 1;
						export function increment() { value += 1; }
					}
					Counter.increment();
					export const value = Counter.value;
				`, `/namespace-${mode}.ts`);
				const loaded = await importOutput(result.code);
				expect(loaded.value).toBe(2);
			});

			test('retains dependency evaluation when a qualified import alias is erased', async () => {
				await using fixture = await createFixture({
					'dependency.mjs': 'globalThis.evaluated = 42; export const Value = {};',
				});
				const result = await transformSource(`
					import { Value } from './dependency.mjs';
					import /* comment */ Alias = Value.Type;
					console.log(globalThis.evaluated);
				`, fixture.getPath('original.ts'));
				await fixture.writeFile('output.mjs', result.code);
				const { stdout } = await execaNode(fixture.getPath('output.mjs'));
				expect(stdout).toBe('42');
			});

			test('preserves class-field configuration through fallback', async () => {
				const configurations = [
					[{}, [true, undefined]],
					[{ target: 'ES2020' }, [false, 42]],
					[{ target: 'ES2022' }, [true, undefined]],
					[{ useDefineForClassFields: false }, [false, 42]],
					[{ useDefineForClassFields: true }, [true, undefined]],
					[{
						target: 'ES2020',
						useDefineForClassFields: true,
					}, [true, undefined]],
				] as const;
				for (const [index, [compilerOptions, expected]] of configurations.entries()) {
					const result = await transformSource(`
						class Base { set value(value) { this.setterCalled = value; } }
						class Example extends Base { value: number = 42; }
						const example = new Example();
						export const result = [Object.hasOwn(example, 'value'), example.setterCalled];
					`, `/fields-${mode}-${index}.ts`, {
						tsconfigRaw: { compilerOptions },
					});
					const loaded = await importOutput(result.code);
					expect(loaded.result).toStrictEqual(expected);
				}
			});

			test('retains TransformError diagnostics for invalid source', async () => {
				await expect(async () => transformSource('export const value: = 42;', `/invalid-${mode}.ts`))
					.rejects.toMatchObject({ name: 'TransformError' });
			});
		});
	}
});
