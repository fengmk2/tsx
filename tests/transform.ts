import { describe, setProcessTimeout } from 'manten';
import { transformSpec } from './specs/transform';
import { oxcTransformSpec } from './specs/oxc-transform';

// This entry runs inside each compatibility Node process. Importing the specs
// only in the primary process would always test that process's compiler target.
setProcessTimeout(60_000);

describe('transform backends', async () => {
	await transformSpec();
	await oxcTransformSpec();
});
