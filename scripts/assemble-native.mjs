import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseTriple } from '@napi-rs/cli';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(await fs.readFile(path.join(root, 'native/transform/napi.json'), 'utf8'));

const sourceFiles = async (directory) => {
	const files = [];
	for (const entry of await fs.readdir(path.join(root, directory), { withFileTypes: true })) {
		const name = `${directory}/${entry.name}`;
		if (entry.isDirectory()) {
			files.push(...await sourceFiles(name));
		} else {
			assert(entry.isFile(), `Unexpected native source entry: ${name}`);
			files.push(name);
		}
	}
	return files;
};

// A prebuilt package must come from the same native source and build configuration.
// Exclude package.json: semantic-release changes its version before prepack.
const sourceHash = createHash('sha256');
const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
sourceHash.update(JSON.stringify({
	name: packageJson.name,
	napiCli: packageJson.devDependencies['@napi-rs/cli'],
	wasmRuntime: packageJson.dependencies['@napi-rs/wasm-runtime'],
	emnapiCore: packageJson.dependencies['@emnapi/core'],
	emnapiRuntime: packageJson.dependencies['@emnapi/runtime'],
}));
for (const name of [
	'native/transform/Cargo.toml',
	'native/transform/Cargo.lock',
	'native/transform/build.rs',
	'native/transform/rust-toolchain.toml',
	'native/transform/napi.json',
	'scripts/build-native.mjs',
	'pnpm-lock.yaml',
	...await sourceFiles('native/transform/src'),
].sort()) {
	sourceHash.update(`${name}\0`).update(await fs.readFile(path.join(root, name))).update('\0');
}
const expectedSourceHash = sourceHash.digest('hex');

const readArtifactFile = async (source) => {
	const contents = await fs.readFile(source);
	assert(contents.length > 0, `Empty artifact file: ${source}`);
	return {
		source,
		sha256: createHash('sha256').update(contents).digest('hex'),
		bytes: contents.length,
	};
};

const requiredFiles = (target) => {
	const { platform, platformArchABI } = parseTriple(target);
	return [
		'index.cjs',
		'index.d.ts',
		`${config.binaryName}.${platformArchABI}.${platform === 'wasi' ? 'wasm' : 'node'}`,
		...(platform === 'wasi' ? [`${config.binaryName}.wasi.cjs`, 'wasi-worker.mjs'] : []),
	];
};

const readRawArtifacts = async (inputDirectory) => {
	const files = new Map();
	for (const target of config.targets) {
		const artifactDirectory = path.join(inputDirectory, `native-build-${target}`);
		const entries = await fs.readdir(artifactDirectory, { withFileTypes: true });
		const required = new Set(requiredFiles(target));
		for (const entry of entries) {
			assert(entry.isFile(), `Unexpected non-file in ${artifactDirectory}: ${entry.name}`);
			assert(entry.name !== 'manifest.json', 'The assembly step owns manifest.json');
			const file = await readArtifactFile(path.join(artifactDirectory, entry.name));
			const previous = files.get(entry.name);
			assert(!previous || previous.sha256 === file.sha256, `Conflicting artifact file: ${entry.name}`);
			files.set(entry.name, file);
			required.delete(entry.name);
		}
		assert.equal(required.size, 0, `Missing files for ${target}: ${[...required].join(', ')}`);
	}
	return files;
};

const readAssembledArtifacts = async (inputDirectory) => {
	const manifest = JSON.parse(await fs.readFile(path.join(inputDirectory, 'manifest.json'), 'utf8'));
	assert.equal(manifest.format, 1, 'Unsupported native artifact manifest');
	assert.equal(manifest.sourceHash, expectedSourceHash, 'Native artifacts do not match the current source');
	assert.deepEqual(manifest.targets, config.targets, 'Native artifacts do not match the configured targets');
	const files = new Map();
	for (const entry of await fs.readdir(inputDirectory, { withFileTypes: true })) {
		assert(entry.isFile(), `Unexpected non-file in ${inputDirectory}: ${entry.name}`);
		if (entry.name === 'manifest.json') {
			continue;
		}
		const file = await readArtifactFile(path.join(inputDirectory, entry.name));
		assert.equal(file.sha256, manifest.files[entry.name]?.sha256, `Artifact checksum mismatch: ${entry.name}`);
		assert.equal(file.bytes, manifest.files[entry.name]?.bytes, `Artifact size mismatch: ${entry.name}`);
		files.set(entry.name, file);
	}
	assert.equal(files.size, Object.keys(manifest.files).length, 'Artifact files are missing');
	return files;
};

const { values } = parseArgs({
	options: {
		'artifacts-dir': { type: 'string' },
		'output-dir': { type: 'string' },
	},
});
assert(values['artifacts-dir'], 'Pass --artifacts-dir containing target directories or an assembled artifact');
const inputDirectory = path.resolve(values['artifacts-dir']);
const outputDirectory = path.resolve(values['output-dir'] ?? path.join(root, 'dist/native'));
const inputFiles = await fs.readdir(inputDirectory);
const files = inputFiles.includes('manifest.json')
	? await readAssembledArtifacts(inputDirectory)
	: await readRawArtifacts(inputDirectory);

for (const target of config.targets) {
	for (const name of requiredFiles(target)) {
		assert(files.has(name), `Missing file for ${target}: ${name}`);
	}
}

const manifest = {
	format: 1,
	sourceHash: expectedSourceHash,
	targets: config.targets,
	files: {},
};
const outputParent = path.dirname(outputDirectory);
await fs.mkdir(outputParent, { recursive: true });
const stagingDirectory = await fs.mkdtemp(path.join(outputParent, '.native-assembly-'));
const backupDirectory = `${stagingDirectory}-previous`;
try {
	const sortedFiles = [...files.entries()].sort(([left], [right]) => left.localeCompare(right));
	for (const [name, file] of sortedFiles) {
		await fs.copyFile(file.source, path.join(stagingDirectory, name), fs.constants.COPYFILE_EXCL);
		manifest.files[name] = {
			sha256: file.sha256,
			bytes: file.bytes,
		};
	}
	await fs.writeFile(
		path.join(stagingDirectory, 'manifest.json'),
		`${JSON.stringify(manifest, null, '\t')}\n`,
		{ flag: 'wx' },
	);

	// Replace only tsx's generated directory. Custom outputs cannot overwrite files.
	let previousOutput = false;
	try {
		if (outputDirectory !== path.join(root, 'dist/native')) {
			const outputFiles = await fs.readdir(outputDirectory);
			assert.equal(outputFiles.length, 0, `Output directory must be empty: ${outputDirectory}`);
		}
		await fs.rename(outputDirectory, backupDirectory);
		previousOutput = true;
	} catch (error) {
		if (error.code !== 'ENOENT') {
			throw error;
		}
	}
	try {
		await fs.rename(stagingDirectory, outputDirectory);
	} catch (error) {
		if (previousOutput) {
			await fs.rename(backupDirectory, outputDirectory);
		}
		throw error;
	}
	if (previousOutput) {
		await fs.rm(backupDirectory, { recursive: true });
	}
} finally {
	await fs.rm(stagingDirectory, {
		recursive: true,
		force: true,
	});
}
process.stdout.write(`Assembled ${files.size} files for ${config.targets.length} targets in ${outputDirectory}\n`);
