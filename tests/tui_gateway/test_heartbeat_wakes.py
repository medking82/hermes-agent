"""A background-process heartbeat is a wake for the model, not a message from the user.

Desktop and the TUI paint every ``prompt.submit`` row as a user bubble unless the backend types it
otherwise, and the process row on the status stack already tells the human the job is running —
so a heartbeat row is ``hidden`` and ``display.background_process_notifications: off`` mutes every
process-driven wake on these surfaces exactly as it does on the messaging gateway.
"""

from __future__ import annotations

import queue
import threading
from types import SimpleNamespace

import pytest
import hermes_yaml as yaml

from tui_gateway import server

HEARTBEAT = {"type": "heartbeat", "session_id": "proc_hb", "seq": 2, "elapsed": 130.0, "interval": 60,
             "command": "npm test", "output": "1 failing\n"}
COMPLETION = {"type": "completion", "session_id": "proc_done", "command": "npm test", "exit_code": 1}
DELEGATION = {"type": "async_delegation", "delegation_id": "d1", "session_key": "s", "results": []}


@pytest.fixture
def surface(monkeypatch):
    submits: list = []
    monkeypatch.setattr("tools.async_delegation.claim_event_delivery", lambda evt, consumer: "claimed")
    monkeypatch.setattr("tools.async_delegation.complete_event_delivery", lambda *a, **k: None)
    monkeypatch.setattr(server, "_run_prompt_submit", lambda rid, sid, session, text, **kw: submits.append((text, kw)))
    monkeypatch.setattr(server, "_emit", lambda *a, **k: None)
    monkeypatch.setattr(server, "_session_owns_notification_event", lambda sid, session, evt: True)
    return submits


def _session(profile_home=None) -> dict:
    return {"history_lock": threading.RLock(), "running": False, "history": [], "agent": None,
            "profile_home": str(profile_home) if profile_home else None}


def test_a_heartbeat_wake_is_typed_hidden(surface):
    session = _session()
    assert server._notif_claim_turn(session) is True

    server._notif_dispatch_event("sid", session, dict(HEARTBEAT), "beat text")

    ((text, kwargs),) = surface
    assert text == "beat text"
    assert kwargs["display_kind"] == "hidden"


def test_off_mutes_process_wakes_but_subagent_results_still_land(surface, tmp_path):
    """The same ``off`` the messaging gateway honours; a finished ``delegate_task(background=true)``
    is a result the user asked for, never a notification to opt out of."""
    (tmp_path / "config.yaml").write_text(
        yaml.safe_dump({"display": {"background_process_notifications": "off"}}), encoding="utf-8"
    )
    session = _session(tmp_path)
    registry = SimpleNamespace(completion_queue=queue.Queue(), is_completion_consumed=lambda session_id: False)
    completions: list = []

    for evt in (HEARTBEAT, COMPLETION):
        assert server._notif_handle_event("sid", session, dict(evt), set(), registry, lambda e: "t", completions) is True
    assert completions == [] and surface == [], "a muted wake never reaches a turn"
    assert session["running"] is False, "and never keeps the session claimed"

    assert server._notif_handle_event("sid", session, dict(DELEGATION), set(), registry, lambda e: "t", completions) is True
    assert [kw["display_kind"] for _, kw in surface] == ["async_delegation_complete"]


def test_the_poller_drops_a_beat_whose_process_already_exited(surface):
    """The Desktop/TUI poller is the other consumer of the same queue. A beat left over from a
    process that has since exited must not claim a turn here either: the completion notice is the
    wake, so the owner is never told "still running" about a job that already ended."""
    from tools.process_registry import ProcessRegistry, ProcessSession

    registry = ProcessRegistry()
    dead = ProcessSession(id="proc_hb", command="npm test", notify_on_complete=True)
    dead.mark_exited(1)
    registry._finished[dead.id] = dead
    session = _session()

    assert server._notif_handle_event("sid", session, dict(HEARTBEAT), set(), registry, lambda e: "t", []) is True
    assert surface == [] and session["running"] is False, "a stale beat claims no turn"

    live = ProcessSession(id="proc_live", command="npm test", notify_on_complete=True)
    registry._running[live.id] = live
    assert server._notif_handle_event("sid", session, dict(HEARTBEAT, session_id="proc_live"), set(),
                                      registry, lambda e: "t", []) is True
    assert [kw["display_kind"] for _, kw in surface] == ["hidden"], "a running beat still wakes"


def test_a_beat_drained_mid_turn_still_wakes_once_through_the_safety_net(surface, monkeypatch):
    """The post-turn safety net drains the queue and feeds those same events to the poller's own
    handler (``prompt_turn`` → ``_notif_handle_ready``). A drain that recorded the beat as delivered
    would make that second consumer drop it as superseded before any model saw it — the wake a live
    process's output earned would be swallowed. Recording belongs to the consumer that commits the
    turn."""
    from tools.process_registry import ProcessRegistry, ProcessSession

    monkeypatch.setattr(server, "_run_prompt_submit",
                        lambda rid, sid, session, text, **kw: (surface.append((text, kw)), True)[1])
    registry = ProcessRegistry()
    live = ProcessSession(id="proc_hb", command="npm test", notify_on_complete=True)
    registry._running[live.id] = live
    registry.completion_queue.put(dict(HEARTBEAT))
    session = _session()

    drained = registry.drain_notifications(session_key="", owns_event=lambda e: True)
    assert [e["seq"] for e, _ in drained] == [2], "the drain hands over the live beat"

    server._notif_handle_ready("sid", session, [event for event, _ in drained], set(), registry,
                               lambda e: "t", [], owned=True)

    assert [kw["display_kind"] for _, kw in surface] == ["hidden"], "the safety net still wakes once"
    assert registry.heartbeat_is_stale(dict(HEARTBEAT)) is True, "the delivering consumer records it"
    assert registry.heartbeat_is_stale(dict(HEARTBEAT, seq=1)) is True, "an older beat stays out of order"
