# A stable launcher runs one of several versioned app folders

Replacing a running executable is the classic pain point of self-updaters. Windows locks
a running `.exe`, and a half-written binary bricks the install. We avoid the problem
entirely by never replacing a running file.

A small launcher executable stays fixed. Each app release lives in its own folder,
`versions/<version>/app.cjs`, and a one-line `current` file names the active version. To
update, we write a new folder alongside the old one, atomically rename a new `current`
into place, and restart the app process. The previous version stays on disk as the
rollback target.

The launcher is the same SEA executable re-run in "app mode": `process.execPath` with a
flag, which then `require()`s `versions/<current>/app.cjs` from disk. A release is
therefore a single platform-independent JS bundle, not a per-OS binary. It is named
`.cjs` because Node decides whether a `.js` file is CommonJS or an ES module from the
nearest `package.json` above it. The extension makes the bundle load the same way
wherever the data directory happens to be.

## Considered options

- **Freeze the whole app into one executable that replaces itself**: this needs the
  rename-the-running-exe trick or a helper process on Windows. Every update is a full
  binary of 40–100 MB, and rollback means keeping a second copy of that binary anyway.
- **Ship a portable Node runtime inside every version folder**: this would make the
  runtime itself updatable, but every update becomes 40–100 MB instead of a JS bundle a
  few tens of KB in size.
- **Assume Node is installed and ship source**: simplest, but it contradicts "deployed to
  clients" machines.

## Consequences

- The only on-disk "commit" of an update is the rename of `current`, which makes the
  crash analysis in [DESIGN.md](../../DESIGN.md#atomicity-what-happens-if-we-crash-at-each-step) short.
- The launcher doesn't update itself. Each release declares `minLauncherVersion`, and the
  app won't stage a release its launcher can't run. Self-updating the launcher is
  documented future work.
- This is the same shape used by Squirrel (and so VS Code and Slack on Windows) and by
  Chrome's versioned install directories.
