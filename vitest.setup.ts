import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * No test reads the config of whoever is running it.
 *
 * `record`, `replay`, `attach` and `compare` all resolve their upstream through `upstreamPlan()`
 * and `readConfig()` with no environment argument, so they read the real `~/.config/orca`. On a
 * machine where anyone has run `orca setup`, that file names a gateway — and any dialect a test
 * did not override with `--upstream-*` resolves to it. The test then sends a live request to a
 * third party's host, and if every origin happens to be that gateway, `upstreamPlan` attaches the
 * key too.
 *
 * `compare.test.ts` had already found this and worked around it inside one `describe`, noting that
 * "CI passes only because CI has no config". That is the whole diagnosis: nothing platform-
 * specific, nothing wrong with the code under test, and invisible to CI by construction. Doing it
 * once here means no future test has to remember.
 *
 * A directory that exists and is empty, not a missing one: `readConfig` tolerates both, but a real
 * path keeps a test that *writes* a config out of the developer's own.
 */
const isolated = mkdtempSync(join(tmpdir(), 'orca-test-config-'));
process.env['XDG_CONFIG_HOME'] = isolated;
process.on('exit', () => rmSync(isolated, { recursive: true, force: true }));
