/**
 * Resolve an IPC-supplied dsh id to its context.
 *
 * The id crosses the IPC boundary from the renderer, so it is narrowed here
 * instead of trusted: an absent, blank, non-string or unregistered id resolves
 * to `null`, and the caller turns that into `dsh.notFound`. There is no global
 * active dsh — every operation targets an explicit one — which makes this the
 * single entry point for that lookup.
 *
 * This lives in `ipc/` rather than `core/` on purpose: it is the untrusted
 * boundary projection of two `core` primitives (`dshEntryById` +
 * `contextForEntry`), and `core` should never accept an `unknown` dsh id.
 */
import { contextForEntry, dshEntryById, type DshContext } from '../core/profile/appState.ts'

export function ctxOf(dshId: unknown): DshContext | null {
  if (typeof dshId !== 'string') return null
  const entry = dshEntryById(dshId)
  return entry === undefined ? null : contextForEntry(entry)
}
