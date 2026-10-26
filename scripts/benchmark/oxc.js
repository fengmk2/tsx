import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const measureTransforms = (implementations, runs, iterations) => {
	const samples = Object.fromEntries(Object.keys(implementations).map(key => [key, []]));
	for (const transform of Object.values(implementations)) {
		for (let index = 0; index < 20; index += 1) {
			transform();
		}
	}
	for (let run = 0; run < runs; run += 1) {
		const entries = Object.entries(implementations);
		if (run % 2) {
			entries.reverse();
		}
		for (const [implementation, transform] of entries) {
			const started = performance.now();
			for (let index = 0; index < iterations; index += 1) {
				transform();
			}
			samples[implementation].push(performance.now() - started);
		}
	}
	return samples;
};

const measureRuntime = async (entry, cases, runOnce, runs) => {
	const samples = Object.fromEntries(cases.map(benchmarkCase => [benchmarkCase.name, []]));
	for (const benchmarkCase of cases) {
		await runOnce(entry, benchmarkCase);
	}
	for (let run = 0; run < runs; run += 1) {
		const ordered = run % 2 ? [...cases].reverse() : cases;
		for (const benchmarkCase of ordered) {
			samples[benchmarkCase.name].push(await runOnce(entry, benchmarkCase));
		}
	}
	return samples;
};

const main = async () => {
	const { values } = parseArgs({
		options: {
			'candidate-dir': { type: 'string' },
			runs: {
				type: 'string',
				default: '5',
			},
			modules: {
				type: 'string',
				default: '300',
			},
			iterations: {
				type: 'string',
				default: '200',
			},
			help: { type: 'boolean' },
		},
	});

	if (values.help) {
		process.stdout.write('node scripts/benchmark/oxc.js --candidate-dir <external npm install> [--runs 5] [--modules 300] [--iterations 200]\n');
		return;
	}

	if (!values['candidate-dir']) {
		throw new Error('--candidate-dir must contain an external install of oxc-transform and @oxc-node/core');
	}

	const positiveInteger = (name) => {
		const value = Number(values[name]);
		if (!Number.isSafeInteger(value) || value < 1) {
			throw new Error(`--${name} must be a positive integer`);
		}
		return value;
	};

	const runs = positiveInteger('runs');
	const modules = positiveInteger('modules');
	const iterations = positiveInteger('iterations');
	const candidateRequire = createRequire(path.join(path.resolve(values['candidate-dir']), 'package.json'));
	const require = createRequire(import.meta.url);
	const esbuild = require('esbuild');
	const oxc = await import(pathToFileURL(candidateRequire.resolve('oxc-transform')).href);
	const loader = fileURLToPath(new URL('../../dist/loader.mjs', import.meta.url));
	const oxcLoader = path.join(path.dirname(candidateRequire.resolve('@oxc-node/core/package.json')), 'register.mjs');
	await fs.access(loader);

	const median = (samples) => {
		const sorted = [...samples].sort((left, right) => left - right);
		const middle = Math.floor(sorted.length / 2);
		return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
	};

	const summarize = samples => ({
		medianMs: median(samples),
		minMs: Math.min(...samples),
		samplesMs: samples,
	});
	const summarizeAll = samples => Object.fromEntries(
		Object.entries(samples).map(([key, timings]) => [key, summarize(timings)]),
	);

	const esbuildOptions = {
		loader: 'ts',
		sourcefile: '/benchmark/source.ts',
		target: `node${process.versions.node}`,
		sourcemap: true,
		sourcesContent: false,
		minifyWhitespace: true,
		keepNames: true,
	};
	const oxcOptions = {
		lang: 'ts',
		sourceType: 'module',
		target: esbuildOptions.target,
		sourcemap: true,
	};

	const esbuildTransform = (source, options) => {
		const result = esbuild.transformSync(source, options);
		result.map = JSON.parse(result.map);
		return result;
	};

	const oxcTransform = (source) => {
		const result = oxc.transformSync(esbuildOptions.sourcefile, source, oxcOptions);
		assert.deepEqual(result.errors, []);
		assert.ok(result.map);
		delete result.map.sourcesContent;
		return result;
	};

	// The second pass must compose maps, not just perform module conversion.
	// esbuild consumes the Oxc input map through the inline sourceMappingURL.
	const twoPassTransform = (source) => {
		const result = oxcTransform(source);
		const inputMap = Buffer.from(JSON.stringify(result.map)).toString('base64');
		return esbuildTransform(
			`${result.code}\n//# sourceMappingURL=data:application/json;base64,${inputMap}`,
			{
				...esbuildOptions,
				loader: 'js',
				format: 'cjs',
			},
		);
	};

	const transformResults = [];
	const sources = {
		small: "import { value as v0 } from './dependency.ts';\ntype Value = number;\nexport const value: Value = v0 + 1;\n",
		large: Array.from(
			{ length: 100 },
			(_, index) => `export function value${index}(x: number): { value: number } { const n: number = x + ${index}; return { value: n }; }`,
		).join('\n'),
	};

	for (const [name, source] of Object.entries(sources)) {
		const implementations = {
			'esbuild-esm': () => esbuildTransform(source, {
				...esbuildOptions,
				format: 'esm',
			}),
			'oxc-esm': () => oxcTransform(source),
			'esbuild-cjs': () => esbuildTransform(source, {
				...esbuildOptions,
				format: 'cjs',
			}),
			'oxc-then-esbuild-cjs': () => twoPassTransform(source),
		};
		const samples = measureTransforms(implementations, runs, iterations);
		transformResults.push({
			name,
			bytes: Buffer.byteLength(source),
			iterations,
			results: summarizeAll(samples),
		});
	}

	esbuild.stop();

	const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'tsx-oxc-benchmark-'));
	const runtimeResults = [];

	try {
		const projectDirectory = path.join(temporaryDirectory, 'project');
		await fs.mkdir(projectDirectory);
		await fs.writeFile(
			path.join(projectDirectory, 'package.json'),
			JSON.stringify({ type: 'module' }),
		);
		await fs.writeFile(path.join(projectDirectory, 'tsconfig.json'), JSON.stringify({
			compilerOptions: {
				module: 'ESNext',
				moduleResolution: 'Bundler',
			},
		}));
		let leaves = 0;
		for (let index = 0; index < modules; index += 1) {
			const children = [index * 3 + 1, index * 3 + 2, index * 3 + 3].filter(
				child => child < modules,
			);
			if (children.length === 0) {
				leaves += 1;
			}
			const imports = children.map((child, position) => `import { value as v${position} } from './module-${child}.ts';`).join('\n');
			const value = children.length > 0 ? children.map((_, position) => `v${position}`).join(' + ') : '1';
			await fs.writeFile(path.join(projectDirectory, `module-${index}.ts`), `${imports}\ntype Value = number;\nexport const value: Value = ${value};\n`);
		}
		const entries = {
			empty: path.join(projectDirectory, 'empty.mjs'),
			'esm-tree': path.join(projectDirectory, 'main.ts'),
		};
		await fs.writeFile(entries.empty, "console.log('ready');\n");
		await fs.writeFile(entries['esm-tree'], "import { value } from './module-0.ts';\nconsole.log(value);\n");

		const cases = [
			{
				name: 'tsx-warm',
				loader,
				resetCache: false,
				disableCache: false,
			},
			{
				name: 'tsx-cold',
				loader,
				resetCache: true,
				disableCache: false,
			},
			{
				name: 'tsx-no-cache',
				loader,
				resetCache: false,
				disableCache: true,
			},
			{
				name: 'oxc-node',
				loader: oxcLoader,
				resetCache: false,
				disableCache: false,
			},
		];
		const environment = { ...process.env };
		delete environment.NODE_OPTIONS;
		delete environment.TSX_DISABLE_CACHE;
		delete environment.TSX_TSCONFIG_PATH;
		delete environment.OXC_TSCONFIG_PATH;
		delete environment.OXC_TRANSFORM_ALL;
		delete environment.TS_NODE_PROJECT;

		const runOnce = async (entry, benchmarkCase) => {
			const cacheDirectory = path.join(temporaryDirectory, benchmarkCase.name);
			if (benchmarkCase.resetCache) {
				await fs.rm(cacheDirectory, {
					recursive: true,
					force: true,
				});
			}
			await fs.mkdir(cacheDirectory, { recursive: true });
			const started = performance.now();
			const child = spawnSync(process.execPath, ['--import', pathToFileURL(benchmarkCase.loader).href, entry], {
				cwd: projectDirectory,
				env: {
					...environment,
					TMPDIR: cacheDirectory,
					TEMP: cacheDirectory,
					TMP: cacheDirectory,
					...(benchmarkCase.disableCache ? { TSX_DISABLE_CACHE: '1' } : {}),
				},
				encoding: 'utf8',
				timeout: 60_000,
			});
			const elapsed = performance.now() - started;
			assert.ifError(child.error);
			assert.equal(child.status, 0, child.stderr);
			assert.equal(child.stdout.trim(), entry === entries.empty ? 'ready' : String(leaves));
			return elapsed;
		};

		for (const [scenario, entry] of Object.entries(entries)) {
			const samples = await measureRuntime(entry, cases, runOnce, runs);
			runtimeResults.push({
				scenario,
				modules: scenario === 'empty' ? 0 : modules,
				results: summarizeAll(samples),
			});
		}
	} finally {
		await fs.rm(temporaryDirectory, {
			recursive: true,
			force: true,
		});
	}

	process.stdout.write(`${JSON.stringify({
		metadata: {
			node: process.version,
			platform: process.platform,
			arch: process.arch,
			cpu: os.cpus()[0]?.model,
			esbuild: esbuild.version,
			oxcTransform: candidateRequire('oxc-transform/package.json').version,
			oxcNode: candidateRequire('@oxc-node/core/package.json').version,
			runs,
			limitations: [
				'Synthetic measurements are not evidence of semantic compatibility.',
				'Runtime measurements compare --import hooks, not CLI wrappers.',
				'Oxc-only ESM does not implement all tsx transform semantics.',
				'Two-pass CommonJS composes source maps; it does not prove semantic equivalence.',
			],
		},
		transforms: transformResults,
		runtime: runtimeResults,
	}, null, 2)}\n`);
};

await main();
