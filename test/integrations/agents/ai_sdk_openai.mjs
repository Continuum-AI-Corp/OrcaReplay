/**
 * A real `@ai-sdk/openai` client, configured only by the environment.
 *
 * This is the check issue #80 asked for. The existing `hardcoded_origin.mjs` and
 * `vercel-agent.mjs` fixtures are a bare `fetch` to a compiled-in origin — they prove the
 * preload, not the SDK. Set `OPENAI_BASE_URL`, install no fetch hook, and the request has
 * to land on the stub. A green result here cannot be "the preload caught it either way".
 *
 * `createOpenAI({ apiKey })` is the construction the docs recommend; an explicit `baseURL`
 * would win and make this check meaningless.
 */
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';

if (/\borca-fetch-hook\b/.test(process.env.NODE_OPTIONS ?? '')) {
  throw new Error('this check is the no-preload path; the fetch hook was injected');
}

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY ?? 'stub-key' });
const { text } = await generateText({
  model: openai('stub-1'),
  prompt: 'hello',
});
console.log('GOT:', text);
