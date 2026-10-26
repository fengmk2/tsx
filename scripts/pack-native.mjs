import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execa } from 'execa';
import { parseTriple } from '@napi-rs/cli';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(await fs.readFile(path.join(root, 'native/transform/napi.json'), 'utf8'));
const { values } = parseArgs({
	options: {
		'output-dir': { type: 'string' },
	},
});
assert(values['output-dir'], 'Pass --output-dir for the packed packages');
const outputDirectory = path.resolve(values['output-dir']);
await fs.mkdir(path.dirname(outputDirectory), { recursive: true });
try {
	await fs.access(outputDirectory);
	throw new Error(`Output directory already exists: ${outputDirectory}`);
} catch (error) {
	if (error.code !== 'ENOENT') {
		throw error;
	}
}

const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const packages = [{
	directory: root,
	metadata: packageJson,
}];
for (const target of config.targets) {
	const { platform, platformArchABI } = parseTriple(target);
	if (platform === 'wasi') {
		continue;
	}
	const directory = path.join(root, 'npm', platformArchABI);
	const metadata = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
	assert.equal(metadata.name, `${config.packageName ?? packageJson.name}-${platformArchABI}`);
	assert.equal(metadata.version, packageJson.version, `Stale package version: ${metadata.name}`);
	assert.equal(packageJson.optionalDependencies[metadata.name], `~${metadata.version}`);
	try {
		const binary = await fs.stat(path.join(directory, metadata.main));
		assert(binary.isFile() && binary.size > 0, `Empty native binary: ${metadata.name}`);
	} catch (error) {
		if (error.code === 'ENOENT') {
			// A local host build produces one native package. CI and releases
			// call prepare-native-packages --require-all before packing.
			continue;
		}
		throw error;
	}
	packages.push({
		directory,
		metadata,
	});
}

const stagingDirectory = await fs.mkdtemp(path.join(path.dirname(outputDirectory), '.native-packs-'));
try {
	const index = [];
	for (const { directory, metadata } of packages) {
		const { stdout } = await execa('npm', [
			'pack',
			'--ignore-scripts',
			'--json',
			'--pack-destination',
			stagingDirectory,
		], { cwd: directory });
		const [packed] = JSON.parse(stdout);
		assert.equal(packed.name, metadata.name);
		assert.equal(packed.version, metadata.version);
		const nativeFiles = packed.files.filter(file => file.path.endsWith('.node'));
		if (directory === root) {
			assert.equal(nativeFiles.length, 0, 'The main package must not contain native binaries');
			for (const filename of ['index.cjs', `${config.binaryName}.wasi.cjs`, `${config.binaryName}.wasm32-wasi.wasm`, 'wasi-worker.mjs']) {
				assert(packed.files.some(file => file.path === `dist/native/${filename}`), `Missing main package file: ${filename}`);
			}
		} else {
			assert.deepEqual(nativeFiles.map(file => file.path), [metadata.main]);
		}
		index.push({
			name: metadata.name,
			version: metadata.version,
			filename: packed.filename,
			os: metadata.os,
			cpu: metadata.cpu,
			libc: metadata.libc,
		});
		process.stdout.write(`${metadata.name}: ${packed.size} bytes packed, ${packed.unpackedSize} bytes unpacked\n`);
	}
	await fs.writeFile(path.join(stagingDirectory, 'packages.json'), `${JSON.stringify(index, null, '\t')}\n`);
	await fs.rename(stagingDirectory, outputDirectory);
} finally {
	await fs.rm(stagingDirectory, {
		recursive: true,
		force: true,
	});
}
