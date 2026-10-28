import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createFixture, type FileTree } from 'fs-fixture';
import { execa } from 'execa';

// Keep candidate dependencies outside tsx: this evaluates a replacement without
// changing the package being used as the compatibility reference.
const { values } = parseArgs({
	options: {
		'candidate-dir': { type: 'string' },
	},
});
assert(values['candidate-dir'], 'Pass --candidate-dir pointing to an installation of @oxc-node/core');
const candidateRequire = createRequire(path.resolve(values['candidate-dir'], 'package.json'));
const candidateManifestPath = candidateRequire.resolve('@oxc-node/core/package.json');
const candidateManifest = JSON.parse(await fs.readFile(candidateManifestPath, 'utf8'));
const registerExport = candidateManifest.exports['./register'];
const registerPath = typeof registerExport === 'string' ? registerExport : registerExport.import;
assert.equal(typeof registerPath, 'string', 'Candidate must export an ESM register entry');
const root = fileURLToPath(new URL('../', import.meta.url));
const loaders = {
	tsx: pathToFileURL(path.join(root, 'dist/loader.mjs')).href,
	oxc: pathToFileURL(path.resolve(path.dirname(candidateManifestPath), registerPath)).href,
};

type Probe = {
	name: string;
	entry: string;
	source: string;
	expected: string;
	files?: FileTree;
};

const probes: Probe[] = [
	{
		name: 'ESM TypeScript control',
		entry: 'main.mts',
		source: 'export const value: number = 42; console.log(value);',
		expected: '42',
	},
	{
		name: 'ESM syntax in .cts',
		entry: 'main.cts',
		source: `
			import { basename } from 'node:path';
			export const value: string = basename('/a/file.ts');
			console.log(value);
		`,
		expected: 'file.ts',
	},
	{
		name: 'Stage 3 decorators',
		entry: 'main.mts',
		source: `
			function double(method, context) {
				return function () { return method.call(this) * 2; };
			}
			class Example {
				@double
				value() { return 21; }
			}
			console.log(new Example().value());
		`,
		expected: '42',
	},
	{
		name: 'Mutable namespace exports',
		entry: 'main.mts',
		source: `
			namespace State {
				export let value = 41;
				export function increment() { value += 1; }
			}
			State.increment();
			console.log(State.value);
		`,
		expected: '42',
	},
	{
		name: 'export = assignment timing',
		entry: 'main.cts',
		source: `
			const original = module.exports;
			export = { value: 42 };
			console.log(original === module.exports);
		`,
		expected: 'true',
	},
	{
		name: 'TypeScript dependencies by default',
		entry: 'main.mts',
		source: "import { value } from 'typed-dependency'; console.log(value);",
		expected: '42',
		files: {
			'node_modules/typed-dependency/package.json': JSON.stringify({
				name: 'typed-dependency',
				type: 'module',
				exports: './index.ts',
			}),
			'node_modules/typed-dependency/index.ts': 'export const value: number = 42;',
		},
	},
];

const results = [];
for (const probe of probes) {
	await using fixture = await createFixture({
		'package.json': JSON.stringify({ private: true }),
		// Prevent ancestor tsconfig discovery from changing the experiment.
		'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ESNext' } }),
		...probe.files,
		[probe.entry]: probe.source,
	});
	const observations: Record<string, {
		exitCode?: number;
		stdout: string;
		stderr: string;
	}> = {};
	for (const [name, loader] of Object.entries(loaders)) {
		const result = await execa(process.execPath, ['--import', loader, fixture.getPath(probe.entry)], {
			cwd: fixture.path,
			reject: false,
			timeout: 15_000,
			env: {
				NODE_OPTIONS: undefined,
				TSX_DISABLE_CACHE: '1',
				TSX_TSCONFIG_PATH: undefined,
				OXC_TSCONFIG_PATH: undefined,
				OXC_TRANSFORM_ALL: undefined,
				TS_NODE_PROJECT: undefined,
			},
		});
		assert(!result.timedOut && !result.signal, `${name}: ${probe.name} did not finish`);
		observations[name] = {
			exitCode: result.exitCode,
			stdout: result.stdout,
			stderr: result.stderr.replaceAll(fixture.path, '<fixture>'),
		};
	}
	assert.equal(observations.tsx.exitCode, 0, `${probe.name}: reference failed\n${observations.tsx.stderr}`);
	assert.equal(observations.tsx.stdout, probe.expected, `${probe.name}: reference behavior changed`);
	results.push({
		name: probe.name,
		expected: probe.expected,
		compatible: observations.oxc.exitCode === 0 && observations.oxc.stdout === probe.expected,
		observations,
	});
}

process.stdout.write(`${JSON.stringify({
	node: process.version,
	platform: process.platform,
	arch: process.arch,
	candidate: {
		name: candidateManifest.name,
		version: candidateManifest.version,
	},
	// A passing finite probe set is not proof of full compatibility.
	status: results.every(result => result.compatible) ? 'no blockers found by these probes' : 'incompatible',
	results,
}, null, 2)}\n`);
