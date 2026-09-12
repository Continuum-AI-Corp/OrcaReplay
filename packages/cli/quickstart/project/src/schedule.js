/**
 * When does a recurring reminder next fire?
 *
 * A reminder set for "every morning at 09:00" means 09:00 on the user's own clock. The answer is
 * an absolute instant, because that is what a scheduler waits on.
 */

/** The zone's offset from UTC, in milliseconds, at a given instant. */
function offsetAt(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const at = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(at.year),
    Number(at.month) - 1,
    Number(at.day),
    Number(at.hour) % 24,
    Number(at.minute),
    Number(at.second),
  );
  return asUtc - instant.getTime();
}

/** The instant at which `wallClock` reads on the clock in `timeZone`. */
export function instantOf(wallClockIso, timeZone) {
  const naive = new Date(`${wallClockIso}Z`);
  return new Date(naive.getTime() - offsetAt(naive, timeZone));
}

export function nextOccurrence(fromWallClock, days, timeZone) {
  const start = instantOf(fromWallClock, timeZone);
  return new Date(start.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}
