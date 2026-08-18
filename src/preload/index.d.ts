/**
 * Renderer-side view of the preload-exposed `window.api`.
 *
 * The full contract is defined once in `src/shared/api.ts`; this file only
 * mounts it onto the global `Window`. There is no duplicate hand-written API
 * surface to keep in sync.
 */
import type { WindowApi } from '../shared/api.ts'

declare global {
  interface Window {
    api: WindowApi
  }
}

export {}