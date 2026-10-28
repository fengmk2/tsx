import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { NapiCli } from '@napi-rs/cli';

const { values } = parseArgs({
	options: {
		target: { type: 'string' },
		'wasm-only': { type: 'boolean' },
	},
});
if (values.target && values['wasm-only']) {
	throw new Error('Use either --target or --wasm-only.');
}

const root = fileURLToPath(new URL('../', import.meta.url));
const nativeDirectory = path.join(root, 'native/transform');
const outputDirectory = path.join(root, 'dist/native');
const wasmTarget = 'wasm32-wasip1-threads';
let targets;
if (values.target) {
	targets = [values.target];
} else if (values['wasm-only']) {
	targets = [wasmTarget];
} else {
	targets = [undefined, wasmTarget];
}

// Cargo metadata and compilation must both select this crate's pinned toolchain.
process.chdir(nativeDirectory);
// napi-build needs the real compiler path to locate Rust's WASI reactor object.
process.env.RUSTC ??= execFileSync('rustup', ['which', 'rustc'], { encoding: 'utf8' }).trim();
// A local package build must not retain other targets or manifests from an older
// assembly. Explicit target builds can accumulate artifacts for assembly.
if (!values.target && !values['wasm-only']) {
	await fs.rm(outputDirectory, {
		recursive: true,
		force: true,
	});
}
await fs.mkdir(outputDirectory, { recursive: true });
await fs.rm(path.join(root, 'dist/transform-native.node'), { force: true });
const cli = new NapiCli();
for (const target of targets) {
	const { task } = await cli.build({
		cwd: nativeDirectory,
		manifestPath: path.join(nativeDirectory, 'Cargo.toml'),
		packageJsonPath: path.join(root, 'package.json'),
		configPath: path.join(nativeDirectory, 'napi.json'),
		targetDir: path.join(nativeDirectory, 'target'),
		outputDir: outputDirectory,
		target,
		platform: true,
		jsBinding: 'index.cjs',
		release: true,
		cargoOptions: ['--locked'],
	});
	await task;
}

// This package uses the Node loader; browser glue and the duplicate debug module
// are not needed in the distributed runtime.
await Promise.all([
	'browser.js',
	'transform.wasi-browser.js',
	'wasi-worker-browser.mjs',
	'transform.wasm32-wasi.debug.wasm',
].map(file => fs.rm(path.join(outputDirectory, file), { force: true })));
