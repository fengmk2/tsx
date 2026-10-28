import { fileURLToPath } from 'node:url';
import {
	describe, test, expect, setProcessTimeout,
} from 'manten';
import { createNode } from './utils/tsx';
import { nodeVersions } from './utils/node-versions';
import { smoke } from './specs/smoke';
import { api } from './specs/api';
import { cli } from './specs/cli';
import { watch } from './specs/watch';
import { loaders } from './specs/loaders';
import { repl } from './specs/repl';
import { processInteractSpec } from './specs/process-interact';
import { ptyShellSpec } from './specs/pty-shell';
import { tsconfig } from './specs/tsconfig';
import { transformSpec } from './specs/transform';
import { transformCacheSpec } from './specs/transform-cache';
import { oxcTransformSpec } from './specs/oxc-transform';
import { commonJsModeContracts } from './specs/commonjs-mode-contracts';
import { nodeCapabilitiesSpec } from './specs/node-capabilities';
import { versionSensitiveTests } from './specs/version-sensitive';
import { resolutionPriority } from './specs/resolution-priority';
import { esmHookResolve } from './specs/esm-hook-resolve';
import { apiDeclarations } from './specs/api-declarations';

const wasmTransformSpec = (node: Awaited<ReturnType<typeof createNode>>) => test('WASM transform backend', async () => {
	const { exitCode } = await node.tsx([
		'--no-addons',
		fileURLToPath(new URL('transform.ts', import.meta.url)),
	], {
		env: {
			TESTONLY: 'Oxc transform',
			DEBUG: undefined,
		},
	});
	expect(exitCode).toBe(0);
}, 60_000);

(async () => {
	// Prevent stuck CI runs
	setProcessTimeout(5 * 60 * 1000);

	await describe('tsx', async () => {
		await repl();
		await processInteractSpec();
		await ptyShellSpec();
		await transformCacheSpec();
		await transformSpec();
		await oxcTransformSpec();
		await nodeCapabilitiesSpec();
		await esmHookResolve();
		await apiDeclarations();

		const [primaryNodeVersion, ...compatNodeVersions] = nodeVersions;
		const primaryNode = await createNode(primaryNodeVersion);
		await wasmTransformSpec(primaryNode);

		// The primary Node version runs all suites sequentially.
		// Process-heavy suites (cli signals, watch file watchers, PTY shells)
		// cause cross-suite interference when run concurrently on CI.
		await describe(`Node ${primaryNode.version} (full suite)`, async () => {
			await versionSensitiveTests(primaryNode);
			await commonJsModeContracts(primaryNode);
			await smoke(primaryNode);
			await resolutionPriority(primaryNode);
			await api(primaryNode);
			await cli(primaryNode);
			await watch(primaryNode);
			await loaders(primaryNode);
			await tsconfig(primaryNode);
		});

		// Other Node versions exercise both loader boundaries and the actual
		// native/compiler target selected inside that Node process.
		for (const nodeVersion of compatNodeVersions) {
			const node = await createNode(nodeVersion);
			await describe(`Node ${node.version}`, async () => {
				await versionSensitiveTests(node);
				await test('transform backends', async () => {
					const { exitCode } = await node.tsx([
						fileURLToPath(new URL('transform.ts', import.meta.url)),
					], {
						env: {
							TESTONLY: undefined,
							DEBUG: undefined,
						},
					});
					expect(exitCode).toBe(0);
				}, 60_000);
				await wasmTransformSpec(node);
			});
		}
	});
})();
