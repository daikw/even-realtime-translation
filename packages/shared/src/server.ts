// Server-only utilities. Kept out of the browser barrel (`./index.ts`) so the
// `node:crypto` dependency in `safetyIdentifier` does not leak into the
// frontend bundle and trigger Vite's "module externalized" warning.
export { computeSafetyIdentifier } from './formatting/safetyIdentifier.js'
