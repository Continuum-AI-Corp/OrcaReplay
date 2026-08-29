import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  Adapter,
  CanonicalContent,
  CanonicalRequest,
  Provider,
  RecordContext,
} from '../src/index.js';

/**
 * plugin-api is types-only, so these are compile-time contracts. They fail the build if the
 * published interface shape changes, which is exactly what an ecosystem depends on.
 */
describe('canonical IR', () => {
  it('models a full tool round trip', () => {
    const req: CanonicalRequest = {
      model: 'claude-opus-5',
      system: 'be terse',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'fix the test' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: { cmd: 'npm test' } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'FAIL', is_error: true }],
        },
      ],
      tools: [{ name: 'bash', input_schema: { type: 'object' } }],
      max_tokens: 1024,
    };
    expect(req.messages).toHaveLength(3);
    expect(req.messages[1]?.content[0]?.type).toBe('tool_use');
  });

  it('discriminates content blocks by type', () => {
    const block: CanonicalContent = { type: 'text', text: 'hi' };
    if (block.type === 'text') expectTypeOf(block.text).toBeString();
  });

  it('keeps the Adapter surface to detect + prepare', () => {
    expectTypeOf<Adapter>().toHaveProperty('detect');
    expectTypeOf<Adapter>().toHaveProperty('prepare');
    expectTypeOf<Adapter>().toHaveProperty('id');
  });

  it('keeps the Provider surface to models + invoke + price', () => {
    expectTypeOf<Provider>().toHaveProperty('models');
    expectTypeOf<Provider>().toHaveProperty('invoke');
    expectTypeOf<Provider>().toHaveProperty('price');
  });

  it('hands adapters the proxy url they must inject', () => {
    expectTypeOf<RecordContext>().toHaveProperty('proxyUrl');
    expectTypeOf<RecordContext>().toHaveProperty('runDir');
  });
});
