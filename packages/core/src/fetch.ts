/**
 * fetch with the DESTINATION PINNED — a redirect is a hard failure, never a hand-off.
 *
 * THE ORIGIN CHECK VALIDATES THE URL WE PASS, NOT THE URL THE REQUEST REACHES (orcacode-review).
 * `resolveGateway` decides whether the key may go to this host, and then `fetch` was free to follow
 * a `Location` anywhere. undici strips `authorization` across origins but NOT `x-api-key`, and
 * gatewayHeaders sets both to the same key — so one header from whoever answers for the gateway
 * carried the replay-scoped credential to a host it was never issued for, defeating the promise the
 * README makes in writing: "Never a key to a host it was not set up for."
 *
 * Push had a second failure on top: a 301/302/303 is re-issued as a GET with no body, so the
 * target's 200 satisfied `res.ok` and the CLI printed `push.done` for a run that went nowhere. A
 * 307/308 instead failed with an opaque "fetch failed", because undici cannot replay a detached
 * body — so a legitimately redirecting gateway could not be talked to either.
 *
 * `manual` rather than `error`: Node resolves it with the real status and Location, so the refusal
 * can NAME the destination. `error` rejects with a bare TypeError whose only distinguishing mark is
 * an undici-internal cause string ("unexpected redirect"), which a genuine connection failure
 * ("bad port") is indistinguishable from without matching on that string.
 *
 * Following a same-origin redirect would be safe and is deliberately not implemented: no gateway
 * this CLI talks to issues one, and an unused branch that forwards credentials is the wrong thing
 * to carry.
 *
 * IT LIVES IN core, NOT IN THE PACKAGE THAT FIRST NEEDED IT (orcacode-review, twice).
 *
 * The first version was local to the CLI's sync.ts, so push and pull were pinned and `probeModels`
 * — the third request carrying the same header pair — was not. The second lived beside
 * gatewayHeaders in the CLI's config.ts, which fixed that and left the RECORDING PROXY out: it is
 * handed the very same credential as `upstreamHeaders` and attaches it to both of its live call
 * sites, on the path every `orca record` / `replay --loose` / `compare` / fork takes.
 *
 * Both times the pin sat in the package that noticed the problem rather than in the one every
 * carrier of the credential depends on. core is that package, so this is the last place it can
 * move to.
 */
export async function fetchPinned(target: string, init: RequestInit): Promise<Response> {
  const res = await fetch(target, { ...init, redirect: 'manual' });
  if (res.status >= 300 && res.status < 400) {
    const to = res.headers.get('location') ?? '(no Location header)';
    throw new Error(
      `${target} answered ${res.status} redirecting to ${to}. orca does not follow it: your key is ` +
        `attached to the host you named, and following would hand it to whatever answers there. ` +
        `Point --gateway (or ORCA_GATEWAY_URL) at the final address instead.`,
    );
  }
  return res;
}
