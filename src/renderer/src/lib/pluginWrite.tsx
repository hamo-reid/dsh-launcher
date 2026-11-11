/** Answering the questions a plugin write asks before it touches a profile.
 *
 * Three of them exist, and every one means NOTHING has been written yet:
 * `profiles-running` (a live dsh process would keep the old files open),
 * `replaces-dev-link` (the profile is on a working copy that installing would
 * drop), and the machine-level variant of the first (saving `<home>/cordis.patch.yml`
 * recomposes every running profile the moment it lands). They are asked through
 * the same modal, so a person sees one shape of question regardless of which
 * check fired.
 */
import { Button, Modal, Space } from 'antd'
import i18n from 'i18next'
import type {
  IpcResult, PluginWriteConsent, PluginWritePending, RunningProfileRef,
} from '../../../shared/types.ts'

/** What the person chose when asked about running profiles. */
export type RunningAnswer = 'cancel' | 'continue' | 'stop'

/** The live profiles a result stopped for, or `undefined` when it went through. */
function runningRefusalOf<T extends PluginWritePending>(
  result: IpcResult<T>,
): RunningProfileRef[] | undefined {
  if (!result.ok) return undefined
  return result.value.needsConfirm === 'profiles-running' ? (result.value.profiles ?? []) : undefined
}

/** The labels a confirmation names, joined the way the pages write them. */
function who(profiles: readonly RunningProfileRef[]): string {
  return profiles.map(item => `${item.dsh}·${item.profile}`).join('、')
}

/**
 * Ask about writing while profiles run.
 *
 * Three answers, because two would force a bad one: cancelling the whole action
 * is not what "no thanks" usually means, and going on regardless is the wrong
 * default when stopping the process is one click away. Stopping is rendered as
 * the primary action; continuing anyway stays available for the case where the
 * running process does not actually use what is being written.
 * @param title - Localized question.
 * @param body - Localized body, already naming the profiles.
 * @returns the chosen answer; the modal is already closed.
 */
function ask(title: string, body: string): Promise<RunningAnswer> {
  return new Promise(resolve => {
    let modal: { destroy: () => void } | undefined
    const close = (answer: RunningAnswer): void => { modal?.destroy(); resolve(answer) }
    modal = Modal.confirm({
      title,
      content: body,
      closable: true,
      maskClosable: false,
      // The X and Esc are a cancel answer like any other, and they must settle the
      // promise — an unanswered question here would leave the write hanging.
      onCancel: () => close('cancel'),
      footer: (
        <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
          <Button size="small" onClick={() => close('cancel')}>{i18n.t('common.cancel')}</Button>
          <Button size="small" danger onClick={() => close('continue')}>{i18n.t('plugin.running.ok')}</Button>
          <Button size="small" type="primary" onClick={() => close('stop')}>{i18n.t('plugin.running.stopAndContinue')}</Button>
        </Space>
      ),
    })
  })
}

/** Ask about a profile write: the running process will not follow it, and a
 * delete may fail on a file it holds open. */
export function askRunning(profiles: readonly RunningProfileRef[]): Promise<RunningAnswer> {
  return ask(i18n.t('plugin.running.title'), i18n.t('plugin.running.body', { profiles: who(profiles) }))
}

/** Ask about the machine-level patch layer: every running profile reloads as
 * soon as it lands, which is what the person has to be told. */
function askSharedLayer(profiles: readonly RunningProfileRef[]): Promise<RunningAnswer> {
  return ask(i18n.t('profile.shared.title'), i18n.t('profile.shared.body', { profiles: who(profiles) }))
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
 * @param mode - which copy the question wears: a plugin write, or a write to the
 *   machine-level patch layer.
 * @returns the answer that needs no further question, or `null` when the person
 *   cancelled — in which case nothing was written.
 */
async function confirmRetry<T extends PluginWritePending>(
  run: (consent: PluginWriteConsent | undefined) => Promise<IpcResult<T>>,
  mode: 'plugin' | 'shared',
): Promise<IpcResult<T> | null> {
  const first = await run(undefined)
  const profiles = runningRefusalOf(first)
  if (profiles === undefined) return first
  const answer = mode === 'plugin' ? await askRunning(profiles) : await askSharedLayer(profiles)
  if (answer === 'cancel') return null
  if (answer === 'stop') {
    // Stop first, then retry: a stopped profile has nothing to hold open, so the
    // write is the plain one it looks like.
    for (const item of profiles) await window.api.run.stopProfile(item.dshId, item.profile)
  }
  return await run({ acknowledgeRunning: true })
}

/** A write to one profile that may refuse because its dsh is still running. */
export function writeWithRunningConfirm<T extends PluginWritePending>(
  run: (consent: PluginWriteConsent | undefined) => Promise<IpcResult<T>>,
): Promise<IpcResult<T> | null> {
  return confirmRetry(run, 'plugin')
}

/** A write to the machine-level patch layer, which reloads every running profile. */
export function writeWithSharedLayerConfirm<T extends PluginWritePending>(
  run: (consent: PluginWriteConsent | undefined) => Promise<IpcResult<T>>,
): Promise<IpcResult<T> | null> {
  return confirmRetry(run, 'shared')
}
