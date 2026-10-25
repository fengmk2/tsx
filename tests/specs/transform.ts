import { describe, test, expect } from 'manten';
import { createFsRequire } from 'fs-require';
import { createFixture } from 'fs-fixture';
import { execaNode } from 'execa';
import { Volume } from 'memfs';
import outdent from 'outdent';
import { transform, transformSync, transformEsmSync } from '../../src/utils/transform/index.js';
import { inlineSourceMap } from '../../src/source-map.js';

const base64Module = (code: string) => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;

const fixtures = {
	ts: outdent`
	const __filename = 'filename';
	const __dirname = 'dirname';
	try {
		const unusedVariable1 = 1;
	} catch (unusedError) {
		const unusedVariable2 = 2;
	}
	export default 'default value' as string;
	export const named: string = 'named';
	export const functionName: string = (function named() {}).name;
	export const url = import.meta.url;
	`,

	esm: outdent`
	const __filename = 'filename';
	const __dirname = 'dirname';
	try {
		const unusedVariable1 = 1;
	} catch (unusedError) {
		const unusedVariable2 = 2;
	}

	export default 'default value';
	export const named = 'named';
	export const functionName = (function named() {}).name;
	export const url = import.meta.url;
	`,
};

export const transformSpec = () => describe('transform', () => {
	describe('backend compatibility', () => {
		for (const [mode, transformSource] of [
			['CommonJS', transformSync],
			['sync ESM', transformEsmSync],
			['async ESM', transform],
		] as const) {
			describe(mode, () => {
				const load = async (source: string) => {
					const transformed = await transformSource(source, '/compatibility.ts');
					return mode === 'CommonJS'
						? createFsRequire(Volume.fromJSON({
							'/compatibility.js': transformed.code,
						}))('/compatibility.js')
						: import(`${base64Module(transformed.code)}#${encodeURIComponent(mode)}`);
				};

				test('runs standard decorators and instance initializers', async () => {
					const loaded = await load(outdent`
					function decorate(method, context) {
						context.addInitializer(function () {
							this.initialized = context.name;
						});
						return function () {
							return method.call(this).toUpperCase();
						};
					}
					class Example {
						@decorate
						greet() { return 'hello'; }
					}
					const example = new Example();
					export const result = [example.greet(), example.initialized];
					`);

					expect(loaded.result).toStrictEqual(['HELLO', 'greet']);
				});

				test('keeps mutable namespace exports live', async () => {
					const loaded = await load(outdent`
					namespace Counter {
						export let value = 1;
						export function increment() { value += 1; }
					}
					const initial = Counter.value;
					Counter.increment();
					const incremented = Counter.value;
					Counter.value = 7;
					Counter.increment();
					export const result = [initial, incremented, Counter.value];
					`);

					expect(loaded.result).toStrictEqual([1, 2, 8]);
				});

				test('maps errors after Unicode to the original line and column', async () => {
					await using fixture = await createFixture();
					const sourcePath = fixture.getPath('original.ts');
					const errorLine = 'const icon = "😀"; throw new Error("mapped-error");';
					const transformed = await transformSource(
						`export const value: number = 1;\n${errorLine}`,
						sourcePath,
					);
					const outputFile = mode === 'CommonJS' ? 'output.cjs' : 'output.mjs';
					await fixture.writeFile(outputFile, inlineSourceMap(transformed));

					const { exitCode, stderr } = await execaNode(fixture.getPath(outputFile), {
						nodeOptions: ['--enable-source-maps'],
						reject: false,
					});

					expect(exitCode).toBe(1);
					expect(stderr).toContain(`${sourcePath}:2:${errorLine.indexOf('new Error') + 1}`);
				});
			});
		}

		test('CommonJS re-exports retain live bindings', () => {
			const sources = {
				'/dependency.ts': 'export let value = 1; export const increment = () => { value += 1; };',
				'/other.ts': 'export const extra = 3; export default "not re-exported";',
				'/entry.ts': 'export { value, increment } from "./dependency.ts"; export * from "./other.ts";',
			};
			const files = Object.fromEntries(Object.entries(sources).map(([filePath, source]) => [
				filePath,
				transformSync(source, filePath).code,
			]));
			const loaded = createFsRequire(Volume.fromJSON(files))('/entry.ts');

			expect(loaded.value).toBe(1);
			loaded.increment();
			expect(loaded.value).toBe(2);
			expect(loaded.extra).toBe(3);
			expect(Object.hasOwn(loaded, 'default')).toBe(false);
		});

		test('assigns export equals after evaluating the module body', () => {
			const transformed = transformSync(outdent`
			const original = module.exports;
			const result = { unchangedDuringEvaluation: false };
			export = result;
			result.unchangedDuringEvaluation = module.exports === original;
			`, '/export-equals.cts');
			const loaded = createFsRequire(Volume.fromJSON({
				'/export-equals.cjs': transformed.code,
			}))('/export-equals.cjs');

			expect(loaded).toStrictEqual({ unchangedDuringEvaluation: true });
		});
	});

	describe('sync', () => {
		test('transforms ESM to CJS', () => {
			const transformed = transformSync(
				fixtures.esm,
				'file.js',
				{ format: 'cjs' },
			);

			// For debuggers
			expect(transformed.code).toMatch('unusedVariable1');
			expect(transformed.code).toMatch('unusedVariable2');

			const fsRequire = createFsRequire(Volume.fromJSON({
				'/file.js': transformed.code,
			}));

			expect(fsRequire('/file.js')).toStrictEqual({
				default: 'default value',
				functionName: 'named',
				named: 'named',
				url: expect.stringMatching(/^file:\/\/\/.*\/file.js$/),
			});
		});

		test('import.meta helper cannot be shadowed by user bindings', () => {
			const transformed = transformSync(
				`
				const define_import_meta_default = { url: 'shadowed' };
				export const url = import.meta.url;
				export const local = define_import_meta_default.url;
				`,
				'file.js',
				{ format: 'cjs' },
			);

			const fsRequire = createFsRequire(Volume.fromJSON({
				'/file.js': transformed.code,
			}));

			expect(fsRequire('/file.js')).toEqual({
				local: 'shadowed',
				url: expect.stringMatching(/^file:\/\/\/.*\/file.js$/),
			});
		});

		test('doesnt emit import.meta helper without import.meta syntax', () => {
			const transformed = transformSync(
				`
				// import.meta.url
				const text = 'import.meta.url';
				export const value = text;
				`,
				'file.js',
				{ format: 'cjs' },
			);

			expect(transformed.code).not.toContain('import_meta');
		});

		test('shims import.meta when tokens are split by comments or newlines', () => {
			const transformed = transformSync(
				outdent`
				export const commented = import /*::(_)*/.meta.url;
				export const newlined = import
					.meta.url;
				`,
				'file.js',
				{ format: 'cjs' },
			);

			const loaded = createFsRequire(Volume.fromJSON({
				'/file.js': transformed.code,
			}))('/file.js');

			expect(loaded.commented).toMatch(/^file:\/\/\/.*\/file.js$/);
			expect(loaded.newlined).toMatch(/^file:\/\/\/.*\/file.js$/);
		});

		test('supports import.meta object access', () => {
			const transformed = transformSync(
				`
				export const meta = import.meta;
				export const computed = import.meta['url'];
				export const destructured = (() => {
					const { url } = import.meta;
					return url;
				})();
				export const prototype = Object.getPrototypeOf(import.meta);
				export const hasProto = '__proto__' in import.meta;
				export const urlDescriptor = Object.getOwnPropertyDescriptor(import.meta, 'url');
				`,
				'file.js',
				{ format: 'cjs' },
			);
			const loaded = createFsRequire(Volume.fromJSON({
				'/file.js': transformed.code,
			}))('/file.js');

			expect(loaded.meta.url).toMatch(/^file:\/\/\/.*\/file.js$/);
			expect(loaded.computed).toMatch(/^file:\/\/\/.*\/file.js$/);
			expect(loaded.destructured).toMatch(/^file:\/\/\/.*\/file.js$/);
			expect(loaded.urlDescriptor).toStrictEqual({
				configurable: true,
				enumerable: true,
				value: expect.stringMatching(/^file:\/\/\/.*\/file.js$/),
				writable: true,
			});

			// TODO: Match native Node import.meta shape without adding another
			// source-map transform pass.
			// expect(Object.getPrototypeOf(loaded.meta)).toBe(null);
			// expect(loaded.prototype).toBe(null);
			// expect(loaded.hasProto).toBe(false);
		});

		test('import.meta helper preserves source map columns', async () => {
			await using fixture = await createFixture({});
			const fileName = fixture.getPath('source-map-check.ts');
			const transformed = transformSync(
				outdent`
				export const meta = import.meta;
				const value = 'x';
				throw new Error('source-map-check');
				`,
				fileName,
				{ format: 'cjs' },
			);
			await fixture.writeFile('source-map-check.cjs', inlineSourceMap(transformed));

			const { exitCode, stderr } = await execaNode(
				fixture.getPath('source-map-check.cjs'),
				{
					nodeOptions: ['--enable-source-maps'],
					reject: false,
				},
			);
			expect(exitCode).toBe(1);
			expect(stderr).toContain(`${fileName}:3:7`);
		});

		test('dynamic import', () => {
			const dynamicImport = transformSync(
				'import((0, _url.pathToFileURL)(path).href)',
				'file.js',
				{ format: 'cjs' },
			);

			expect(dynamicImport.code).toMatch('.href).then');
		});

		test('sourcemap file', () => {
			const fileName = 'file.mts';
			const transformed = transformSync(
				fixtures.ts,
				fileName,
				{ format: 'esm' },
			);

			expect(transformed.map).not.toBe('');

			const { map } = transformed;
			if (typeof map !== 'string') {
				expect(map.sources.length).toBe(1);
				expect(map.sources[0]).toBe(fileName);
				expect(map.version).toBe(3);
				expect(map.mappings.length).toBeGreaterThan(0);
			}
		});

		test('quotes in file path', () => {
			const fileName = '\'"name.mts';
			const transformed = transformSync(
				fixtures.ts,
				fileName,
				{ format: 'esm' },
			);

			expect(transformed.map).not.toBe('');

			const { map } = transformed;
			if (typeof map !== 'string') {
				expect(map.sources.length).toBe(1);
				expect(map.sources[0]).toBe(fileName);
				expect(map.version).toBe(3);
				expect(map.mappings.length).toBeGreaterThan(0);
			}
		});
	});

	describe('async', () => {
		test('transforms TS to ESM', async () => {
			const transformed = await transform(
				fixtures.ts,
				'file.ts',
				{ format: 'esm' },
			);

			// For debuggers
			expect(transformed.code).toMatch('unusedVariable1');
			expect(transformed.code).toMatch('unusedVariable2');

			const imported = await import(base64Module(transformed.code));
			expect({ ...imported }).toStrictEqual({
				default: 'default value',
				functionName: 'named',
				named: 'named',
				url: expect.stringMatching(/^data:text\/javascript;base64,.+$/),
			});
		});

		test('sourcemap file', async () => {
			const fileName = 'file.cts';
			const transformed = await transform(
				fixtures.ts,
				fileName,
				{ format: 'esm' },
			);

			expect(transformed.map).not.toBe('');

			const { map } = transformed;
			if (typeof map !== 'string') {
				expect(map.sources.length).toBe(1);
				expect(map.sources[0]).toBe(fileName);
				expect(map.version).toBe(3);
				expect(map.mappings.length).toBeGreaterThan(0);
			}
		});
	});
});
