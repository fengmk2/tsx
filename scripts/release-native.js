import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execa, execaNode } from 'execa';
import { parseTriple } from '@napi-rs/cli';

// semantic-release skips publish hooks in dry-run mode. Keep this guard for
// callers that invoke this hook directly during release previews.
export const publish = async (_pluginConfig, context) => {
	if (context.options?.dryRun) {
		return;
	}

	const {
		cwd, env, nextRelease, logger,
	} = context;
	const commandOptions = {
		cwd,
		env,
		stdio: 'inherit',
	};
	const { version } = nextRelease;
	const readJson = async name => JSON.parse(await fs.readFile(path.join(cwd, name), 'utf8'));
	const beforePrepare = await readJson('package.json');
	assert.equal(beforePrepare.version, version, 'The root package must have the final release version');
	assert(env.TSX_PREBUILT_NATIVE_DIR, 'Native releases require the complete checked artifact set');

	// @semantic-release/npm already sets the root version during its prepare step.
	// Package preparation verifies the artifacts and sets platform versions before
	// clean-pkg-json removes prepack, so the following root publish does not rebuild.
	await execaNode(path.join(cwd, 'scripts/prepare-package.js'), [], commandOptions);

	const config = await readJson('native/transform/napi.json');
	const rootPackage = await readJson('package.json');
	const packageName = config.packageName ?? rootPackage.name;
	const targets = config.targets
		.map(target => parseTriple(target))
		.filter(target => target.platform !== 'wasi' && target.platform !== 'wasm');
	assert(targets.length > 0, 'The release must include native targets');
	const packages = [];

	// Check every target before the first immutable registry write. A missing
	// target must fail this release instead of silently producing a partial set.
	for (const target of targets) {
		const directory = path.join(cwd, 'npm', target.platformArchABI);
		const metadata = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
		const name = `${packageName}-${target.platformArchABI}`;
		assert.equal(metadata.name, name, `Unexpected platform package: ${target.triple}`);
		assert.equal(metadata.version, version, `Platform version mismatch: ${name}`);
		assert.equal(rootPackage.optionalDependencies?.[name], `~${version}`, `Platform dependency mismatch: ${name}`);
		const binary = `${config.binaryName}.${target.platformArchABI}.node`;
		assert.equal(metadata.main, binary, `Unexpected platform entry: ${name}`);
		const artifact = await fs.stat(path.join(directory, binary));
		assert(artifact.isFile() && artifact.size > 0, `Missing platform binary: ${name}`);
		packages.push({
			name,
			directory,
		});
	}

	// npm's own publication defaults to latest; propagate semantic-release's
	// channel so prereleases cannot replace the stable platform-package tag.
	const tag = nextRelease.channel || 'latest';
	for (const { name, directory } of packages) {
		logger.log('Publishing %s@%s before the main package', name, version);
		await execa('npm', ['publish', directory, '--access', 'public', '--tag', tag, '--ignore-scripts'], commandOptions);
	}
};
