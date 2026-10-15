"""Background-process heartbeats for ``ProcessRegistry``: the periodic "still running + new output"
wake, its single timer thread, and the staleness rules that keep a queued beat from waking an owner
after its process exited or behind a newer beat that was already delivered."""

import logging
import threading
import time
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from tools.process_registry import ProcessSession

logger = logging.getLogger("tools.process_registry")


class ProcessHeartbeatMixin:
    """The subclass supplies ``_lock``/``_running``/``_finished``, ``completion_queue``, the
    ``_heartbeat_thread`` slot and ``_watch_event_base``. See ProcessRegistry."""

    # ── heartbeat ───────────────────────────────────────────────────────────
    def arm_heartbeat(self, session: "ProcessSession", seconds: int) -> int:
        """Enable periodic heartbeat events for ``session``; returns the effective interval."""
        from tools.process_registry import HEARTBEAT_MIN_SECONDS

        seconds = max(int(seconds), HEARTBEAT_MIN_SECONDS)
        session.heartbeat_seconds = seconds
        session._heartbeat_last = time.time()
        # The output baseline stays at spawn (field default 0), never here: the spawn call
        # arms the heartbeat only after its bookkeeping, and a fast-starting process has
        # already written its first lines by then. Those lines belong to the first heartbeat.
        self._ensure_heartbeat_thread()
        return seconds

    def _ensure_heartbeat_thread(self) -> None:
        with self._lock:
            if self._heartbeat_thread is not None and self._heartbeat_thread.is_alive():
                return
            self._heartbeat_thread = threading.Thread(
                target=self._heartbeat_loop, name="process-heartbeat", daemon=True)
            self._heartbeat_thread.start()

    def _heartbeat_loop(self) -> None:
        """One daemon thread for every heartbeat session: reader threads block on the pipe and
        cannot keep time, and a per-process timer would leak one thread per job."""
        from tools.process_registry import HEARTBEAT_TICK_SECONDS

        while True:
            time.sleep(HEARTBEAT_TICK_SECONDS)
            now = time.time()
            with self._lock:
                due = [s for s in self._running.values()
                       if s.heartbeat_seconds > 0 and not s.exited
                       and now - s._heartbeat_last >= s.heartbeat_seconds]
            for session in due:
                self._emit_heartbeat(session, now)

    def _emit_heartbeat(self, session: "ProcessSession", now: float) -> None:
        """Queue a heartbeat carrying the output since the last one. A tick with nothing new is
        skipped outright: every queued event costs the owner a full model turn, and "still running,
        no output" is already visible on the process surfaces (status stack, /agents dock)."""
        from tools.process_registry import HEARTBEAT_OUTPUT_CHARS, _redact_process_result

        session._heartbeat_last = now
        with session._lock:
            delta = session.total_output_chars - session._heartbeat_total_at_last
            output = session.output_buffer[-delta:] if delta > 0 else ""
            session._heartbeat_total_at_last = session.total_output_chars
        if not output:
            return
        if len(output) > HEARTBEAT_OUTPUT_CHARS:
            cut = len(output) - HEARTBEAT_OUTPUT_CHARS
            output = f"...({cut} earlier characters omitted)\n" + output[-HEARTBEAT_OUTPUT_CHARS:]
        session._heartbeat_seq += 1
        notification = {
            **self._watch_event_base(session),
            "type": "heartbeat",
            "seq": session._heartbeat_seq,
            "interval": session.heartbeat_seconds,
            "elapsed": int(now - session.started_at) if session.started_at else 0,
            "output": output,
            "started_at": session.started_at,
        }
        _redact_process_result(notification)
        self.completion_queue.put(notification)

    def _heartbeat_session(self, evt: dict) -> Optional["ProcessSession"]:
        """The session a ``heartbeat`` event belongs to, or None when this process doesn't own it."""
        session_id = str(evt.get("session_id") or "")
        if not session_id:
            return None
        with self._lock:
            return self._running.get(session_id) or self._finished.get(session_id)

    def heartbeat_is_stale(self, evt: dict) -> bool:
        """True when a queued ``heartbeat`` may not wake its owner any more.

        A beat says "still running — here is the new output", so it stops being true the moment
        its process exits: the completion notice carries the final state and ``process log`` holds
        the output, and a wake after the fact reads as a live job that must be answered. A beat at
        or below the highest sequence already delivered was re-queued behind a newer one (the
        delivery loop puts an undeliverable event back at the tail), so it would arrive out of
        order with older output than the owner already has. Both are dropped; anything else —
        a running process, another type, an unknown owner, an unreadable sequence — is delivered,
        because notification hygiene must never silently swallow a wake.
        """
        if evt.get("type") != "heartbeat":
            return False
        session = self._heartbeat_session(evt)
        if session is None:
            return False
        if session.exited:
            return True
        seq = evt.get("seq")
        if not isinstance(seq, int):
            return False
        return seq <= session._heartbeat_delivered_seq

    def note_heartbeat_delivered(self, evt: dict) -> None:
        """Record the highest heartbeat sequence handed to a consumer (see heartbeat_is_stale)."""
        seq = evt.get("seq")
        if evt.get("type") != "heartbeat" or not isinstance(seq, int):
            return
        session = self._heartbeat_session(evt)
        if session is not None:
            session._heartbeat_delivered_seq = max(seq, session._heartbeat_delivered_seq)
