import { describe, expect, it } from 'vitest';
import type { Provider, ProviderFactory } from '@orcareplay/plugin-api';
import {
  AnthropicProvider,
  OpenAiCompatibleProvider,
  ProviderRegistry,
  anthropicFactory,
  defaultRegistry,
  openAiCompatibleFactory,
} from '../src/index.js';

const stub: Provider = {
  id: 'stub',
  models: async () => [],
  invoke: async function* () {},
  price: () => null,
};

const stubFactory: ProviderFactory = { id: 'stub', create: () => stub };

describe('ProviderRegistry', () => {
  it('creates a registered provider', () => {
    const registry = new ProviderRegistry();
    registry.register(stubFactory);
    expect(registry.create('stub', {})).toBe(stub);
    expect(registry.ids()).toEqual(['stub']);
  });

  it('hands the options to the factory', () => {
    const registry = new ProviderRegistry();
    let seen: unknown;
    registry.register({
      id: 'spy',
      create: (options) => {
        seen = options;
        return stub;
      },
    });
    registry.create('spy', { apiKey: 'k', baseUrl: 'http://local' });
    expect(seen).toEqual({ apiKey: 'k', baseUrl: 'http://local' });
  });

  it('lets a later registration replace an earlier one', () => {
    const registry = new ProviderRegistry();
    registry.register(stubFactory);
    const replacement: Provider = { ...stub, id: 'replaced' };
    registry.register({ id: 'stub', create: () => replacement });
    expect(registry.create('stub', {}).id).toBe('replaced');
    expect(registry.ids()).toEqual(['stub']);
  });

  it('says what went wrong and what to do when the id is unknown', () => {
    const registry = defaultRegistry();
    let message = '';
    try {
      registry.create('gemini', {});
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('gemini');
    expect(message).toContain('anthropic');
    expect(message).toContain('openai-compatible');
    expect(message).toMatch(/register/i);
  });

  it('still reads sensibly when nothing is registered', () => {
    expect(() => new ProviderRegistry().create('anything', {})).toThrow(/none/i);
    expect(new ProviderRegistry().ids()).toEqual([]);
  });
});

describe('defaultRegistry', () => {
  it('pre-registers both built-in providers', () => {
    expect(defaultRegistry().ids().sort()).toEqual(['anthropic', 'openai-compatible']);
  });

  it('builds real providers', () => {
    const registry = defaultRegistry();
    expect(registry.create('anthropic', { apiKey: 'k' })).toBeInstanceOf(AnthropicProvider);
    expect(registry.create('openai-compatible', { apiKey: 'k' })).toBeInstanceOf(
      OpenAiCompatibleProvider,
    );
  });

  it('is a fresh registry each call, so one caller cannot poison another', () => {
    const first = defaultRegistry();
    first.register(stubFactory);
    expect(defaultRegistry().ids()).not.toContain('stub');
  });

  it('exposes the built-in factories for registries assembled by hand', () => {
    expect(anthropicFactory.id).toBe('anthropic');
    expect(openAiCompatibleFactory().id).toBe('openai-compatible');
  });
});

describe('openAiCompatibleFactory', () => {
  it('names a gateway and supplies its default baseUrl', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: unknown) => {
      calls.push(String(url));
      return new Response('data: [DONE]\n\n', { status: 200 });
    }) as unknown as typeof fetch;

    const registry = defaultRegistry();
    registry.register(
      openAiCompatibleFactory('openrouter', { baseUrl: 'https://openrouter.ai/api/v1' }),
    );
    expect(registry.ids()).toContain('openrouter');

    const provider = registry.create('openrouter', { apiKey: 'k', fetchImpl });
    expect(provider.id).toBe('openrouter');
    for await (const _chunk of provider.invoke({ model: 'gpt-5.2', messages: [] })) void _chunk;
    expect(calls).toEqual(['https://openrouter.ai/api/v1/chat/completions']);
  });

  it('lets the caller override the default baseUrl', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: unknown) => {
      calls.push(String(url));
      return new Response('data: [DONE]\n\n', { status: 200 });
    }) as unknown as typeof fetch;
    const factory = openAiCompatibleFactory('vllm', { baseUrl: 'http://gpu-box:8000/v1' });
    const provider = factory.create({ baseUrl: 'http://other:8000/v1', fetchImpl });
    for await (const _chunk of provider.invoke({ model: 'qwen3-coder', messages: [] })) void _chunk;
    expect(calls).toEqual(['http://other:8000/v1/chat/completions']);
  });
});
