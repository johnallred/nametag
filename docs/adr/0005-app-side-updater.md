# Update logic lives in the app; the launcher stays minimal

The launcher is the one component that doesn't update itself
([ADR-0002](0002-launcher-and-versioned-folders.md)). Any bug in it is effectively
permanent on every installed client. So we keep it as small as possible:

- take the single-instance lock
- clean up leftover files
- start `versions/<current>/app.js`
- swap the `current` pointer when asked
- roll back when a new version fails

Everything else lives in the versioned app: polling, manifest verification, downloading,
hash checks and staging. The app tells the launcher over IPC when a release is staged
and ready. Because the update logic ships inside each release, a bug in it is fixed by
shipping an update.

## Considered options

- **The launcher does the updating**: a simpler process model, since the app wouldn't need
  to know updates exist. But the most intricate code in the system, which handles the
  network, crypto, partial downloads and the server's quirks, would be frozen into the
  part we can't easily update.

## Consequences

- A release with a broken updater could stop receiving updates. Health checks catch
  releases that fail to start ([ADR-0006](0006-health-check-and-rollback.md)), but not an
  updater that starts fine and silently never updates. The end-to-end test, which
  performs a real update, is the guard against that.
- The trust anchor (the public key) also ships in the app. That makes it replaceable,
  which is the hook for future key rotation.
- Each on-disk file has exactly one writer. The launcher owns `current` and
  `launcher-state.json`. The app owns `versions/` and `app-state.json`.
