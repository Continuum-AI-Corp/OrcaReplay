"""Checkpoint derivation, ported case for case from packages/core/test/graph.test.ts.

These cases are the behavioural contract of spec §3. They are duplicated rather than shared
because the point of a second implementation is that it can disagree — and be caught.
"""

from __future__ import annotations

from typing import Any

import pytest

from orca_trace import Checkpoint, TraceEvent, causal_chain, derive_checkpoints, snap_to_checkpoint, turns_of


def ev(seq: int, type_: str, **over: Any) -> TraceEvent:
    raw: dict[str, Any] = {
        "seq": seq,
        "ts": "2026-08-29T10:00:00.000Z",
        "mono_us": seq * 1000,
        "turn": 0,
        "type": type_,
        "actor": "orca",
    }
    raw.update(over)
    return TraceEvent.from_json(raw)


#: run.start, a snapshot, then a complete model exchange, then a note.
SIMPLE = [
    ev(0, "run.start"),
    ev(1, "fs.snapshot", attrs={"tree": "tree-a"}),
    ev(2, "model.request", actor="gateway"),
    ev(3, "model.response", actor="model"),
    ev(4, "note"),
]


class TestDeriveCheckpoints:
    def test_finds_nothing_without_a_snapshot(self) -> None:
        """No fs.snapshot means no state to fork from, whatever the conversation did."""
        assert derive_checkpoints([ev(0, "run.start"), ev(1, "note")]) == []

    def test_starts_at_the_snapshot_never_before_it(self) -> None:
        assert [c.seq for c in derive_checkpoints(SIMPLE)] == [1, 2, 3, 4]

    def test_carries_the_tree_id_from_the_governing_snapshot(self) -> None:
        assert {c.fs_tree for c in derive_checkpoints(SIMPLE)} == {"tree-a"}

    def test_uses_the_most_recent_snapshot_in_the_turn(self) -> None:
        events = [
            ev(0, "fs.snapshot", attrs={"tree": "old"}),
            ev(1, "note"),
            ev(2, "fs.snapshot", attrs={"tree": "new"}),
            ev(3, "note"),
        ]
        by_seq = {c.seq: c for c in derive_checkpoints(events)}
        assert by_seq[1].fs_tree == "old"
        assert by_seq[3].fs_tree == "new"

    def test_leaves_the_tree_unset_when_the_snapshot_recorded_none(self) -> None:
        cps = derive_checkpoints([ev(0, "fs.snapshot"), ev(1, "note")])
        assert [c.seq for c in cps] == [0, 1]
        assert cps[0].fs_tree is None

    def test_ignores_a_non_string_tree_attribute(self) -> None:
        cps = derive_checkpoints([ev(0, "fs.snapshot", attrs={"tree": 7}), ev(1, "note")])
        assert cps[0].fs_tree is None

    def test_does_not_carry_a_snapshot_across_a_turn_boundary(self) -> None:
        events = [
            ev(0, "fs.snapshot", attrs={"tree": "tree-a"}),
            ev(1, "note"),
            ev(2, "note", turn=1),
        ]
        assert [c.seq for c in derive_checkpoints(events)] == [0, 1]

    def test_records_the_turn_of_each_checkpoint(self) -> None:
        events = [
            ev(0, "fs.snapshot", attrs={"tree": "t0"}),
            ev(1, "fs.snapshot", turn=1, attrs={"tree": "t1"}),
            ev(2, "note", turn=1),
        ]
        assert derive_checkpoints(events) == [
            Checkpoint(seq=0, turn=0, fs_tree="t0"),
            Checkpoint(seq=1, turn=1, fs_tree="t1"),
            Checkpoint(seq=2, turn=1, fs_tree="t1"),
        ]

    def test_stops_at_an_unanswered_model_request(self) -> None:
        """State past a hung request is unknown — but the request itself is still forkable,
        because retrying it is exactly what someone wants."""
        events = [
            ev(0, "fs.snapshot", attrs={"tree": "tree-a"}),
            ev(1, "model.request", actor="gateway"),
            ev(2, "note"),
            ev(3, "note"),
        ]
        assert [c.seq for c in derive_checkpoints(events)] == [0, 1]

    def test_resumes_across_turns_while_every_exchange_is_answered(self) -> None:
        events = [
            ev(0, "run.start"),
            ev(1, "fs.snapshot", attrs={"tree": "t0"}),
            ev(2, "model.request", actor="gateway"),
            ev(3, "model.response", actor="model"),
            ev(4, "fs.snapshot", turn=1, attrs={"tree": "t1"}),
            ev(5, "model.request", turn=1, actor="gateway"),
        ]
        cps = derive_checkpoints(events)
        assert [c.seq for c in cps] == [1, 2, 3, 4, 5]
        assert cps[-1].fs_tree == "t1"

    def test_pairs_requests_and_responses_in_order(self) -> None:
        """One late reply does not unblock the next request: pairing is positional."""
        events = [
            ev(0, "fs.snapshot", attrs={"tree": "t0"}),
            ev(1, "model.request", actor="gateway"),
            ev(2, "model.response", actor="model"),
            ev(3, "model.request", actor="gateway"),
            ev(4, "note"),
        ]
        assert [c.seq for c in derive_checkpoints(events)] == [0, 1, 2, 3]

    def test_reads_events_that_arrive_out_of_order(self) -> None:
        shuffled = [SIMPLE[3], SIMPLE[0], SIMPLE[4], SIMPLE[2], SIMPLE[1]]
        assert [c.seq for c in derive_checkpoints(shuffled)] == [1, 2, 3, 4]

    def test_does_not_mutate_the_caller_s_list(self) -> None:
        shuffled = [SIMPLE[3], SIMPLE[0], SIMPLE[4], SIMPLE[2], SIMPLE[1]]
        before = list(shuffled)
        derive_checkpoints(shuffled)
        assert shuffled == before

    def test_accepts_any_iterable_of_events(self) -> None:
        assert [c.seq for c in derive_checkpoints(iter(SIMPLE))] == [1, 2, 3, 4]

    def test_handles_an_empty_trace(self) -> None:
        assert derive_checkpoints([]) == []


class TestSnapToCheckpoint:
    CPS = derive_checkpoints(
        [
            ev(0, "run.start"),
            ev(1, "fs.snapshot", attrs={"tree": "t0"}),
            ev(2, "note"),
            ev(3, "fs.snapshot", turn=1, attrs={"tree": "t1"}),
            ev(4, "note", turn=1),
        ]
    )

    def test_does_not_move_when_the_target_is_already_a_checkpoint(self) -> None:
        checkpoint, snapped = snap_to_checkpoint(self.CPS, 3)
        assert checkpoint.seq == 3
        assert snapped is False

    def test_moves_back_to_the_nearest_preceding_checkpoint_and_says_so(self) -> None:
        gapped = [Checkpoint(2, 0, "t0"), Checkpoint(7, 1, "t1")]
        checkpoint, snapped = snap_to_checkpoint(gapped, 5)
        assert checkpoint.seq == 2
        assert snapped is True

    def test_never_snaps_forward_at_any_target(self) -> None:
        """Forking from state the run had not reached yet is silent corruption (spec §3)."""
        gapped = [Checkpoint(2, 0), Checkpoint(5, 1), Checkpoint(9, 2)]
        for target in range(2, 15):
            checkpoint, snapped = snap_to_checkpoint(gapped, target)
            expected = max(c.seq for c in gapped if c.seq <= target)
            assert checkpoint.seq == expected, f"target {target}"
            assert snapped == (checkpoint.seq != target)

    def test_snaps_a_target_past_the_end_back_to_the_last_checkpoint(self) -> None:
        checkpoint, snapped = snap_to_checkpoint(self.CPS, 9999)
        assert checkpoint.seq == 4
        assert snapped is True

    def test_returns_the_checkpoint_whole_including_its_tree(self) -> None:
        assert snap_to_checkpoint(self.CPS, 4)[0] == Checkpoint(seq=4, turn=1, fs_tree="t1")

    def test_refuses_a_target_before_the_first_checkpoint(self) -> None:
        with pytest.raises(ValueError, match="no checkpoint at or before 0"):
            snap_to_checkpoint(self.CPS, 0)
        with pytest.raises(ValueError, match="1"):
            snap_to_checkpoint(self.CPS, 0)

    def test_refuses_when_the_trace_has_no_checkpoints_at_all(self) -> None:
        with pytest.raises(ValueError, match="(?i)no checkpoints"):
            snap_to_checkpoint([], 4)

    def test_tolerates_an_unsorted_checkpoint_list(self) -> None:
        unsorted = [Checkpoint(9, 2), Checkpoint(2, 0), Checkpoint(5, 1)]
        assert snap_to_checkpoint(unsorted, 8)[0].seq == 5


class TestTurnsOf:
    def test_groups_events_into_turns_with_their_span(self) -> None:
        events = [ev(0, "run.start"), ev(1, "note"), ev(2, "note", turn=1), ev(3, "run.end", turn=1)]
        turns = turns_of(events)
        assert [(t.turn, t.start_seq, t.end_seq) for t in turns] == [(0, 0, 1), (1, 2, 3)]
        assert [e.seq for e in turns[1].events] == [2, 3]

    def test_orders_turns_numerically_even_when_the_log_interleaves_them(self) -> None:
        events = [ev(0, "note", turn=2), ev(1, "note", turn=1), ev(2, "note", turn=2)]
        assert [t.turn for t in turns_of(events)] == [1, 2]
        assert len(turns_of(events)[1].events) == 2

    def test_handles_an_empty_trace(self) -> None:
        assert turns_of([]) == []


class TestCausalChain:
    EVENTS = [
        ev(0, "run.start"),
        ev(1, "model.request", causes=[0]),
        ev(2, "model.response", causes=[1]),
        ev(3, "tool.call", causes=[2]),
        ev(4, "note"),
    ]

    def test_walks_causes_transitively_oldest_first(self) -> None:
        assert [e.seq for e in causal_chain(self.EVENTS, 3)] == [0, 1, 2, 3]

    def test_returns_just_the_event_when_nothing_caused_it(self) -> None:
        assert [e.seq for e in causal_chain(self.EVENTS, 4)] == [4]

    def test_visits_a_shared_ancestor_once(self) -> None:
        diamond = [
            ev(0, "run.start"),
            ev(1, "tool.call", causes=[0]),
            ev(2, "tool.call", causes=[0]),
            ev(3, "note", causes=[1, 2]),
        ]
        assert [e.seq for e in causal_chain(diamond, 3)] == [0, 1, 2, 3]

    def test_terminates_on_a_malformed_cycle_instead_of_hanging(self) -> None:
        cyclic = [ev(0, "note", causes=[1]), ev(1, "note", causes=[0])]
        assert [e.seq for e in causal_chain(cyclic, 1)] == [0, 1]

    def test_skips_a_cause_that_is_not_in_the_trace(self) -> None:
        """Readers drop unknown event types, so an ancestor may legitimately be missing."""
        gapped = [ev(0, "run.start"), ev(2, "note", causes=[1, 0])]
        assert [e.seq for e in causal_chain(gapped, 2)] == [0, 2]

    def test_reports_a_seq_that_is_not_in_the_trace(self) -> None:
        with pytest.raises(ValueError, match="42"):
            causal_chain(self.EVENTS, 42)
