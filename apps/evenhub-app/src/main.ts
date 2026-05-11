import { App } from './app.js'
import { loadAppConfig } from './config.js'

/**
 * Entry point for the Even Hub WebView (`index.html` loads this as
 * `<script type="module">`).
 *
 * Kept intentionally tiny: all wiring lives in {@link App}. We export `boot`
 * so tests can drive the entry without `vi.mock`-ing `import.meta.env`.
 */
export async function boot(): Promise<App> {
  const cfg = loadAppConfig()
  const app = new App(cfg)
  await app.boot()
  return app
}

// Auto-run only inside a browser context. `vitest` may import this module for
// coverage purposes; we detect that via the presence of `window` and the
// absence of `globalThis.__VITEST__`.
declare const window: unknown
if (typeof window !== 'undefined' && (globalThis as { __VITEST__?: unknown }).__VITEST__ !== true) {
  void boot().catch((err: unknown) => {
    // Surfacing boot errors via console is acceptable here — these are
    // operational signals (timeout, missing bridge), never user content.
    // Stringify message + stack so the Vite client-log proxy forwards the
    // full diagnostic instead of collapsing the Error object to a single
    // location line.
    const message = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error && err.stack !== undefined ? err.stack : ''
    console.error('[evenhub-app] boot failed:', message, stack)
  })
}
