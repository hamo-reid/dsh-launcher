/**
 * Which DSH the Profile and Run pages are pointed at, remembered per page.
 *
 * This is VIEW state, not configuration: it says nothing about how a profile
 * behaves, only which install the user was looking at. It therefore lives in
 * `localStorage` beside the theme and the plugin filters rather than in the
 * settings database — no IPC, and it survives an app restart for free.
 *
 * The two pages keep SEPARATE keys on purpose: picking a dsh to browse and edit
 * profiles in is not the same act as picking one to launch from.
 *
 * The stored value is a `DshEntry.id` (an absolute execPath). One that has since
 * been removed simply fails the caller's lookup and falls back to the first
 * registered dsh, so a stale key is harmless and needs no cleanup.
 */

/** One key per page — the pages remember independently. */
export const PROFILE_DSH_KEY = 'profile-manager.profileDshId'
export const RUN_DSH_KEY = 'profile-manager.runDshId'

/** Read a remembered dsh id (`''` when none is stored). */
export function readDshSelection(
  key: string,
  storage: Pick<Storage, 'getItem'> = globalThis.localStorage,
): string {
  try {
    return storage.getItem(key) ?? ''
  } catch {
    // Storage can throw (private mode, blocked site data). A lost preference is
    // never worth breaking a page over.
    return ''
  }
}

/** Remember a dsh id. */
export function saveDshSelection(
  key: string,
  id: string,
  storage: Pick<Storage, 'setItem'> = globalThis.localStorage,
): void {
  try {
    storage.setItem(key, id)
  } catch {
    // see readDshSelection
  }
}
