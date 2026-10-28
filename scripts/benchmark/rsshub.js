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

const startupTimeoutMs = 120_000;
const pollIntervalMs = 10;
const warmCacheWarmupSettleMs = 1000;
const outputLimit = 1024 * 1024;
const root = fileURLToPath(new URL('../../', import.meta.url));

const revision = directory => execFileSync('git', ['rev-parse', 'HEAD'], {
	cwd: directory,
	encoding: 'utf8',
}).trim();

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

const reservePort = async () => {
	const server = net.createServer();
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	assert(address && typeof address === 'object');
	return {
		server,
		port: address.port,
	};
};

const availablePorts = async () => {
	const reserved = [];
	try {
		// Reserve both at once so the application and metrics ports are distinct.
		for (let index = 0; index < 2; index += 1) {
			reserved.push(await reservePort());
		}
		return reserved.map(({ port }) => port);
	} finally {
		await Promise.all(reserved.map(({ server }) => new Promise((resolve, reject) => {
			server.close(error => (error ? reject(error) : resolve()));
		})));
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
		response.once('end', () => resolve(
			response.statusCode === 200 && body === 'ok' ? performance.now() : undefined,
		));
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
	// A descendant can retain the process group after the CLI closes.
	const groupExited = await waitForGroupExit(child.pid);
	if (!didClose || !groupExited) {
		signalGroup(child.pid, 'SIGKILL');
		assert(await waitForClose(closed), 'RSSHub did not exit after SIGKILL');
		assert(await waitForGroupExit(child.pid), 'RSSHub process group survived SIGKILL');
	}
};

const measureStartup = async (
	projectDirectory,
	implementation,
	environment,
	signal,
	settleMs,
) => {
	signal.throwIfAborted();
	const [port, metricsPort] = await availablePorts();
	const started = performance.now();
	const child = spawn(process.execPath, [implementation.cli, 'lib/index.ts'], {
		cwd: projectDirectory,
		env: {
			...environment,
			PORT: String(port),
			OTEL_EXPORTER_PROMETHEUS_PORT: String(metricsPort),
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
			assert(!exited, `RSSHub exited before readiness: ${JSON.stringify(exited)}`);
			const remaining = startupTimeoutMs - (performance.now() - started);
			const ready = await probeHealth(port, Math.max(1, Math.min(1000, remaining)));
			if (ready !== undefined) {
				assert(!exited, 'RSSHub exited during the readiness request');
				if (settleMs) {
					// Warmup only: let asynchronous transform-cache writes finish before shutdown.
					await delay(settleMs, undefined, { signal });
					assert(!exited, 'RSSHub exited during the cache warmup');
				}
				return ready - started;
			}
			await delay(pollIntervalMs);
		}
		throw new Error(`RSSHub did not become ready within ${startupTimeoutMs} ms`);
	} catch (error) {
		throw new Error(`${implementation.name}: ${error.message}\n${output.toString()}`, {
			cause: error,
		});
	} finally {
		await stopServer(child, closed);
	}
};

const main = async () => {
	const { values } = parseArgs({
		options: {
			'project-dir': { type: 'string' },
			'baseline-dir': { type: 'string' },
			runs: {
				type: 'string',
				default: '7',
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
			'node scripts/benchmark/rsshub.js --project-dir <RSSHub checkout>',
			'  --baseline-dir <built esbuild-only tsx checkout> [--runs 7] [--no-addons]',
			'',
			'Measures cold and warm transform caches from CLI spawn to /healthz readiness.',
			'Both tsx checkouts must be built, and RSSHub dependencies must be installed.',
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
	const project = JSON.parse(await fs.readFile(
		path.join(projectDirectory, 'package.json'),
		'utf8',
	));
	assert.equal(project.name, 'rsshub', '--project-dir must contain RSSHub');
	const projectTsxVersion = project.dependencies?.tsx ?? project.devDependencies?.tsx;
	assert(projectTsxVersion, 'RSSHub must declare its tsx dependency');
	assert(Object.values(project.scripts ?? {}).some(script => /\btsx\s/.test(script)));
	await fs.access(path.join(projectDirectory, 'lib/index.ts'));
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
		const metadata = JSON.parse(await fs.readFile(
			path.join(implementation.directory, 'package.json'),
			'utf8',
		));
		assert.equal(metadata.name, 'tsx', 'Both implementations must be tsx checkouts');
		implementation.cli = path.join(implementation.directory, 'dist/cli.mjs');
		implementation.revision = revision(implementation.directory);
		await fs.access(implementation.cli);
	}
	const projectRevision = revision(projectDirectory);
	// macOS's default temporary path can exceed the CLI's Unix socket path limit.
	const temporaryDirectory = await fs.mkdtemp(path.join('/tmp', 'tsx-rss-'));
	const controller = new AbortController();
	const interrupt = () => controller.abort(new Error('Benchmark interrupted'));
	process.once('SIGINT', interrupt);
	process.once('SIGTERM', interrupt);
	const results = {};
	let backend;
	try {
		const home = path.join(temporaryDirectory, 'home');
		const dotenvPath = path.join(temporaryDirectory, 'empty.env');
		await fs.mkdir(home);
		await fs.writeFile(dotenvPath, '');
		const baseEnvironment = {
			PATH: process.env.PATH,
			HOME: home,
			NODE_ENV: 'dev',
			CACHE_TYPE: 'memory',
			ENABLE_CLUSTER: 'false',
			LISTEN_INADDR_ANY: 'false',
			NO_LOGFILES: 'true',
			REMOTE_CONFIG: '',
			REDIS_URL: '',
			PROXY_URI: '',
			PROXY_URIS: '',
			PAC_URI: '',
			PAC_SCRIPT: '',
			SENTRY: '',
			HONEYBADGER_API_KEY: '',
			ENABLE_REMOTE_DEBUGGING: 'false',
			OTEL_TRACES_SAMPLER: 'always_off',
			OTEL_EXPORTER_PROMETHEUS_HOST: '127.0.0.1',
			DOTENV_CONFIG_PATH: dotenvPath,
			DOTENV_CONFIG_QUIET: 'true',
			...(values['no-addons'] ? { NODE_OPTIONS: '--no-addons' } : {}),
		};
		backend = checkBackend({
			...baseEnvironment,
			TMPDIR: temporaryDirectory,
			TEMP: temporaryDirectory,
			TMP: temporaryDirectory,
		}, values['no-addons']);
		for (const cache of ['cold', 'warm']) {
			const samples = {
				baseline: [],
				candidate: [],
			};
			const run = async (implementation, settleMs = 0) => {
				const cacheDirectory = path.join(
					temporaryDirectory,
					`${cache}-${implementation.name}`,
				);
				if (cache === 'cold') {
					await fs.rm(cacheDirectory, {
						recursive: true,
						force: true,
					});
				}
				await fs.mkdir(cacheDirectory, { recursive: true });
				return measureStartup(projectDirectory, implementation, {
					...baseEnvironment,
					TMPDIR: cacheDirectory,
					TEMP: cacheDirectory,
					TMP: cacheDirectory,
				}, controller.signal, settleMs);
			};
			for (const implementation of implementations) {
				process.stderr.write(`${cache}: warming up ${implementation.name}\n`);
				await run(implementation, cache === 'warm' ? warmCacheWarmupSettleMs : 0);
			}
			for (let sample = 0; sample < runs; sample += 1) {
				const ordered = sample % 2 ? [...implementations].reverse() : implementations;
				for (const implementation of ordered) {
					const elapsed = await run(implementation);
					samples[implementation.name].push(elapsed);
					const label = `${cache} ${sample + 1}/${runs}: ${implementation.name}`;
					process.stderr.write(`${label} ${elapsed.toFixed(2)} ms\n`);
				}
			}
			const baseline = summarize(samples.baseline);
			const candidate = summarize(samples.candidate);
			results[cache] = {
				baseline,
				candidate,
				afterOverBefore: candidate.medianMs / baseline.medianMs,
				differenceMs: candidate.medianMs - baseline.medianMs,
			};
		}
	} finally {
		process.removeListener('SIGINT', interrupt);
		process.removeListener('SIGTERM', interrupt);
		await fs.rm(temporaryDirectory, {
			recursive: true,
			force: true,
		});
	}
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
				tsx: projectTsxVersion,
			},
			implementations,
			runs,
			noAddons: values['no-addons'],
			backend,
			metric: 'CLI spawn to HTTP 200 /healthz response with body ok',
			pollIntervalMs,
			startupTimeoutMs,
			warmCacheWarmupSettleMs,
			cache: 'Cold clears the transform cache; operating-system file caches are not cleared.',
			order: 'One warmup per case; alternating interleaved timed runs.',
		},
		results,
	}, null, 2)}\n`);
};

await main();
