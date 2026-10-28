import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { NapiCli, parseTriple, writeJsBinding } from '@napi-rs/cli';

const { values } = parseArgs({
	options: {
		'require-all': { type: 'boolean' },
	},
});

const root = fileURLToPath(new URL('../', import.meta.url));
const packageJsonPath = path.join(root, 'package.json');
const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
const config = JSON.parse(await fs.readFile(path.join(root, 'native/transform/napi.json'), 'utf8'));
const packageName = config.packageName ?? packageJson.name;
const nativeDirectory = path.join(root, 'dist/native');
const targets = config.targets
	.map(target => parseTriple(target))
	.filter(target => target.arch !== 'wasm32');
const artifacts = [];

// Validate the complete release set before changing generated files or metadata.
for (const { platformArchABI } of targets) {
	const filename = `${config.binaryName}.${platformArchABI}.node`;
	const source = path.join(nativeDirectory, filename);
	try {
		const stat = await fs.stat(source);
		assert(stat.isFile() && stat.size > 0, `Empty or invalid native artifact: ${source}`);
		artifacts.push({
			filename,
			source,
		});
	} catch (error) {
		if (error.code !== 'ENOENT' || values['require-all']) {
			throw error;
		}
	}
}

const stagingDirectory = await fs.mkdtemp(path.join(root, '.native-packages-'));
const outputDirectory = path.join(root, 'npm');
const backupDirectory = path.join(stagingDirectory, 'previous');
try {
	// Excluding WASM here avoids platform restrictions and runtime-version lookup
	// for a WASI npm package. Its compiler and glue stay in the main tsx package.
	await fs.writeFile(path.join(stagingDirectory, 'napi.json'), JSON.stringify({
		...config,
		packageName,
		targets: targets.map(target => target.triple),
	}));
	await fs.writeFile(path.join(stagingDirectory, 'package.json'), JSON.stringify(packageJson));
	await fs.mkdir(path.join(stagingDirectory, 'artifacts'));
	for (const { filename, source } of artifacts) {
		await fs.copyFile(source, path.join(stagingDirectory, 'artifacts', filename));
	}
	const options = {
		cwd: stagingDirectory,
		configPath: 'napi.json',
		packageJsonPath: 'package.json',
		npmDir: 'npm',
	};
	const cli = new NapiCli();
	await cli.createNpmDirs(options);
	await cli.artifacts({
		...options,
		outputDir: 'artifacts',
	});
	for (const { platformArchABI } of targets) {
		await fs.copyFile(
			path.join(root, 'LICENSE'),
			path.join(stagingDirectory, 'npm', platformArchABI, 'LICENSE'),
		);
	}

	// A release changes the root version after CI compilation. Generate its loader
	// with the final version, including napi-rs's optional version checks.
	await writeJsBinding({
		platform: true,
		idents: ['backendVersion', 'transformSync'],
		jsBinding: 'index.cjs',
		binaryName: config.binaryName,
		packageName,
		version: packageJson.version,
		outputDir: nativeDirectory,
	});

	let previousOutput = false;
	try {
		await fs.rename(outputDirectory, backupDirectory);
		previousOutput = true;
	} catch (error) {
		if (error.code !== 'ENOENT') {
			throw error;
		}
	}
	try {
		await fs.rename(path.join(stagingDirectory, 'npm'), outputDirectory);
	} catch (error) {
		if (previousOutput) {
			await fs.rename(backupDirectory, outputDirectory);
		}
		throw error;
	}

	const optionalDependencies = Object.fromEntries(
		Object.entries(packageJson.optionalDependencies ?? {}).filter(([name]) => !name.startsWith(`${packageName}-`)),
	);
	for (const { platformArchABI } of targets) {
		optionalDependencies[`${packageName}-${platformArchABI}`] = `~${packageJson.version}`;
	}
	packageJson.optionalDependencies = optionalDependencies;
	await fs.writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, '\t')}\n`);
} finally {
	await fs.rm(stagingDirectory, {
		recursive: true,
		force: true,
	});
}

process.stdout.write(`Prepared ${targets.length} native packages with ${artifacts.length} artifacts in ${outputDirectory}\n`);
