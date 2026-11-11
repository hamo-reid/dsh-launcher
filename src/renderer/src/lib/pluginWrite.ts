/** Answering the questions a plugin write asks before it touches a profile.
 *
 * Two of them exist today, and both mean NOTHING has been written yet:
 * `profiles-running` (a live dsh process would keep the old files open), and
 * `replaces-dev-link` (the profile is on a working copy that installing would
 * drop). They are asked through the same modal so a person sees one shape of
 * question regardless of which check fired first.
 */
import { Modal } from 'antd'
import i18n from 'i18next'
import type {
  IpcResult, PluginWriteConsent, PluginWritePending, RunningProfileRef,
} from '../../../shared/types.ts'

/** The live profiles a result stopped for, or `undefined` when it went through. */
export function runningRefusalOf<T extends PluginWritePending>(
  result: IpcResult<T>,
): RunningProfileRef[] | undefined {
  if (!result.ok) return undefined
  return result.value.needsConfirm === 'profiles-running' ? (result.value.profiles ?? []) : undefined
}

/** The labels a confirmation names, joined the way the pages write them. */
function who(profiles: readonly RunningProfileRef[]): string {
  return profiles.map(item => `${item.dsh}·${item.profile}`).join('、')
}

/** One confirmation modal, resolved to the person's answer. */
function confirm(title: string, content: string, okText: string): Promise<boolean> {
  return new Promise(resolve => {
    Modal.confirm({
      title,
      content,
      okText,
      cancelText: i18n.t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: () => { resolve(true) },
      onCancel: () => { resolve(false) },
    })
  })
}

/** Ask about writing to a profile that is still running: the process will not
 * follow the write, and a delete may fail on a held-open file. */
export function askRunning(profiles: readonly RunningProfileRef[]): Promise<boolean> {
  return confirm(
    i18n.t('plugin.running.title'),
    i18n.t('plugin.running.body', { profiles: who(profiles) }),
    i18n.t('plugin.running.ok'),
  )
}

/** Ask about writing the machine-level patch layer: every running profile
 * reloads as soon as it lands, which is what the person has to be told. */
export function askSharedLayer(profiles: readonly RunningProfileRef[]): Promise<boolean> {
  return confirm(
    i18n.t('profile.shared.title'),
    i18n.t('profile.shared.body', { profiles: who(profiles) }),
    i18n.t('profile.shared.ok'),
  )
}

/** Ask about replacing the profile's dev link. @returns whether to go on. */
export function askReplaceDevLink(text: string): Promise<boolean> {
  return confirm(i18n.t('plugin.install.replaceDevTitle'), text, i18n.t('plugin.install.replaceDevOk'))
}

/**
 * Run a plugin write that may refuse over a running profile.
 * @param run - one attempt, given the consent the previous attempt earned.
 * @returns the answer that needs no further question, or `null` when the person
 *   declined — in which case nothing was written.
 */
export async function writeWithRunningConfirm<T extends PluginWritePending>(
  run: (consent: PluginWriteConsent | undefined) => Promise<IpcResult<T>>,
): Promise<IpcResult<T> | null> {
  return await confirmRetry(run, askRunning)
}

/**
 * Run a write to the MACHINE-LEVEL patch layer, asking first when profiles are
 * running: that layer recomposes every one of them the moment it is saved.
 * @param run - one attempt, given the consent the previous attempt earned.
 * @returns the answer, or `null` when the person declined and nothing was written.
 */
export async function writeWithSharedLayerConfirm<T extends PluginWritePending>(
  run: (consent: PluginWriteConsent | undefined) => Promise<IpcResult<T>>,
): Promise<IpcResult<T> | null> {
  return await confirmRetry(run, askSharedLayer)
}

/** The shared shape of both: ask once, retry with the consent, otherwise stop. */
async function confirmRetry<T extends PluginWritePending>(
  run: (consent: PluginWriteConsent | undefined) => Promise<IpcResult<T>>,
  ask: (profiles: readonly RunningProfileRef[]) => Promise<boolean>,
): Promise<IpcResult<T> | null> {
  const first = await run(undefined)
  const profiles = runningRefusalOf(first)
  if (profiles === undefined) return first
  if (!await ask(profiles)) return null
  return await run({ acknowledgeRunning: true })
}
