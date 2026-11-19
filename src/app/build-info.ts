// Values baked into the bundle at build time by esbuild's `define` (see
// src/build/app.ts). When the sources are run directly in development, the
// identifiers are undefined and the fallbacks apply.

declare const __NAMETAG_VERSION__: string | undefined;

export const APP_VERSION: string = typeof __NAMETAG_VERSION__ === "string" ? __NAMETAG_VERSION__ : "0.0.0";
