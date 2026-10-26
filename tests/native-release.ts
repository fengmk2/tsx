import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, test, expect } from 'manten';
import { createFixture } from 'fs-fixture';
import { execaNode } from 'execa';

const packageName = '@fixture/tsx-native';
const version = '1.2.3';
const targets = [
	['x86_64-apple-darwin', 'darwin-x64'],
	['aarch64-apple-darwin', 'darwin-arm64'],
	['x86_64-pc-windows-msvc', 'win32-x64-msvc'],
];

const createRelease = async () => {
	const fixture = await createFixture({
		'package.json': JSON.stringify({
			name: 'fixture-main',
			version,
			type: 'module',
			optionalDependencies: Object.fromEntries(targets.map(([, platform]) => [`${packageName}-${platform}`, `~${version}`])),
		}),
		'native/transform/napi.json': JSON.stringify({
			packageName,
			binaryName: 'transform',
			targets: [...targets.map(([target]) => target), 'wasm32-wasip1-threads'],
		}),
		'scripts/prepare-package.mjs': `
			import fs from 'node:fs';
			fs.appendFileSync('events.jsonl', JSON.stringify({ step: 'prepare' }) + '\\n');
		`,
		'bin/package.json': JSON.stringify({ type: 'commonjs' }),
		'bin/npm': `#!/usr/bin/env node
			const fs = require('node:fs');
			const path = require('node:path');
			const args = process.argv.slice(2);
			const pkg = JSON.parse(fs.readFileSync(path.join(args[1], 'package.json'), 'utf8'));
			fs.appendFileSync(path.join(process.env.FIXTURE_ROOT, 'events.jsonl'), JSON.stringify({ step: 'publish', name: pkg.name, args }) + '\\n');
			if (process.env.FAIL_PACKAGE === pkg.name) process.exit(1);
		`,
		'bin/npm.cmd': `@echo off\r\n"${process.execPath}" "%~dp0npm" %*\r\n`,
		'run.mjs': `
			import { publish } from ${JSON.stringify(new URL('../scripts/release-native.mjs', import.meta.url).href)};
			await publish({}, {
				cwd: process.cwd(),
				env: process.env,
				nextRelease: { version: ${JSON.stringify(version)}, channel: process.env.RELEASE_CHANNEL },
				options: { dryRun: process.env.RELEASE_DRY_RUN === '1' },
				logger: { log() {} },
			});
		`,
	});
	try {
		await fs.chmod(fixture.getPath('bin/npm'), 0o755);
		for (const [, platform] of targets) {
			const binary = `transform.${platform}.node`;
			await fixture.mkdir(`npm/${platform}`);
			await fixture.writeJson(`npm/${platform}/package.json`, {
				name: `${packageName}-${platform}`,
				version,
				main: binary,
			});
			await fixture.writeFile(`npm/${platform}/${binary}`, `binary for ${platform}`);
		}
		return fixture;
	} catch (error) {
		await fixture.rm();
		throw error;
	}
};

type Fixture = Awaited<ReturnType<typeof createRelease>>;
const runRelease = (fixture: Fixture, env: Record<string, string | undefined> = {}) => execaNode(fixture.getPath('run.mjs'), [], {
	cwd: fixture.path,
	env: {
		PATH: `${fixture.getPath('bin')}${path.delimiter}${process.env.PATH}`,
		FIXTURE_ROOT: fixture.path,
		TSX_PREBUILT_NATIVE_DIR: fixture.getPath('artifacts'),
		...env,
	},
	reject: false,
});

const readEvents = async (fixture: Fixture) => {
	const text = await fixture.readFile('events.jsonl', 'utf8');
	return text.trim().split('\n').map(line => JSON.parse(line) as {
		step: string;
		name?: string;
		args?: string[];
	});
};

await describe('native release', () => {
	test('registers platform publication before the main npm publisher', () => {
		const config = createRequire(import.meta.url)('../release.config.cjs') as { plugins: string[] };
		const plugin = './scripts/release-native.mjs';
		expect(config.plugins).toContain(plugin);
		expect(config.plugins.indexOf(plugin)).toBeLessThan(config.plugins.indexOf('@semantic-release/npm'));
	});

	test('prepares and publishes the complete native set with the release tag', async () => {
		await using fixture = await createRelease();
		const result = await runRelease(fixture, { RELEASE_CHANNEL: 'beta' });
		expect(result.exitCode).toBe(0);
		const events = await readEvents(fixture);
		expect(events[0]).toStrictEqual({ step: 'prepare' });
		expect(events.slice(1).map(event => event.name)).toStrictEqual(targets.map(([, platform]) => `${packageName}-${platform}`));
		for (const event of events.slice(1)) {
			expect(event.args?.slice(2)).toStrictEqual(['--access', 'public', '--tag', 'beta', '--ignore-scripts']);
		}
	});

	test('checks all artifacts before the first publication', async () => {
		await using fixture = await createRelease();
		await fixture.rm('npm/win32-x64-msvc/transform.win32-x64-msvc.node');
		const result = await runRelease(fixture);
		expect(result.exitCode).not.toBe(0);
		expect(await readEvents(fixture)).toStrictEqual([{ step: 'prepare' }]);
	});

	test('rejects a platform version mismatch before publication', async () => {
		await using fixture = await createRelease();
		const filename = 'npm/win32-x64-msvc/package.json';
		const pkg = await fixture.readJson<Record<string, unknown>>(filename);
		await fixture.writeJson(filename, {
			...pkg,
			version: '0.0.0',
		});
		const result = await runRelease(fixture);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('Platform version mismatch');
		expect(await readEvents(fixture)).toStrictEqual([{ step: 'prepare' }]);
	});

	test('stops publication when a platform package fails', async () => {
		await using fixture = await createRelease();
		const result = await runRelease(fixture, { FAIL_PACKAGE: `${packageName}-darwin-arm64` });
		expect(result.exitCode).not.toBe(0);
		const events = await readEvents(fixture);
		expect(events.filter(event => event.step === 'publish').map(event => event.name)).toStrictEqual([
			`${packageName}-darwin-x64`,
			`${packageName}-darwin-arm64`,
		]);
	});

	test('does not prepare or publish during a direct dry-run call', async () => {
		await using fixture = await createRelease();
		const result = await runRelease(fixture, { RELEASE_DRY_RUN: '1' });
		expect(result.exitCode).toBe(0);
		expect(await fixture.exists('events.jsonl')).toBe(false);
	});
});
