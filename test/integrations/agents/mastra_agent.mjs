/**
 * A Mastra agent, which is the Vercel AI SDK case with a framework on top of it.
 *
 * Mastra takes its model from `@ai-sdk/openai`, and that provider takes its origin as a
 * constructor argument rather than from the environment — so base-URL injection reaches nothing
 * here and the capture is the `NODE_OPTIONS` fetch hook, the same layer `hardcoded_origin.mjs`
 * covers. This check is the framework-shaped version of that one: it is worth having both, because
 * a hook that works on a bare `fetch` can still be defeated by a library that wraps it.
 */
import { openai } from '@ai-sdk/openai';
import { Agent } from '@mastra/core/agent';

const agent = new Agent({
  name: 'stub-agent',
  instructions: 'Answer in one short sentence.',
  model: openai('stub-1'),
});

const res = await agent.generate('hello');
console.log('GOT:', res.text);
