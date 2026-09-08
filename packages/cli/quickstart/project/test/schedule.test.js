import { strict as assert } from 'node:assert';
import test from 'node:test';
import { nextOccurrence } from '../src/schedule.js';

const NY = 'America/New_York';

// A reminder is a wall-clock promise: 09:00 tomorrow means 09:00 on the user's clock, whatever
// the offset does overnight. New York springs forward at 02:00 on 8 March 2026, so the day is
// 23 hours long and 09:00 the next morning is an hour *earlier* in absolute time.
test('keeps the wall-clock time across the spring transition', () => {
  assert.equal(nextOccurrence('2026-03-07T09:00', 1, NY), '2026-03-08T13:00:00.000Z');
});

// And back again on 1 November: a 25-hour day.
test('keeps the wall-clock time across the autumn transition', () => {
  assert.equal(nextOccurrence('2026-10-31T09:00', 1, NY), '2026-11-01T14:00:00.000Z');
});

test('an ordinary day is unaffected', () => {
  assert.equal(nextOccurrence('2026-06-01T09:00', 1, NY), '2026-06-02T13:00:00.000Z');
});

test('a zone without daylight saving is unaffected', () => {
  assert.equal(nextOccurrence('2026-03-07T09:00', 1, 'Asia/Shanghai'), '2026-03-08T01:00:00.000Z');
});
