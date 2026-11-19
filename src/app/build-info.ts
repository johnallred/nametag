// Values baked into the bundle at build time by esbuild's `define` (see
// src/build/app.ts). When the sources are run directly in development, the
// identifiers are undefined and the fallbacks apply.

declare const __NAMETAG_VERSION__: string | undefined;
declare const __NAMETAG_PUBLIC_KEY__: string | undefined;
declare const __NAMETAG_MANIFEST_URL__: string | undefined;

export const APP_VERSION: string = typeof __NAMETAG_VERSION__ === "string" ? __NAMETAG_VERSION__ : "0.0.0";

/** Base64 SPKI Ed25519 key that releases must be signed with. Undefined in dev builds. */
export const PUBLIC_KEY: string | undefined = typeof __NAMETAG_PUBLIC_KEY__ === "string" ? __NAMETAG_PUBLIC_KEY__ : undefined;

/** Default manifest location; config can override it (src/app/config.ts). */
export const MANIFEST_URL: string | undefined = typeof __NAMETAG_MANIFEST_URL__ === "string" ? __NAMETAG_MANIFEST_URL__ : undefined;
