// Release versions are plain MAJOR.MINOR.PATCH. Pre-release and build-metadata
// suffixes are rejected rather than half-supported: their ordering rules are
// subtle, and the single "stable" channel never needs them.

export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

// No leading zeros, as in the semver spec, so every version has exactly one
// spelling and "1.02.0" can't sneak past a string comparison as a distinct version.
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseVersion(text: string): Version {
  const match = VERSION_PATTERN.exec(text);
  if (!match) {
    throw new Error(`invalid version "${text}": expected MAJOR.MINOR.PATCH`);
  }
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number];
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    throw new Error(`invalid version "${text}": component too large`);
  }
  return { major, minor, patch };
}

export function isValidVersion(text: string): boolean {
  try {
    parseVersion(text);
    return true;
  } catch {
    return false;
  }
}

/** Returns a negative number if a < b, zero if equal, positive if a > b. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  return x.major - y.major || x.minor - y.minor || x.patch - y.patch;
}
