import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../../', import.meta.url));
const entry = 'src/lib/cli.ts';
const tsconfig = '.config/tsconfig.mocha.json';
const sourceCondition = 'typedoc-ts';
const timeoutMs = 120_000;
const outputLimit = 1024 * 1024;

const revision = directory => execFileSync('git', ['rev-parse', 'HEAD'], {
	cwd: directory,
	encoding: 'utf8',
}).trim();

const readPackage = async directory => JSON.parse(await fs.readFile(
	path.join(directory, 'package.json'),
	'utf8',
));

const checkBackend = (environment, noAddons) => JSON.parse(execFileSync(process.execPath, [
	'--input-type=commonjs',
	'-e',
	`
		const assert = require('node:assert/strict');
		const binding = require('#native-transform');
		assert.equal(typeof binding.backendVersion, 'function');
		assert.equal(typeof binding.transformSync, 'function');
		const nativeLoaded = Object.keys(require.cache).some(file => file.endsWith('.node'));
		const wasmLoaded = Boolean(require.cache[require.resolve('#wasm-transform')]);
		const noAddons = process.argv[1] === 'true';
		assert(noAddons ? wasmLoaded && !nativeLoaded : nativeLoaded,
			'Build the expected native and WASM artifacts with pnpm build before benchmarking');
		process.stdout.write(JSON.stringify({
			kind: noAddons ? 'wasm' : 'native',
			version: binding.backendVersion(),
		}));
	`,
	String(noAddons),
], {
	cwd: root,
	env: environment,
	encoding: 'utf8',
	timeout: 30_000,
	maxBuffer: outputLimit,
	stdio: ['ignore', 'pipe', 'pipe'],
}));

const signalGroup = (pid, signal) => {
	try {
		process.kill(-pid, signal);
		return true;
	} catch (error) {
		if (signal === 0 && error.code === 'EPERM') {
			return true;
		}
		if (error.code !== 'ESRCH') {
			throw error;
		}
		return false;
	}
};

const waitForGroupExit = async (pid) => {
	const deadline = performance.now() + 5000;
	while (signalGroup(pid, 0)) {
		if (performance.now() >= deadline) {
			return false;
		}
		await delay(10);
	}
	return true;
};

const stopProcessGroup = async (pid) => {
	if (!pid || !signalGroup(pid, 'SIGTERM')) {
		return;
	}
	if (!await waitForGroupExit(pid)) {
		signalGroup(pid, 'SIGKILL');
		assert(await waitForGroupExit(pid), 'TypeDoc process group survived SIGKILL');
	}
};

const measure = async (projectDirectory, implementation, environment, signal) => {
	signal.throwIfAborted();
	const started = performance.now();
	const child = spawn(process.execPath, [
		implementation.cli,
		`--conditions=${sourceCondition}`,
		'--tsconfig',
		tsconfig,
		entry,
		'--help',
		'--logLevel',
		'Error',
	], {
		cwd: projectDirectory,
		env: environment,
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: true,
	});
	let stdout = '';
	let stderr = '';
	let interrupt;
	let timer;
	try {
		const result = await new Promise((resolve, reject) => {
			interrupt = () => reject(signal.reason);
			signal.addEventListener('abort', interrupt, { once: true });
			timer = setTimeout(() => reject(new Error(`TypeDoc exceeded ${timeoutMs} ms`)), timeoutMs);
			child.once('error', reject);
			child.stdout.setEncoding('utf8');
			child.stderr.setEncoding('utf8');
			child.stdout.on('data', (chunk) => {
				stdout += chunk;
				if (stdout.length > outputLimit) {
					reject(new Error('TypeDoc stdout exceeded the output limit'));
				}
			});
			child.stderr.on('data', (chunk) => {
				stderr += chunk;
				if (stderr.length > outputLimit) {
					reject(new Error('TypeDoc stderr exceeded the output limit'));
				}
			});
			child.once('close', (code, exitSignal) => resolve({
				code,
				exitSignal,
				elapsedMs: performance.now() - started,
			}));
			if (signal.aborted) {
				interrupt();
			}
		});
		assert.equal(result.code, 0, `TypeDoc exited with signal ${result.exitSignal}`);
		assert.match(stdout, /typedoc path\/to\/entry\.ts/, 'TypeDoc did not print its CLI help');
		assert.match(stdout, /Supported highlighting languages:/);
		assert.match(stdout, /--help/);
		return {
			elapsedMs: result.elapsedMs,
			stdout,
		};
	} catch (error) {
		throw new Error(`${implementation.name}: ${error.message}\n${stderr}\n${stdout}`, { cause: error });
	} finally {
		clearTimeout(timer);
		signal.removeEventListener('abort', interrupt);
		await stopProcessGroup(child.pid);
	}
};

const summarize = (samplesMs) => {
	const sorted = [...samplesMs].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return {
		medianMs: sorted.length % 2
			? sorted[middle]
			: (sorted[middle - 1] + sorted[middle]) / 2,
		minMs: sorted[0],
		maxMs: sorted.at(-1),
		samplesMs,
	};
};

const main = async () => {
	const { values } = parseArgs({
		options: {
			'project-dir': { type: 'string' },
			'baseline-dir': { type: 'string' },
			runs: {
				type: 'string',
				default: '15',
			},
			'no-addons': {
				type: 'boolean',
				default: false,
			},
			help: { type: 'boolean' },
		},
	});
	if (values.help) {
		process.stdout.write([
			'node scripts/benchmark/typedoc.js --project-dir <TypeDoc checkout>',
			'  --baseline-dir <built esbuild-only tsx checkout> [--runs 15] [--no-addons]',
			'',
			'Measures cold-cache CLI spawn through successful TypeDoc --help exit.',
			'Uses the project test tsconfig and typedoc-ts source export condition.',
			'Both tsx checkouts must be built, and TypeDoc dependencies must be installed.',
			'JSON goes to stdout; progress goes to stderr. POSIX only.',
			'',
		].join('\n'));
		return;
	}
	assert(process.platform !== 'win32', 'Process-group cleanup requires POSIX');
	assert(values['project-dir'], '--project-dir is required');
	assert(values['baseline-dir'], '--baseline-dir is required');
	const runs = Number(values.runs);
	assert(Number.isSafeInteger(runs) && runs > 0, '--runs must be a positive integer');
	const projectDirectory = path.resolve(values['project-dir']);
	const project = await readPackage(projectDirectory);
	assert.equal(project.name, 'typedoc', '--project-dir must contain TypeDoc');
	assert.equal(typeof project.exports?.['.']?.[sourceCondition], 'string');
	const declaredTsx = project.devDependencies?.tsx ?? project.dependencies?.tsx;
	assert(declaredTsx, 'TypeDoc must declare its tsx dependency');
	const installedTsx = await readPackage(path.join(projectDirectory, 'node_modules/tsx'));
	await fs.access(path.join(projectDirectory, entry));
	await fs.access(path.join(projectDirectory, tsconfig));
	const implementations = [
		{
			name: 'baseline',
			directory: path.resolve(values['baseline-dir']),
		},
		{
			name: 'candidate',
			directory: root,
		},
	];
	for (const implementation of implementations) {
		const metadata = await readPackage(implementation.directory);
		assert.equal(metadata.name, 'tsx', 'Both implementations must be tsx checkouts');
		implementation.cli = path.join(implementation.directory, 'dist/cli.mjs');
		implementation.revision = revision(implementation.directory);
		await fs.access(implementation.cli);
	}
	const projectRevision = revision(projectDirectory);
	const temporaryDirectory = await fs.mkdtemp('/tmp/tsx-typedoc-');
	const controller = new AbortController();
	const interrupt = () => controller.abort(new Error('Benchmark interrupted'));
	process.once('SIGINT', interrupt);
	process.once('SIGTERM', interrupt);
	const samples = {
		baseline: [],
		candidate: [],
	};
	let backend;
	let expectedHelp;
	try {
		const home = path.join(temporaryDirectory, 'home');
		await fs.mkdir(home);
		const environment = {
			PATH: process.env.PATH,
			HOME: home,
			NO_COLOR: '1',
			LANG: 'en_US.UTF-8',
			...(values['no-addons'] ? { NODE_OPTIONS: '--no-addons' } : {}),
		};
		backend = checkBackend({
			...environment,
			TMPDIR: temporaryDirectory,
			TEMP: temporaryDirectory,
			TMP: temporaryDirectory,
		}, values['no-addons']);
		const run = async (implementation) => {
			const cacheDirectory = path.join(temporaryDirectory, implementation.name);
			await fs.rm(cacheDirectory, {
				recursive: true,
				force: true,
			});
			await fs.mkdir(cacheDirectory);
			const result = await measure(projectDirectory, implementation, {
				...environment,
				TMPDIR: cacheDirectory,
				TEMP: cacheDirectory,
				TMP: cacheDirectory,
			}, controller.signal);
			expectedHelp ??= result.stdout;
			assert.equal(result.stdout, expectedHelp, 'The implementations produced different CLI help');
			return result.elapsedMs;
		};
		for (const implementation of implementations) {
			process.stderr.write(`Warming up ${implementation.name}\n`);
			await run(implementation);
		}
		for (let sample = 0; sample < runs; sample += 1) {
			const ordered = sample % 2 ? [...implementations].reverse() : implementations;
			for (const implementation of ordered) {
				const elapsed = await run(implementation);
				samples[implementation.name].push(elapsed);
				process.stderr.write(`${sample + 1}/${runs}: ${implementation.name} ${elapsed.toFixed(2)} ms\n`);
			}
		}
	} finally {
		process.removeListener('SIGINT', interrupt);
		process.removeListener('SIGTERM', interrupt);
		await fs.rm(temporaryDirectory, {
			recursive: true,
			force: true,
		});
	}
	const baseline = summarize(samples.baseline);
	const candidate = summarize(samples.candidate);
	process.stdout.write(`${JSON.stringify({
		metadata: {
			measuredAt: new Date().toISOString(),
			node: process.version,
			nodeExecutable: process.execPath,
			platform: process.platform,
			arch: process.arch,
			cpu: os.cpus()[0]?.model,
			project: {
				directory: projectDirectory,
				revision: projectRevision,
				name: project.name,
				version: project.version,
				tsxDeclared: declaredTsx,
				tsxInstalled: installedTsx.version,
			},
			implementations,
			command: `node <tsx>/dist/cli.mjs --conditions=${sourceCondition} --tsconfig ${tsconfig} ${entry} --help --logLevel Error`,
			metric: 'Source CLI spawn to successful exit with identical TypeDoc help output',
			tsconfig,
			sourceCondition,
			helpSha256: createHash('sha256').update(expectedHelp).digest('hex'),
			runs,
			noAddons: values['no-addons'],
			backend,
			timeoutMs,
			cache: 'Every run clears its transform cache; operating-system file caches are not cleared.',
			order: 'One untimed warmup per implementation; alternating interleaved timed runs.',
		},
		results: {
			cold: {
				baseline,
				candidate,
				afterOverBefore: candidate.medianMs / baseline.medianMs,
				differenceMs: candidate.medianMs - baseline.medianMs,
			},
		},
	}, null, 2)}\n`);
};

await main();
