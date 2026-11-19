// Messages between the launcher and the app over Node's IPC channel, plus the
// environment variables the launcher sets when it starts the app.
//
// The protocol is deliberately tiny: every message the launcher understands is
// something an old launcher must keep understanding forever, because the
// launcher doesn't update itself (ADR-0002, ADR-0005).

/** App → launcher. */
export type AppMessage =
  /** Startup finished; ends the health-check wait (ADR-0006). */
  | { readonly type: "healthy" }
  /** A verified release is in versions/<version>/ and ready to switch to. */
  | { readonly type: "staged"; readonly version: string };

/** Launcher → app. */
export type LauncherMessage =
  /** Finish current work, save state and exit 0. */
  { readonly type: "shutdown" };

/** Set by the launcher on the app process. */
export const ENV_LAUNCHER_VERSION = "NAMETAG_LAUNCHER_VERSION";
/** JSON array of versions this client has rolled back from. */
export const ENV_BAD_VERSIONS = "NAMETAG_BAD_VERSIONS";
