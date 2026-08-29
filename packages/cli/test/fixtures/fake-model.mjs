/**
 * A deterministic stand-in for a model API, so end-to-end tests never touch the network.
 *
 * Turn 1 asks for a file edit, later turns end the conversation. Deterministic on purpose: an
 * exact-replay test cannot distinguish "replay worked" from "the model happened to agree" unless
 * the recording is reproducible in the first place.
 */
import { createServer } from 'node:http';

export async function startFakeModel(options = {}) {
  const calls = [];
  const editContent = options.editContent ?? 'export const fixed = true;\n';

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* fall through to the default reply */
      }
      calls.push({ url: req.url, body });

      const turn = (body.messages ?? []).filter((m) => m.role === 'assistant').length;
      const wantsEdit = turn === 0;

      const reply = wantsEdit
        ? {
            id: `msg_${turn}`,
            type: 'message',
            role: 'assistant',
            model: body.model ?? 'claude-opus-5',
            content: [
              { type: 'text', text: 'editing auth.ts' },
              {
                type: 'tool_use',
                id: `tu_${turn}`,
                name: 'edit_file',
                input: { path: 'auth.ts', content: editContent },
              },
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 100 + turn, output_tokens: 20 + turn },
          }
        : {
            id: `msg_${turn}`,
            type: 'message',
            role: 'assistant',
            model: body.model ?? 'claude-opus-5',
            content: [{ type: 'text', text: 'done' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 100 + turn, output_tokens: 5 },
          };

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
