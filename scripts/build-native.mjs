import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const nativeDirectory = path.join(root, 'native/transform');
const targetDirectory = path.join(nativeDirectory, 'target');
const build = spawnSync('cargo', ['build', '--release', '--locked'], {
	cwd: nativeDirectory,
	env: {
		...process.env,
		CARGO_TARGET_DIR: targetDirectory,
	},
	stdio: 'inherit',
});

if (build.error) {
	throw new Error('Building the native transformer requires Cargo and rustup. See CONTRIBUTING.md.', { cause: build.error });
}
if (build.status !== 0) {
	throw new Error(`Native transformer build failed (${build.signal ?? build.status})`);
}

const libraryName = {
	darwin: 'libtsx_transform.dylib',
	win32: 'tsx_transform.dll',
}[process.platform] ?? 'libtsx_transform.so';
const dist = path.join(root, 'dist');
await fs.mkdir(dist, { recursive: true });
await fs.copyFile(path.join(targetDirectory, 'release', libraryName), path.join(dist, 'transform-native.node'));
