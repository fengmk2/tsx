import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../../', import.meta.url));
const startupTimeoutMs = 120_000;
const pollIntervalMs = 10;
const outputLimit = 1024 * 1024;

const revision = directory => execFileSync('git', ['rev-parse', 'HEAD'], {
	cwd: directory,
	encoding: 'utf8',
}).trim();

const readPackage = async directory => JSON.parse(await fs.readFile(
	path.join(directory, 'package.json'),
	'utf8',
));

const checkBackend = environment => JSON.parse(execFileSync(process.execPath, [
	'--input-type=commonjs',
	'-e',
	`
		const assert = require('node:assert/strict');
		const binding = require('#native-transform');
		assert.equal(typeof binding.backendVersion, 'function');
		assert.equal(typeof binding.transformSync, 'function');
		assert(Object.keys(require.cache).some(file => file.endsWith('.node')),
			'Build the native artifact with pnpm build before benchmarking');
		process.stdout.write(JSON.stringify({ kind: 'native', version: binding.backendVersion() }));
	`,
], {
	cwd: root,
	env: environment,
	encoding: 'utf8',
	timeout: 30_000,
	maxBuffer: outputLimit,
	stdio: ['ignore', 'pipe', 'pipe'],
}));

const availablePort = async () => {
	const server = net.createServer();
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	try {
		const address = server.address();
		assert(address && typeof address === 'object');
		return address.port;
	} finally {
		await new Promise((resolve, reject) => {
			server.close(error => (error ? reject(error) : resolve()));
		});
	}
};

const probeHealth = (port, timeout) => new Promise((resolve) => {
	const request = http.get({
		hostname: '127.0.0.1',
		port,
		path: '/healthz',
		agent: false,
		timeout,
	}, (response) => {
		let body = '';
		response.setEncoding('utf8');
		response.on('data', (chunk) => {
			body += chunk;
			if (body.length > 1024) {
				response.destroy();
				resolve();
			}
		});
		response.once('error', () => resolve());
		response.once('close', () => resolve());
		response.once('end', () => {
			try {
				const health = JSON.parse(body);
				resolve(response.statusCode === 200 && health.message === 'OK'
					? performance.now()
					: undefined);
			} catch {
				resolve();
			}
		});
	});
	request.once('timeout', () => request.destroy());
	request.once('error', () => resolve());
});

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

const waitForClose = closed => new Promise((resolve) => {
	const timer = setTimeout(() => resolve(false), 5000);
	closed.then(() => {
		clearTimeout(timer);
		resolve(true);
	}).catch(() => {
		clearTimeout(timer);
		resolve(false);
	});
});

const waitForGroupExit = async (pid) => {
	const deadline = performance.now() + 5000;
	while (signalGroup(pid, 0)) {
		if (performance.now() >= deadline) {
			return false;
		}
		await delay(pollIntervalMs);
	}
	return true;
};

const stopServer = async (child, closed) => {
	if (!child.pid) {
		return;
	}
	signalGroup(child.pid, 'SIGTERM');
	const didClose = await waitForClose(closed);
	const groupExited = await waitForGroupExit(child.pid);
	if (!didClose || !groupExited) {
		signalGroup(child.pid, 'SIGKILL');
		assert(await waitForClose(closed), 'WPPConnect did not exit after SIGKILL');
		assert(await waitForGroupExit(child.pid), 'WPPConnect process group survived SIGKILL');
	}
};

const measureStartup = async (
	projectDirectory,
	workingDirectory,
	implementation,
	environment,
	signal,
) => {
	signal.throwIfAborted();
	const port = await availablePort();
	const started = performance.now();
	const child = spawn(process.execPath, [
		implementation.cli,
		'--tsconfig',
		path.join(projectDirectory, 'tsconfig.json'),
		path.join(projectDirectory, 'src/server.ts'),
	], {
		cwd: workingDirectory,
		env: {
			...environment,
			PORT: String(port),
		},
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: true,
	});
	let output = Buffer.alloc(0);
	const collectOutput = (chunk) => {
		output = Buffer.concat([output, chunk]);
		if (output.length > outputLimit) {
			output = output.subarray(output.length - outputLimit);
		}
	};
	for (const stream of [child.stdout, child.stderr]) {
		stream.on('data', collectOutput);
	}
	let spawnError;
	let exited;
	child.once('error', (error) => {
		spawnError = error;
	});
	const closed = new Promise((resolve) => {
		child.once('close', (code, exitSignal) => {
			exited = {
				code,
				signal: exitSignal,
			};
			resolve();
		});
	});
	try {
		while (performance.now() - started < startupTimeoutMs) {
			signal.throwIfAborted();
			assert.ifError(spawnError);
			assert(!exited, `WPPConnect exited before readiness: ${JSON.stringify(exited)}`);
			const remaining = startupTimeoutMs - (performance.now() - started);
			const ready = await probeHealth(port, Math.max(1, Math.min(1000, remaining)));
			if (ready !== undefined) {
				assert(!exited, 'WPPConnect exited during the readiness request');
				return ready - started;
			}
			await delay(pollIntervalMs);
		}
		throw new Error(`WPPConnect did not become ready within ${startupTimeoutMs} ms`);
	} catch (error) {
		throw new Error(`${implementation.name}: ${error.message}\n${output.toString()}`, {
			cause: error,
		});
	} finally {
		await stopServer(child, closed);
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
			help: { type: 'boolean' },
		},
	});
	if (values.help) {
		process.stdout.write([
			'node scripts/benchmark/wppconnect.js --project-dir <WPPConnect Server checkout>',
			'  --baseline-dir <built esbuild-only tsx checkout> [--runs 15]',
			'',
			'Measures cold-cache CLI spawn through HTTP 200 /healthz with message OK.',
			'Uses the original source/configuration and an empty working directory per launch.',
			'Both tsx checkouts must be built, and project dependencies must be installed.',
			'JSON goes to stdout; progress goes to stderr. Native backend; POSIX only.',
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
	assert.equal(project.name, '@wppconnect/server', '--project-dir must contain WPPConnect Server');
	assert.equal(project.scripts?.dev, 'tsx watch src/server.ts');
	assert.equal(process.versions.node, project.engines?.node, 'Use the project-pinned Node version');
	const declaredTsx = project.devDependencies?.tsx ?? project.dependencies?.tsx;
	assert(declaredTsx, 'WPPConnect Server must declare its tsx dependency');
	const installedTsx = await readPackage(path.join(projectDirectory, 'node_modules/tsx'));
	await fs.access(path.join(projectDirectory, 'src/server.ts'));
	await fs.access(path.join(projectDirectory, 'tsconfig.json'));
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
	const temporaryDirectory = await fs.mkdtemp('/tmp/tsx-wpp-');
	const controller = new AbortController();
	const interrupt = () => controller.abort(new Error('Benchmark interrupted'));
	process.once('SIGINT', interrupt);
	process.once('SIGTERM', interrupt);
	const samples = {
		baseline: [],
		candidate: [],
	};
	let backend;
	try {
		const environment = {
			PATH: process.env.PATH,
			NODE_ENV: 'development',
			HOST: 'http://127.0.0.1',
			TOKEN_STORE_TYPE: 'file',
			CUSTOM_USER_DATA_DIR: './userDataDir/',
			SECRET_KEY: 'tsx-benchmark-empty-sessions',
			NO_COLOR: '1',
		};
		const preflightHome = path.join(temporaryDirectory, 'preflight-home');
		await fs.mkdir(preflightHome);
		backend = checkBackend({
			...environment,
			HOME: preflightHome,
			TMPDIR: temporaryDirectory,
			TEMP: temporaryDirectory,
			TMP: temporaryDirectory,
		});
		const run = async (implementation) => {
			const workingDirectory = await fs.mkdtemp(path.join(temporaryDirectory, 'run-'));
			try {
				for (const directory of ['home', 'cache', 'tokens', 'userDataDir']) {
					await fs.mkdir(path.join(workingDirectory, directory));
				}
				const tokens = path.join(workingDirectory, 'tokens');
				assert.deepEqual(await fs.readdir(tokens), [], 'Each launch needs an empty token store');
				const cache = path.join(workingDirectory, 'cache');
				const elapsed = await measureStartup(projectDirectory, workingDirectory, implementation, {
					...environment,
					HOME: path.join(workingDirectory, 'home'),
					TMPDIR: cache,
					TEMP: cache,
					TMP: cache,
				}, controller.signal);
				assert.deepEqual(await fs.readdir(tokens), [], 'The benchmark must not create session tokens');
				assert.deepEqual(
					await fs.readdir(path.join(workingDirectory, 'userDataDir')),
					[],
					'The benchmark must not create browser profiles',
				);
				return elapsed;
			} finally {
				await fs.rm(workingDirectory, {
					recursive: true,
					force: true,
				});
			}
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
			command: 'node <tsx>/dist/cli.mjs --tsconfig <project>/tsconfig.json <project>/src/server.ts',
			metric: 'CLI spawn to HTTP 200 /healthz response with JSON message OK',
			workingDirectory: 'A fresh disposable directory with empty file tokens and browser profiles per launch.',
			runs,
			backend,
			pollIntervalMs,
			startupTimeoutMs,
			cache: 'Every run uses an empty transform cache; operating-system file caches are not cleared.',
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
