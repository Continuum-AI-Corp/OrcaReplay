import { describe, expect, it } from 'vitest';
import { stripJsonc } from '../src/opencode-config.js';

/**
 * The stripper stands between the user's JSONC config and `JSON.parse`, so every way a comment or
 * a trailing comma can hide inside a value matters: a URL in prose, a comma inside a string, a
 * block comment spanning lines. Breaking any of them corrupts a config that would have parsed,
 * and the adapter then either captures nothing or reroutes on a guess.
 */
describe('stripJsonc', () => {
  it('parses plain JSON unchanged', () => {
    const text = '{"a":1,"b":[2,3]}';
    expect(JSON.parse(stripJsonc(text))).toEqual({ a: 1, b: [2, 3] });
  });

  it('strips line comments, including ones holding urls', () => {
    const text = [
      '{',
      '  // see https://example.com/docs for why',
      '  "provider": {}, // trailing prose',
      '}',
    ].join('\n');
    expect(JSON.parse(stripJsonc(text))).toEqual({ provider: {} });
  });

  it('strips block comments and keeps the tokens either side apart', () => {
    const text = '{"a"/* the key */:/* the value */1}';
    expect(JSON.parse(stripJsonc(text))).toEqual({ a: 1 });
  });

  it('leaves comment and comma syntax inside strings alone', () => {
    const text = '{"url":"https://example.com/a,//b","note":"keep , this } one"}';
    expect(JSON.parse(stripJsonc(text))).toEqual({
      url: 'https://example.com/a,//b',
      note: 'keep , this } one',
    });
  });

  it('honours escaped quotes inside strings', () => {
    const text = '{"say":"a \\"comment\\" // here"}';
    expect(JSON.parse(stripJsonc(text))).toEqual({ say: 'a "comment" // here' });
  });

  it('removes trailing commas in objects and arrays', () => {
    const text = '{"a":[1,2,3,],"b":{"c":1,},}';
    expect(JSON.parse(stripJsonc(text))).toEqual({ a: [1, 2, 3], b: { c: 1 } });
  });

  it('keeps the comma a value legitimately ends with from being read as trailing', () => {
    const text = '{"a":[1,2] ,"b":3}';
    expect(JSON.parse(stripJsonc(text))).toEqual({ a: [1, 2], b: 3 });
  });

  it('survives an unterminated string by stopping at the end of input', () => {
    // The caller treats a failed parse as an untrusted config; the stripper's job is only to
    // never throw on the way there.
    expect(() => JSON.parse(stripJsonc('{"a":"unterminated'))).toThrow();
  });

  it('survives an unterminated block comment', () => {
    expect(() => JSON.parse(stripJsonc('{"a":1 /* never closed'))).toThrow();
  });
});
