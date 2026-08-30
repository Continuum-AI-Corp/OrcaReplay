/**
 * A deterministic stand-in for the OpenAI Responses API.
 *
 * Shaped after what the Agents SDK and the Codex CLI actually put on the wire: `instructions`
 * rather than a system message, tool traffic as top-level `input` items, and an `output` array
 * whose function calls carry both an item id and the `call_id` a later result references.
 *
 * Turn 1 asks for a file edit; later turns end the conversation. Deterministic on purpose — an
 * exact-replay test cannot tell "replay worked" from "the model happened to agree" otherwise.
 */
import { createServer } from 'node:http';

export async function startResponsesModel(options = {}) {
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

      const input = Array.isArray(body.input) ? body.input : [];
      const turn = input.filter((i) => i.type === 'function_call').length;
      const model = body.model ?? 'gpt-5.2';

      const reply =
        turn === 0
          ? {
              id: `resp_${turn}`,
              object: 'response',
              status: 'completed',
              model,
              output: [
                {
                  type: 'message',
                  id: `msg_${turn}`,
                  role: 'assistant',
                  status: 'completed',
                  content: [{ type: 'output_text', text: 'editing auth.ts', annotations: [] }],
                },
                {
                  type: 'function_call',
                  id: `fc_${turn}`,
                  call_id: `call_${turn}`,
                  name: 'edit_file',
                  arguments: JSON.stringify({ path: 'auth.ts', content: editContent }),
                  status: 'completed',
                },
              ],
              usage: {
                input_tokens: 100 + turn,
                output_tokens: 20 + turn,
                total_tokens: 120 + turn * 2,
              },
            }
          : {
              id: `resp_${turn}`,
              object: 'response',
              status: 'completed',
              model,
              output: [
                {
                  type: 'message',
                  id: `msg_${turn}`,
                  role: 'assistant',
                  status: 'completed',
                  content: [{ type: 'output_text', text: 'done', annotations: [] }],
                },
              ],
              usage: { input_tokens: 100 + turn, output_tokens: 5, total_tokens: 105 + turn },
            };

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
