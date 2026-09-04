import type { Adapter, Launch, RecordContext } from '@orcareplay/plugin-api';
import { detectAgent } from './detect.js';

/**
 * Hermes, Nous Research's agent — the first Python harness orca records.
 *
 * Every other adapter here fronts a Node harness, and that difference is the whole reason this
 * one exists. Nothing is redirected: `OPENAI_BASE_URL` is not a route into Hermes. Its origin
 * lives in `config.yaml` under `model.base_url`, and the environment variable is read in only one
 * place -- an advisory warning that fires when it is set and the provider is *not* `custom`.
 * Verified against a logging listener rather than inferred: with `model.base_url` pointed at a
 * dead port and `OPENAI_BASE_URL` at a live one, the run dies on the dead port and the listener
 * records nothing, `--provider custom` included.
 *
 * What does work is the transport. Hermes honours `HTTPS_PROXY` all the way down -- through a
 * proxy that logs CONNECT targets, a single question sends two of them to the model origin, the
 * model-catalogue read and the completion -- so `--tls-intercept` reaches it.
 *
 * The trust store needs no special handling, which is worth saying because it looks as though it
 * would. Hermes makes those two calls with two different HTTP libraries -- `requests` for the
 * catalogue and httpx under the OpenAI SDK for the completion -- and httpx pins certifi, so the
 * usual `SSL_CERT_FILE` should not reach it. Hermes resolves that client's CA itself, and the
 * chain in `agent/ssl_verify.py` reads `HERMES_CA_BUNDLE`, then `SSL_CERT_FILE`, then
 * `REQUESTS_CA_BUNDLE`, then `CURL_CA_BUNDLE`. orca already sets the second, so the run CA is
 * trusted by both clients with nothing added. Checked by removing the vendor variable and
 * recording again: same one model exchange, status 200, 10,615 input tokens.
 *
 * `inference-api.nousresearch.com` is in `DEFAULT_TLS_HOSTS`, so Hermes on Nous' own models needs
 * no extra `--tls-hosts`. Deliberately not in that list: `portal.nousresearch.com`, which is
 * billing and subscription management and where the API key is issued.
 *
 * The fixture below was verified against `--provider opencode-free`, whose tier is served
 * anonymously -- no key, so no credential to leak into a recording. That origin needs
 * `--tls-hosts '+opencode.ai'` and does not get a default entry: unlike `api.kilo.ai` or
 * `api.xiaomimimo.com` it is a website as much as a gateway, and a default that decrypted it would
 * decrypt whatever else is served there.
 *
 *     orca record hermes --tls-intercept --tls-hosts '+opencode.ai' -- \
 *       --provider opencode-free -m nemotron-3.5-lightning-free -z 'your question'
 *
 * `-z` is the non-interactive flag; without it Hermes opens a session and waits.
 */
export const hermesAdapter: Adapter = {
  id: 'hermes',
  aliases: ['hermes-agent', 'nous-hermes'],
  harnessVersions: '>=0.21.0',

  // Redirecting nothing is the intent, not a defect. See the `capture` field on `Adapter`.
  capture: 'transport',

  async detect(_cwd: string): Promise<boolean> {
    // `AppData/Local/hermes` is where the Windows install keeps `config.yaml`; the XDG paths are
    // the same directory on the other platforms. Home-relative, so an install moved with
    // `HERMES_HOME` is still found by its binary.
    return detectAgent(['hermes'], ['AppData/Local/hermes', '.config/hermes', '.hermes']);
  },

  async prepare(ctx: RecordContext): Promise<Launch> {
    // No origin and no credential. Hermes keeps both in `config.yaml` and its own secret store,
    // and an adapter that injected either would override a choice made there -- for the origin it
    // could not anyway, per the note above.
    return { command: 'hermes', args: [...ctx.userArgs], env: {} };
  },
};
