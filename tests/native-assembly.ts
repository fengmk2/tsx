import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test, expect } from 'manten';
import { createFixture, type FileTree } from 'fs-fixture';
import { execaNode } from 'execa';
import { parseTriple } from '@napi-rs/cli';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(await fs.readFile(path.join(root, 'native/transform/napi.json'), 'utf8')) as {
	binaryName: string;
	targets: string[];
};
const tree: FileTree = Object.fromEntries(await Promise.all([
	'scripts/assemble-native.mjs',
	'scripts/build-native.mjs',
	'package.json',
	'pnpm-lock.yaml',
	'native/transform/Cargo.toml',
	'native/transform/Cargo.lock',
	'native/transform/build.rs',
	'native/transform/rust-toolchain.toml',
	'native/transform/napi.json',
].map(async name => [name, await fs.readFile(path.join(root, name), 'utf8')])));
tree.node_modules = ({ symlink }) => symlink(path.join(root, 'node_modules'));
tree['keep/sentinel.txt'] = 'user data';

for (const target of config.targets) {
	const directory = `raw/native-build-${target}`;
	const { platform, platformArchABI } = parseTriple(target);
	const extension = platform === 'wasi' ? 'wasm' : 'node';
	tree[`${directory}/index.cjs`] = 'shared loader';
	tree[`${directory}/index.d.ts`] = 'shared declarations';
	tree[`${directory}/${config.binaryName}.${platformArchABI}.${extension}`] = `artifact for ${target}`;
	if (platform === 'wasi') {
		tree[`${directory}/${config.binaryName}.wasi.cjs`] = 'wasm loader';
		tree[`${directory}/wasi-worker.mjs`] = 'wasm worker';
	}
}

const createArtifacts = async () => {
	const fixture = await createFixture(tree);
	try {
		await fs.cp(
			path.join(root, 'native/transform/src'),
			fixture.getPath('native/transform/src'),
			{ recursive: true },
		);
		return fixture;
	} catch (error) {
		await fixture.rm();
		throw error;
	}
};

type Fixture = Awaited<ReturnType<typeof createArtifacts>>;
const assemble = (
	fixture: Fixture,
	input: string,
	output?: string,
) => execaNode(fixture.getPath('scripts/assemble-native.mjs'), [
	'--artifacts-dir',
	fixture.getPath(input),
	...(output ? ['--output-dir', fixture.getPath(output)] : []),
], { reject: false });

await describe('native artifact assembly', () => {
	test('assembles all targets and repeatedly replaces its owned output', async () => {
		await using fixture = await createArtifacts();
		const first = await assemble(fixture, 'raw', 'assembled');
		expect(first.exitCode).toBe(0);
		const manifest = await fixture.readJson<{
			targets: string[];
			files: Record<string, unknown>;
		}>('assembled/manifest.json');
		expect(manifest.targets).toStrictEqual(config.targets);
		expect(Object.keys(manifest.files)).toContain('transform.wasm32-wasi.wasm');
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const result = await assemble(fixture, 'assembled');
			expect(result.exitCode).toBe(0);
			expect(await fixture.readJson('dist/native/manifest.json')).toStrictEqual(manifest);
		}
		expect(await fixture.readdir('dist')).toStrictEqual(['native']);
	});

	const cases: {
		name: string;
		input: string;
		message: string;
		change: (fixture: Fixture) => Promise<unknown>;
	}[] = [
		{
			name: 'corrupted binary',
			input: 'assembled',
			message: 'Artifact checksum mismatch',
			change: fixture => fixture.writeFile('assembled/transform.darwin-x64.node', 'corrupt'),
		},
		{
			name: 'stale source',
			input: 'assembled',
			message: 'Native artifacts do not match the current source',
			change: async (fixture) => {
				const manifest = await fixture.readJson<Record<string, unknown>>('assembled/manifest.json');
				await fixture.writeJson('assembled/manifest.json', {
					...manifest,
					sourceHash: 'stale',
				});
			},
		},
		{
			name: 'missing target binary',
			input: 'raw',
			message: 'Missing files for',
			change: fixture => fixture.rm('raw/native-build-x86_64-apple-darwin/transform.darwin-x64.node'),
		},
		{
			name: 'conflicting generated loader',
			input: 'raw',
			message: 'Conflicting artifact file',
			change: fixture => fixture.writeFile('raw/native-build-x86_64-apple-darwin/index.cjs', 'different loader'),
		},
		{
			name: 'incomplete configured target set',
			input: 'assembled',
			message: 'Native artifacts do not match the configured targets',
			change: async (fixture) => {
				const manifest = await fixture.readJson<Record<string, unknown>>('assembled/manifest.json');
				await fixture.writeJson('assembled/manifest.json', {
					...manifest,
					targets: [],
				});
			},
		},
	];
	for (const check of cases) {
		test(`rejects ${check.name} before writing output`, async () => {
			await using fixture = await createArtifacts();
			const setup = await assemble(fixture, 'raw', 'assembled');
			expect(setup.exitCode).toBe(0);
			await check.change(fixture);
			const result = await assemble(fixture, check.input, 'rejected');
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain(check.message);
			expect(await fixture.exists('rejected')).toBe(false);
		});
	}

	test('does not replace a nonempty custom output directory', async () => {
		await using fixture = await createArtifacts();
		const result = await assemble(fixture, 'raw', 'keep');
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('Output directory must be empty');
		expect(await fixture.readFile('keep/sentinel.txt', 'utf8')).toBe('user data');
	});
});
