import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { execa, execaNode } from 'execa';
import { createFixture } from 'fs-fixture';
import { oxcBackendVersion } from '../src/utils/transform/oxc.js';

const tarball = process.argv[2];
assert(tarball, 'Pass the path to the packed tsx tarball');

let wasiAvailable = true;
try {
	createRequire(import.meta.url)('node:wasi');
} catch {
	wasiAvailable = false;
}

await using fixture = await createFixture({
	'package.json': JSON.stringify({
		private: true,
		type: 'module',
	}),
	'eligible.mts': `
		export const named = (value: number) => value + 1;
		console.log(JSON.stringify([named(41), named.name]));
	`,
	'fallback.mts': `
		namespace Counter {
			export let value = 1;
			export function increment() { value += 1; }
		}
		Counter.increment();
		console.log(Counter.value);
	`,
	'record-compiler-loads.cjs': ({ getPath }) => `
		const fs = require('node:fs');
		const path = require('node:path');
		const record = filename => {
			if (/^transform\\..*\\.(?:node|wasm)$/.test(path.basename(String(filename)))) {
				fs.appendFileSync(${JSON.stringify(getPath('compiler-loads'))}, String(filename) + '\\n');
			}
		};
		const dlopen = process.dlopen;
		process.dlopen = function(module, filename, ...arguments_) {
			record(filename);
			return dlopen.call(this, module, filename, ...arguments_);
		};
		const readFileSync = fs.readFileSync;
		fs.readFileSync = function(filename, ...arguments_) {
			record(filename);
			return readFileSync.call(this, filename, ...arguments_);
		};
	`,
	'probe.cjs': `
		const assert = require('node:assert/strict');
		const path = require('node:path');
		const { createRequire } = require('node:module');
		const { runInNewContext } = require('node:vm');
		const packageRequire = createRequire(path.resolve('node_modules/tsx/package.json'));
		const [route, expectedVersion] = process.argv.slice(2);
		if (route === 'esbuild' || route === 'no-wasi') {
			if (route === 'no-wasi') {
				assert.throws(() => require('node:wasi'));
			}
			assert.throws(() => packageRequire('#native-transform'));
			assert.throws(() => packageRequire('#wasm-transform'));
		} else {
			const binding = packageRequire('#native-transform');
			assert.equal(binding.backendVersion(), expectedVersion);
			const nativeArtifacts = Object.keys(require.cache).filter(filename => (
				path.basename(filename).startsWith('transform.') && filename.endsWith('.node')
			));
			if (route === 'native') {
				assert.equal(nativeArtifacts.length, 1, 'The packed host native artifact must load');
			} else {
				assert.equal(nativeArtifacts.length, 0, 'WASM must run without native addons');
				assert(require.cache[packageRequire.resolve('#wasm-transform')], 'The packed WASM wrapper must load');
			}
			const source = 'const named = (value: number) => value + 1; module.exports = [named(41), named.name];';
			const filename = path.resolve('packed-source.cts');
			const options = JSON.stringify({
				target: 'node' + process.versions.node,
				lang: 'ts',
				sourceType: 'commonjs',
				sourceMap: true,
				onlyRemoveTypeImports: false,
				useDefineForClassFields: true,
			});
			const transformed = binding.transformSync(filename, source, options);
			assert(transformed, 'The selected compiler must accept eligible TypeScript');
			const module = { exports: undefined };
			runInNewContext(transformed.code, { module });
			assert.deepEqual(Array.from(module.exports), [42, 'named']);
			const map = JSON.parse(transformed.map);
			assert.deepEqual(map.sources, [filename]);
			assert.deepEqual(map.sourcesContent, [source]);
			assert.equal(binding.transformSync(filename, 'namespace Counter { export let value = 1; }', options), null);
		}
		console.log(route);
	`,
});

// Install the tarball into its own dependency tree. None of these processes can
// resolve the checkout's compiler artifacts or runtime dependencies.
await execa('npm', [
	'install',
	'--ignore-scripts',
	'--omit=dev',
	'--no-audit',
	'--no-fund',
	'--package-lock=false',
	path.resolve(tarball),
], { cwd: fixture.path });

const cliPath = fixture.getPath('node_modules/tsx/dist/cli.mjs');
for (const route of ['native', wasiAvailable ? 'wasm' : 'no-wasi', 'esbuild']) {
	if (route === 'esbuild') {
		// Remove only files from the installed tarball, never checkout artifacts.
		const nativeDirectory = 'node_modules/tsx/dist/native';
		for (const filename of await fixture.readdir(nativeDirectory)) {
			if (filename.endsWith('.node') || filename.endsWith('.wasm')) {
				await fixture.rm(`${nativeDirectory}/${filename}`);
			}
		}
	}
	const nodeOptions = route === 'wasm' || route === 'no-wasi' ? ['--no-addons'] : [];
	const { stdout: selectedRoute } = await execaNode(fixture.getPath('probe.cjs'), [route, oxcBackendVersion], {
		cwd: fixture.path,
		nodeOptions,
	});
	assert.equal(selectedRoute, route);
	for (const [filename, expected] of [
		['eligible.mts', '[42,"named"]'],
		['fallback.mts', '2'],
	]) {
		const { stdout } = await execaNode(cliPath, [...nodeOptions, fixture.getPath(filename)], {
			cwd: fixture.path,
			nodeOptions,
			env: { TSX_DISABLE_CACHE: '1' },
		});
		assert.equal(stdout, expected, `${route}: ${filename}`);
	}
	if (route === 'native') {
		await fixture.mkdir('warm-cache');
		for (const warm of [false, true]) {
			const { stdout } = await execaNode(cliPath, [
				'--require',
				fixture.getPath('record-compiler-loads.cjs'),
				fixture.getPath('eligible.mts'),
			], {
				cwd: fixture.path,
				nodeOptions: [],
				env: {
					TSX_DISABLE_CACHE: undefined,
					TMPDIR: fixture.getPath('warm-cache'),
					TEMP: fixture.getPath('warm-cache'),
					TMP: fixture.getPath('warm-cache'),
				},
			});
			assert.equal(stdout, '[42,"named"]');
			assert.equal(await fixture.exists('compiler-loads'), !warm, 'Only the cold process must load a compiler artifact');
			if (!warm) {
				await fixture.rm('compiler-loads');
			}
		}
	}
	process.stdout.write(`Packed package: ${route} passed\n`);
}
