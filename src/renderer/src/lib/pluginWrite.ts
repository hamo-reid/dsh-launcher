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

/** Ask about proceeding while those profiles run. @returns whether to go on. */
export function askRunning(profiles: readonly RunningProfileRef[]): Promise<boolean> {
  const who = profiles.map(item => `${item.dsh}·${item.profile}`).join('、')
  return new Promise(resolve => {
    Modal.confirm({
      title: i18n.t('plugin.running.title'),
      content: i18n.t('plugin.running.body', { profiles: who }),
      okText: i18n.t('plugin.running.ok'),
      cancelText: i18n.t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: () => { resolve(true) },
      onCancel: () => { resolve(false) },
    })
  })
}

/** Ask about replacing the profile's dev link. @returns whether to go on. */
export function askReplaceDevLink(text: string): Promise<boolean> {
  return new Promise(resolve => {
    Modal.confirm({
      title: i18n.t('plugin.install.replaceDevTitle'),
      content: text,
      okText: i18n.t('plugin.install.replaceDevOk'),
      cancelText: i18n.t('common.cancel'),
      onOk: () => { resolve(true) },
      onCancel: () => { resolve(false) },
    })
  })
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
  const first = await run(undefined)
  const profiles = runningRefusalOf(first)
  if (profiles === undefined) return first
  if (!await askRunning(profiles)) return null
  return run({ acknowledgeRunning: true })
}
