// The launcher is versioned separately from the app. It changes rarely, and
// each change must be shipped to clients by hand (ADR-0002), so this is bumped
// manually. Releases that need a newer launcher declare it with
// `minLauncherVersion`.
export const LAUNCHER_VERSION = "1.0.0";
