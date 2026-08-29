import { describe, expect, it } from 'vitest';
import { JsonRpcFramer } from '../src/index.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('JsonRpcFramer', () => {
  it('emits one frame per newline-delimited message', () => {
    const framer = new JsonRpcFramer();
    const frames = framer.push(enc('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n'));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.kind).toBe('request');
    expect(frames[0]?.id).toBe(1);
    expect(frames[0]?.method).toBe('tools/list');
    expect(frames[0]?.raw).toBe('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
    expect(frames[0]?.message).toEqual({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  });

  it('reassembles a message split across three chunks', () => {
    const framer = new JsonRpcFramer();
    expect(framer.push(enc('{"jsonrpc":"2.0",'))).toEqual([]);
    expect(framer.push(enc('"id":7,"method":"res'))).toEqual([]);
    const frames = framer.push(enc('ources/read"}\n'));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.id).toBe(7);
    expect(frames[0]?.method).toBe('resources/read');
  });

  it('emits both messages when two arrive in one chunk', () => {
    const framer = new JsonRpcFramer();
    const frames = framer.push(
      enc('{"jsonrpc":"2.0","id":1,"result":{}}\n{"jsonrpc":"2.0","method":"notify"}\n'),
    );
    expect(frames.map((f) => f.kind)).toEqual(['response', 'notification']);
  });

  it('holds back a partial second message until its newline arrives', () => {
    const framer = new JsonRpcFramer();
    const first = framer.push(enc('{"id":1,"result":1}\n{"id":2,'));
    expect(first).toHaveLength(1);
    const second = framer.push(enc('"result":2}\n'));
    expect(second).toHaveLength(1);
    expect(second[0]?.id).toBe(2);
  });

  it('rejoins a multibyte character split across a chunk boundary', () => {
    const framer = new JsonRpcFramer();
    const line = '{"jsonrpc":"2.0","id":1,"result":{"text":"ok \u{1F419} done"}}\n';
    const bytes = new TextEncoder().encode(line);
    const emojiStart = Buffer.from(bytes).indexOf(Buffer.from('\u{1F419}', 'utf8'));
    const cut = emojiStart + 2; // mid-surrogate: two of the emoji's four bytes
    expect(framer.push(bytes.slice(0, cut))).toEqual([]);
    const frames = framer.push(bytes.slice(cut));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.raw).toBe(line.slice(0, -1));
    expect((frames[0]?.message as any).result.text).toBe('ok \u{1F419} done');
  });

  it('reports a malformed line as unknown instead of throwing', () => {
    const framer = new JsonRpcFramer();
    let frames: ReturnType<JsonRpcFramer['push']> = [];
    expect(() => {
      frames = framer.push(enc('this is not json\n'));
    }).not.toThrow();
    expect(frames).toHaveLength(1);
    expect(frames[0]?.kind).toBe('unknown');
    expect(frames[0]?.raw).toBe('this is not json');
    expect(frames[0]?.message).toBeUndefined();
  });

  it('keeps parsing after a malformed line', () => {
    const framer = new JsonRpcFramer();
    const frames = framer.push(enc('garbage {\n{"jsonrpc":"2.0","id":3,"method":"ping"}\n'));
    expect(frames.map((f) => f.kind)).toEqual(['unknown', 'request']);
    expect(frames[1]?.id).toBe(3);
  });

  it('ignores empty and whitespace-only lines', () => {
    const framer = new JsonRpcFramer();
    expect(framer.push(enc('\n'))).toEqual([]);
    expect(framer.push(enc('   \n\n'))).toEqual([]);
    const frames = framer.push(enc('\n{"id":1,"method":"ping"}\n\n'));
    expect(frames).toHaveLength(1);
  });

  it('strips a carriage return from CRLF-terminated lines', () => {
    const framer = new JsonRpcFramer();
    const frames = framer.push(enc('{"id":1,"method":"ping"}\r\n'));
    expect(frames[0]?.raw).toBe('{"id":1,"method":"ping"}');
    expect(frames[0]?.kind).toBe('request');
  });

  it('classifies every JSON-RPC shape', () => {
    const framer = new JsonRpcFramer();
    const frames = framer.push(
      enc(
        [
          '{"jsonrpc":"2.0","id":1,"method":"tools/call"}',
          '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}',
          '{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"nope"}}',
          '{"jsonrpc":"2.0","method":"notifications/initialized"}',
          '42',
          '[{"id":1,"method":"ping"}]',
        ].join('\n') + '\n',
      ),
    );
    expect(frames.map((f) => f.kind)).toEqual([
      'request',
      'response',
      'response',
      'notification',
      'unknown',
      'unknown',
    ]);
    expect(frames[4]?.message).toBe(42);
  });

  it('keeps a string id and the falsy id 0', () => {
    const framer = new JsonRpcFramer();
    const frames = framer.push(
      enc('{"id":"abc","method":"ping"}\n{"id":0,"method":"ping"}\n{"method":"ping"}\n'),
    );
    expect(frames[0]?.id).toBe('abc');
    expect(frames[1]?.id).toBe(0);
    expect(frames[1]?.kind).toBe('request');
    expect(frames[2]?.id).toBeUndefined();
  });

  it('emits a trailing unterminated line only on flush', () => {
    const framer = new JsonRpcFramer();
    expect(framer.push(enc('{"id":9,"method":"ping"}'))).toEqual([]);
    const flushed = framer.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.id).toBe(9);
    expect(framer.flush()).toEqual([]);
  });

  it('flushes a dangling multibyte character without throwing', () => {
    const framer = new JsonRpcFramer();
    const bytes = new TextEncoder().encode('\u{1F419}');
    framer.push(bytes.slice(0, 2));
    expect(() => framer.flush()).not.toThrow();
  });
});
