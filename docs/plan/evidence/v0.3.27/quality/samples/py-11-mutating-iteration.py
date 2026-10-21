# Sample py-11 — boundary (defect)
# Removing expired sessions while iterating the dict raises
# "dictionary changed size during iteration" whenever at least one entry
# expires, taking down the whole sweep.
import time


def sweep_expired(sessions: dict, ttl_seconds: int) -> None:
    now = time.time()
    for session_id, record in sessions.items():
        if now - record["last_seen"] > ttl_seconds:
            del sessions[session_id]
