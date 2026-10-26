import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa, execaNode } from 'execa';
import { createFixture } from 'fs-fixture';
import { oxcBackendVersion } from '../src/utils/transform/oxc.js';

type PackedPackage = {
	name: string;
	version: string;
	filename: string;
	os?: string[];
	cpu?: string[];
	libc?: string[];
};

const packagesDirectory = process.argv[2];
assert(packagesDirectory, 'Pass the directory containing packages.json and packed tarballs');
const packages = JSON.parse(await fs.readFile(path.join(packagesDirectory, 'packages.json'), 'utf8')) as PackedPackage[];
const mainPackage = packages.find(entry => entry.name === 'tsx');
assert(mainPackage, 'The packed tsx package is required');
const nativePackages = packages.filter(entry => entry !== mainPackage);
assert(nativePackages.length > 0, 'At least one native platform package is required');
const { packageName } = JSON.parse(await fs.readFile(
	fileURLToPath(new URL('../native/transform/napi.json', import.meta.url)),
	'utf8',
)) as { packageName: string };
assert(packageName, 'The native npm package prefix is required');

const report = process.report?.getReport() as {
	header?: { glibcVersionRuntime?: string };
} | undefined;
const libc = report?.header?.glibcVersionRuntime ? 'glibc' : 'musl';
const matchesPlatform = (entry: PackedPackage) => (
	(!entry.os || entry.os.includes(process.platform))
	&& (!entry.cpu || entry.cpu.includes(process.arch))
);
const hostPackage = nativePackages.find(entry => (
	matchesPlatform(entry) && (!entry.libc || entry.libc.includes(libc))
));
assert(hostPackage, 'The packed artifacts must include the current native target');

let wasiAvailable = true;
try {
	createRequire(import.meta.url)('node:wasi');
} catch {
	wasiAvailable = false;
}

// Serve unpublished platform packages locally. Other dependencies still come
// from npm, so the installed package cannot resolve checkout files or symlinks.
const servedTarballs = new Set<string>();
const tarballs = new Map<string, {
	entry: PackedPackage;
	contents: Buffer;
	integrity: string;
}>();
for (const entry of nativePackages) {
	assert.equal(path.basename(entry.filename), entry.filename);
	const contents = await fs.readFile(path.join(packagesDirectory, entry.filename));
	tarballs.set(`/tarballs/${entry.filename}`, {
		entry,
		contents,
		integrity: `sha512-${createHash('sha512').update(contents).digest('base64')}`,
	});
}
let registryUrl: string;
const registry = createServer((request, response) => {
	const requestPath = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
	const tarball = tarballs.get(requestPath);
	if (tarball) {
		servedTarballs.add(tarball.entry.name);
		response.writeHead(200, { 'content-type': 'application/octet-stream' });
		response.end(tarball.contents);
		return;
	}
	const name = requestPath.slice(1);
	const entry = nativePackages.find(candidate => candidate.name === name);
	if (entry) {
		const artifact = tarballs.get(`/tarballs/${entry.filename}`)!;
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(JSON.stringify({
			name,
			'dist-tags': { latest: entry.version },
			versions: {
				[entry.version]: {
					...entry,
					dist: {
						tarball: `${registryUrl}/tarballs/${encodeURIComponent(entry.filename)}`,
						integrity: artifact.integrity,
					},
				},
			},
		}));
		return;
	}
	if (name.startsWith(`${packageName}-`)) {
		response.writeHead(404, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ error: 'Native target was not included in this artifact set' }));
		return;
	}
	response.writeHead(302, { location: `https://registry.npmjs.org${request.url}` });
	response.end();
});
await new Promise<void>((resolve, reject) => {
	registry.once('error', reject);
	registry.listen(0, '127.0.0.1', resolve);
});
const address = registry.address();
assert(address && typeof address !== 'string');
registryUrl = `http://127.0.0.1:${address.port}`;

const fixtureTree = {
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
	'probe.cjs': `
		const assert = require('node:assert/strict');
		const path = require('node:path');
		const { createRequire } = require('node:module');
		const { runInNewContext } = require('node:vm');
		const packageRequire = createRequire(path.resolve('node_modules/tsx/package.json'));
		const [route, expectedVersion, nativePackage] = process.argv.slice(2);
		if (route === 'esbuild' || route === 'no-wasi') {
			if (route === 'no-wasi') assert.throws(() => require('node:wasi'));
			assert.throws(() => packageRequire('#native-transform'));
			assert.throws(() => packageRequire('#wasm-transform'));
		} else {
			const binding = packageRequire('#native-transform');
			assert.equal(binding.backendVersion(), expectedVersion);
			const nativeArtifacts = Object.keys(require.cache).filter(filename => (
				path.basename(filename).startsWith('transform.') && filename.endsWith('.node')
			));
			if (route === 'native') {
				assert.deepEqual(nativeArtifacts, [packageRequire.resolve(nativePackage)], 'The native binding must load from its platform package');
			} else {
				assert.equal(nativeArtifacts.length, 0, 'WASM must run without native addons');
				assert(require.cache[packageRequire.resolve('#wasm-transform')], 'The bundled WASM wrapper must load');
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
};

type Fixture = Awaited<ReturnType<typeof createFixture>>;
const installPackage = async (fixture: Fixture, omitOptional = false) => {
	servedTarballs.clear();
	await execa('npm', [
		'install',
		// The omission case permits esbuild's existing postinstall, which obtains
		// its executable when npm omits esbuild's optional platform package too.
		...(omitOptional ? ['--omit=optional'] : ['--ignore-scripts']),
		'--omit=dev',
		'--no-audit',
		'--no-fund',
		'--package-lock=false',
		path.resolve(packagesDirectory, mainPackage.filename),
	], {
		cwd: fixture.path,
		env: {
			npm_config_registry: registryUrl,
			npm_config_cache: fixture.getPath('npm-cache'),
		},
	});
	const nativeFiles = await fixture.readdir('node_modules/tsx/dist/native');
	assert(!nativeFiles.some(name => name.endsWith('.node')), 'The main package must not contain native binaries');
	assert(!nativeFiles.includes('manifest.json'), 'The main package must not contain the build manifest');
	assert(nativeFiles.includes('transform.wasm32-wasi.wasm'), 'WASM must remain in the main package');
	const installed = await fixture.readJson<{ optionalDependencies: Record<string, string> }>('node_modules/tsx/package.json');
	for (const entry of nativePackages) {
		assert.equal(installed.optionalDependencies[entry.name], `~${mainPackage.version}`);
		const present = await fixture.exists(`node_modules/${entry.name}`);
		if (present) {
			const manifest = await fixture.readJson<PackedPackage & { main: string }>(`node_modules/${entry.name}/package.json`);
			for (const field of ['name', 'version', 'os', 'cpu', 'libc'] as const) {
				assert.deepEqual(manifest[field], entry[field], `Incorrect ${field} in ${entry.name}`);
			}
			const packageFiles = await fixture.readdir(`node_modules/${entry.name}`);
			const binaryFiles = packageFiles.filter(name => name.endsWith('.node'));
			assert.deepEqual(binaryFiles, [manifest.main], 'Each platform package must contain only its own native binary');
		}
		if (omitOptional || !matchesPlatform(entry)) {
			assert(!present, `Unexpected platform package: ${entry.name}`);
			assert(!servedTarballs.has(entry.name), `Unexpected platform download: ${entry.name}`);
		}
	}
	if (omitOptional) {
		assert.equal(servedTarballs.size, 0, 'Omitting optional dependencies must not download native binaries');
	} else {
		assert(await fixture.exists(`node_modules/${hostPackage.name}`), 'The matching native package must install');
		assert(servedTarballs.has(hostPackage.name), 'The matching native tarball must be used');
		// Older npm versions ignore libc metadata and can install both Linux ABIs.
		// Modern npm must exclude the other ABI as well as other OS/CPU targets.
		const { stdout: npmVersion } = await execa('npm', ['--version']);
		if (Number(npmVersion.split('.')[0]) >= 11) {
			assert.deepEqual([...servedTarballs], [hostPackage.name]);
		}
	}
};

const checkRoute = async (fixture: Fixture, route: string, nodeOptions: string[] = []) => {
	const { stdout } = await execaNode(fixture.getPath('probe.cjs'), [route, oxcBackendVersion, hostPackage.name], {
		cwd: fixture.path,
		nodeOptions,
	});
	assert.equal(stdout, route);
	for (const [filename, expected] of [['eligible.mts', '[42,"named"]'], ['fallback.mts', '2']]) {
		const result = await execaNode(fixture.getPath('node_modules/tsx/dist/cli.mjs'), [...nodeOptions, fixture.getPath(filename)], {
			cwd: fixture.path,
			nodeOptions,
			env: { TSX_DISABLE_CACHE: '1' },
		});
		assert.equal(result.stdout, expected, `${route}: ${filename}`);
	}
};

try {
	await using fixture = await createFixture(fixtureTree);
	await installPackage(fixture);
	await checkRoute(fixture, 'native');
	await checkRoute(fixture, wasiAvailable ? 'wasm' : 'no-wasi', ['--no-addons']);
	process.stdout.write('Packed package: native platform selection and disabled addons passed\n');

	await fixture.writeFile('record-compiler-loads.cjs', `
		const fs = require('node:fs');
		const path = require('node:path');
		const record = filename => {
			if (/^transform\\..*\\.(?:node|wasm)$/.test(path.basename(String(filename)))) {
				fs.appendFileSync(${JSON.stringify(fixture.getPath('compiler-loads'))}, String(filename) + '\\n');
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
	`);
	await fixture.mkdir('warm-cache');
	for (const warm of [false, true]) {
		const { stdout } = await execaNode(fixture.getPath('node_modules/tsx/dist/cli.mjs'), [
			'--require', fixture.getPath('record-compiler-loads.cjs'), fixture.getPath('eligible.mts'),
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
	process.stdout.write('Packed package: warm cache avoids compiler loading\n');

	for (const entry of nativePackages) {
		if (await fixture.exists(`node_modules/${entry.name}`)) {
			await fixture.rm(`node_modules/${entry.name}`);
		}
	}
	await checkRoute(fixture, wasiAvailable ? 'wasm' : 'no-wasi');
	await fixture.rm('node_modules/tsx/dist/native/transform.wasm32-wasi.wasm');
	await checkRoute(fixture, 'esbuild');
	process.stdout.write('Packed package: missing native and WASM artifacts fall back\n');

	await using withoutOptional = await createFixture(fixtureTree);
	await installPackage(withoutOptional, true);
	await checkRoute(withoutOptional, wasiAvailable ? 'wasm' : 'no-wasi');
	process.stdout.write('Packed package: omitted optional dependencies retain fallback\n');
} finally {
	registry.closeAllConnections?.();
	await new Promise<void>((resolve, reject) => {
		registry.close(error => (error ? reject(error) : resolve()));
	});
}
