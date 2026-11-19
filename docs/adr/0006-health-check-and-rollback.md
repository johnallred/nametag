# New versions run on probation and are rolled back automatically if they fail

A signed release can still be broken. It might crash on start, fail on one OS, or depend
on something missing from a client machine. "Seamless" has to cover that case too: a bad
release must not leave clients with a dead program.

After a swap, the new version is on probation. It must send `{ type: "healthy" }` over
IPC within 10 seconds of starting, and must not exit unexpectedly within 30 seconds. If it
fails either check, the launcher:

1. renames `current` back to the previous version
2. records the failed version as bad in `launcher-state.json`
3. restarts the previous version

The launcher passes the bad-versions list to the app when it starts, so the updater never
stages that version again. A fixed release ships under a new version number.

## Considered options

- **No health check, relying on testing before release**: one bad release would take down
  the whole fleet, with no way to push a fix to programs that no longer run.
- **Health checks run by the server**: needs telemetry infrastructure, and still can't
  repair a client that is already broken.
- **Retry the new version a few times before rolling back**: masks real failures and
  lengthens downtime. A version that can't start once on a given machine is very unlikely
  to start on the second try.

## Consequences

- Rollback only works because the previous version folder is still on disk. Cleanup
  always keeps `current` and `previous`.
- If the *previous* version also fails, there is nothing further to fall back to. The
  launcher keeps restarting it with backoff and logs the failure, rather than exiting
  silently.
- On the very first install there's no previous version. A failure there is reported as
  an install failure.
- The timeouts (10 s and 30 s) are defaults, chosen to be well above the app's normal
  start time.
