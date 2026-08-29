"""Derived structure over a trace: checkpoints, turns, and causal chains (spec §3).

This is a deliberate re-implementation of `packages/core/src/graph.ts`, case for case. Any
disagreement between the two is a defect in the spec, not a difference of opinion — a fork target
that snaps to a different seq in Python than in TypeScript would resume a run from state the other
implementation never had.
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field
from collections.abc import Iterable, Sequence

from .models import Checkpoint, TraceEvent

__all__ = ["Turn", "causal_chain", "derive_checkpoints", "snap_to_checkpoint", "turns_of"]


@dataclass(frozen=True, slots=True)
class Turn:
    """The events of one model turn, in log order."""

    turn: int
    start_seq: int
    end_seq: int
    events: tuple[TraceEvent, ...] = field(default_factory=tuple)


def _by_seq(events: Iterable[TraceEvent]) -> list[TraceEvent]:
    """A copy in total order. The caller's sequence is never reordered in place."""
    return sorted(events, key=lambda e: e.seq)


def _first_unanswered_request(ordered: Sequence[TraceEvent]) -> float:
    """The seq of the first `model.request` with no reply, or infinity if the log is whole.

    Requests and responses are paired positionally, so a second request that is still in flight is
    not excused by the first one's reply. Everything after an unanswered request is un-forkable:
    the model's effect on the run is unknown there.
    """
    requests = [e for e in ordered if e.type == "model.request"]
    responses = [e for e in ordered if e.type == "model.response"]
    for i, request in enumerate(requests):
        response = responses[i] if i < len(responses) else None
        if response is None or response.seq <= request.seq:
            return request.seq
    return math.inf


def derive_checkpoints(events: Iterable[TraceEvent]) -> list[Checkpoint]:
    """Every seq satisfying both checkpoint conditions of spec §3.

    That is: an `fs.snapshot` at or before it within the same turn, and a complete conversation
    prefix. The unanswered request itself is included — it is the point someone wants to retry.
    """
    ordered = _by_seq(events)
    cutoff = _first_unanswered_request(ordered)
    checkpoints: list[Checkpoint] = []
    snapshot: tuple[int, str | None] | None = None

    for event in ordered:
        if event.seq > cutoff:
            break
        if event.type == "fs.snapshot":
            tree = event.attrs.get("tree")
            snapshot = (event.turn, tree if isinstance(tree, str) else None)
        # A snapshot only vouches for the state of its own turn; work in a later turn has moved on.
        if snapshot is None or snapshot[0] != event.turn:
            continue
        checkpoints.append(Checkpoint(seq=event.seq, turn=event.turn, fs_tree=snapshot[1]))
    return checkpoints


def snap_to_checkpoint(
    checkpoints: Iterable[Checkpoint], target: int
) -> tuple[Checkpoint, bool]:
    """The checkpoint a fork of `target` must actually start from, and whether it had to move.

    Never rounds forward. Forking from state the run had not reached yet produces a child run that
    silently disagrees with its parent, which is worse than refusing outright — hence the raise
    rather than a `None` a caller can ignore.
    """
    ordered = sorted(checkpoints, key=lambda c: c.seq)
    if not ordered:
        raise ValueError(
            f"cannot fork at seq {target}: this run has no checkpoints "
            "— it recorded no fs.snapshot"
        )
    found: Checkpoint | None = None
    for checkpoint in ordered:
        if checkpoint.seq > target:
            break
        found = checkpoint
    if found is None:
        raise ValueError(
            f"no checkpoint at or before {target}: "
            f"the earliest forkable seq is {ordered[0].seq}"
        )
    return found, found.seq != target


def turns_of(events: Iterable[TraceEvent]) -> list[Turn]:
    """The events of a run grouped into model turns, in turn order."""
    buckets: dict[int, list[TraceEvent]] = {}
    for event in _by_seq(events):
        buckets.setdefault(event.turn, []).append(event)
    return [
        Turn(turn=turn, start_seq=group[0].seq, end_seq=group[-1].seq, events=tuple(group))
        for turn, group in sorted(buckets.items())
    ]


def causal_chain(events: Iterable[TraceEvent], seq: int) -> list[TraceEvent]:
    """The event at `seq` and everything transitively named by `causes`, oldest first."""
    index = {e.seq: e for e in events}
    start = index.get(seq)
    if start is None:
        raise ValueError(f"no event with seq {seq} in this trace")

    seen = {seq}
    queue = deque([start])
    chain: list[TraceEvent] = []
    while queue:
        event = queue.popleft()
        chain.append(event)
        for cause in event.causes:
            # A cycle is malformed, and an ancestor may be missing because the reader skipped an
            # unknown event type. Neither may stop the walk.
            if cause in seen:
                continue
            seen.add(cause)
            parent = index.get(cause)
            if parent is not None:
                queue.append(parent)
    return sorted(chain, key=lambda e: e.seq)
