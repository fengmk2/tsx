import { fileURLToPath } from 'node:url';
import { execa, execaNode } from 'execa';

const root = fileURLToPath(new URL('../', import.meta.url));
const options = {
	cwd: root,
	stdio: 'inherit',
};
const prebuiltDirectory = process.env.TSX_PREBUILT_NATIVE_DIR;

if (prebuiltDirectory) {
	await execa('pnpm', ['build:js'], options);
	await execaNode(
		fileURLToPath(new URL('assemble-native.mjs', import.meta.url)),
		['--artifacts-dir', prebuiltDirectory],
		options,
	);
} else {
	await execa('pnpm', ['build'], options);
}

await execa('pnpm', ['exec', 'clean-pkg-json'], options);
