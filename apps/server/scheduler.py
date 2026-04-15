"""
JOBVIS Generic Scheduler
========================
Runs recurring async jobs inside the FastAPI asyncio event loop.
No external dependencies — just asyncio.

Design:
  - Sleeps FIRST, then runs (no immediate fire on startup).
  - interval_fn() is called fresh before every sleep so UI changes
    take effect on the next cycle without a server restart.
  - Jitter: ±60 seconds added to every interval to avoid looking
    like a cron bot to rate-limit systems (e.g. Ashby).
  - All tasks are registered in the provided task_tracker (the
    existing _background_tasks set) so FastAPI's shutdown hook
    cancels them cleanly.
"""

import asyncio
import random
import time
from typing import Callable, Awaitable, Optional

# Jitter window in seconds applied to every interval
JITTER_SECONDS = 60


class Scheduler:
    def __init__(self):
        self._tasks: dict[str, asyncio.Task] = {}
        self._next_run_at: dict[str, Optional[float]] = {}    # epoch seconds
        self._sleep_duration: dict[str, Optional[float]] = {} # seconds for this cycle
        self._job_running: dict[str, bool] = {}               # True while job executes
        self._trigger_events: dict[str, asyncio.Event] = {}   # set to wake a sleeping job early

    def register(
        self,
        name: str,
        interval_fn: Callable[[], float],
        job_fn: Callable[[], Awaitable],
        task_tracker: Optional[Callable[[asyncio.Task], asyncio.Task]] = None,
    ) -> None:
        """
        Register a named recurring async job.

        Args:
            name:         Human-readable identifier used in logs.
            interval_fn:  Callable that returns the base interval in seconds.
                          Called fresh before every sleep — UI changes take
                          effect on the next cycle automatically.
            job_fn:       Async function to execute each cycle.
            task_tracker: Optional fn(task) -> task that registers the task
                          with the server's shutdown-cancellation set.
        """
        if name in self._tasks and not self._tasks[name].done():
            print(f"[Scheduler] '{name}' is already registered and running, skipping.")
            return

        # Create (or reset) the trigger event for this job
        self._trigger_events[name] = asyncio.Event()

        task = asyncio.create_task(
            self._run_loop(name, interval_fn, job_fn),
            name=f"scheduler:{name}",
        )
        self._tasks[name] = task
        if task_tracker:
            task_tracker(task)
        print(f"[Scheduler] '{name}' registered.")

    async def _run_loop(
        self,
        name: str,
        interval_fn: Callable[[], float],
        job_fn: Callable[[], Awaitable],
    ) -> None:
        """Internal loop: sleep → run → repeat, forever."""
        while True:
            base = interval_fn()
            if base <= 0:
                # Scheduler disabled — poll every 30s to pick up re-enables
                self._next_run_at[name] = None
                self._sleep_duration[name] = None
                self._job_running[name] = False
                await asyncio.sleep(30)
                continue

            jitter = random.uniform(-JITTER_SECONDS, JITTER_SECONDS)
            sleep_secs = max(60, base + jitter)   # never sleep less than 1 minute
            mins, secs = divmod(int(sleep_secs), 60)

            # Record timing state BEFORE sleeping so UI can show countdown
            self._next_run_at[name] = time.time() + sleep_secs
            self._sleep_duration[name] = sleep_secs
            self._job_running[name] = False

            print(
                f"[Scheduler] '{name}' — sleeping {mins}m{secs:02d}s "
                f"(base={int(base)}s, jitter={jitter:+.0f}s)"
            )

            # Sleep until timer expires OR trigger_now() fires the event
            event = self._trigger_events.get(name)
            if event:
                event.clear()  # clear any stale trigger before sleeping
            try:
                if event:
                    await asyncio.wait_for(event.wait(), timeout=sleep_secs)
                    event.clear()
                    print(f"[Scheduler] '{name}' — woken early by RUN NOW")
                else:
                    await asyncio.sleep(sleep_secs)
            except asyncio.TimeoutError:
                pass  # normal timer expiry
            except asyncio.CancelledError:
                print(f"[Scheduler] '{name}' — cancelled during sleep.")
                return

            # Mark job as actively running
            self._next_run_at[name] = None
            self._job_running[name] = True
            print(f"[Scheduler] '{name}' — triggering scheduled run...")
            try:
                await job_fn()
                print(f"[Scheduler] '{name}' — run complete.")
            except asyncio.CancelledError:
                print(f"[Scheduler] '{name}' — cancelled during run.")
                return
            except Exception as e:
                # Log but keep going — a single failure shouldn't kill the loop
                print(f"[Scheduler] '{name}' — run failed: {type(e).__name__}: {e}")
            finally:
                self._job_running[name] = False

    def trigger_now(self, name: str) -> bool:
        """
        Immediately wake a sleeping job, causing it to run now and then
        reset its timer for a fresh full interval from that point.
        Returns True if the event was found and set, False if job not registered.
        """
        event = self._trigger_events.get(name)
        if event:
            event.set()
            print(f"[Scheduler] '{name}' — trigger_now() called, waking from sleep")
            return True
        print(f"[Scheduler] trigger_now('{name}') — job not registered")
        return False

    def cancel(self, name: str) -> None:
        """Cancel a single registered job by name."""
        task = self._tasks.get(name)
        if task and not task.done():
            task.cancel()

    def cancel_all(self) -> None:
        """Cancel every registered job."""
        for name, task in self._tasks.items():
            if not task.done():
                task.cancel()
                print(f"[Scheduler] '{name}' — cancel requested.")
        self._tasks.clear()

    def status(self) -> dict:
        """Returns a name → status dict for all registered jobs."""
        result = {}
        for name, task in self._tasks.items():
            if task.done():
                state = "done"
            elif self._job_running.get(name):
                state = "running"
            elif self._next_run_at.get(name) is None:
                state = "disabled"
            else:
                state = "sleeping"
            result[name] = {
                "state": state,
                "next_run_at": self._next_run_at.get(name),          # epoch seconds (float) or None
                "sleep_duration_secs": self._sleep_duration.get(name), # total sleep for this cycle
            }
        return result
