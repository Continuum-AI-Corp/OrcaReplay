/**
 * Muse Code's capture needs one thing orca will not do, and this is the smallest thing that does
 * it.
 *
 * Muse fetches a model catalogue with `GET /muse-code/models` and refuses to build a turn until
 * that succeeds. orca's proxy answers 404 to every non-POST by design — "Only a POST is ever a
 * model call", and relaxing that once let a PUT be recorded as a model exchange. Neither side is
 * wrong, so the catalogue is answered here instead: this process sits in front of orca, serves
 * that one GET itself, and forwards everything else byte for byte. The turn that carries the
 * prompt still goes to orca and is recorded as a `/responses` exchange, which is what the capture
 * is for.
 *
 * The second thing it handles is smaller but just as fatal. Muse takes its origin from a
 * `--base-url` flag rather than a variable, and *discards any path on it* — measured: given
 * `http://127.0.0.1:47001/deep/path` it still requests `/muse-code/models` at the root. So
 * `/forward/<origin>`, which is how every other config-route capture here carries the operator's
 * own upstream, cannot be used: the path is the payload and Muse throws it away. orca's proxy
 * origin is passed in bare, through `MUSE_PROXY`.
 *
 * Launched by `capture.mjs muse`. `MUSE_PROXY` is set by orca itself, named through
 * `ORCA_BASE_URL_VARS`; `MUSE_BIN` overrides the binary for an install that is not on PATH.
 */
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';

const PLACEHOLDER_KEY = 'orca-recorded';
const prompt = process.argv[2] ?? '';
const model = process.argv[3] || 'muse-spark-1.3';
const bin = process.env.MUSE_BIN || 'muse';

const proxy = process.env.MUSE_PROXY;
if (!proxy || !/^https?:\/\//.test(proxy)) {
  console.error(
    'muse-shim: MUSE_PROXY is not an origin. It is set by orca from ORCA_BASE_URL_VARS; run this ' +
      'through `capture.mjs muse` rather than directly.',
  );
  process.exit(2);
}
const up = new URL(proxy);

/**
 * What the catalogue answer has to contain, and nothing more.
 *
 * Muse reads this to decide the model exists before it will build a request; the ids are the ones
 * its own binary names. A catalogue is not a model call, so serving it here does not put anything
 * in the trace that the harness did not send.
 */
const catalogue = JSON.stringify({
  object: 'list',
  data: ['muse-spark-1.3', 'muse-spark-1.2'].map((id) => ({
    id,
    object: 'model',
    display_name: id,
    owned_by: 'meta',
    created: 1750000000,
    context_window: 1_000_000,
    max_output_tokens: 64_000,
    capabilities: {
      text: true,
      images: true,
      tool_calls: true,
      parallel_tool_calls: true,
      structured_output: true,
      reasoning: true,
    },
  })),
});

const server = createServer((req, res) => {
  if (req.method === 'GET' && (req.url ?? '').includes('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(catalogue);
    return;
  }
  const headers = { ...req.headers, host: up.host };
  const forwarded = httpRequest(
    { hostname: up.hostname, port: up.port, path: req.url, method: req.method, headers },
    (from) => {
      res.writeHead(from.statusCode ?? 502, from.headers);
      from.pipe(res);
    },
  );
  forwarded.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `muse-shim: ${err.message}` } }));
  });
  req.pipe(forwarded);
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  console.error(`muse-shim: ${base} -> ${proxy} (catalogue served locally)`);
  // `--api-key-stdin` rather than META_API_KEY: the variable path was measured answering without
  // calling the model at all, and a capture that never reaches the proxy is not a capture.
  const child = spawn(
    bin,
    ['exec', prompt, '--base-url', base, '--model', model, '--api-key-stdin'],
    {
      stdio: ['pipe', 'inherit', 'inherit'],
      shell: process.platform === 'win32' && !/\.(exe|com)$/i.test(bin),
    },
  );
  child.stdin.end(`${PLACEHOLDER_KEY}\n`);
  child.on('error', (err) => {
    console.error(`muse-shim: cannot launch ${bin}: ${err.message}`);
    server.close();
    process.exit(127);
  });
  child.on('exit', (code) => {
    server.close();
    process.exit(code ?? 0);
  });
});
