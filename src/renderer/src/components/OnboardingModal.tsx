import { useEffect, useState } from 'react'
import { Modal, Segmented, message, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import { useAppLang } from '../i18n'
import { apiErrorText } from '../lib/ipc.ts'
import { MODAL } from '../theme.ts'
import DirField from './DirField.tsx'
import DerivedDirs from './DerivedDirs.tsx'
import type { NodeEnvironment, OnboardingState } from '../../../shared/types.ts'

interface Props {
  /** The effective defaults the wizard is seeded with, plus what they derive. */
  defaults: OnboardingState['defaults']
  /** Called once the wizard has persisted the user's choices. */
  onComplete: () => void
}

/** First-run onboarding wizard — sets the UI language, the node runtime and the
 * launcher data root. Forced (no close/cancel) so a fresh install is configured
 * at least once; seeded with working defaults the user can override via Browse….
 * Completed choices are persisted and never shown again.
 *
 * A fresh install has no data to relocate, so the wizard only writes the root —
 * migrating an existing library is the settings page's job. */
export default function OnboardingModal({ defaults, onComplete }: Props) {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { language, setLanguage } = useAppLang()
  const [dataRoot, setDataRoot] = useState(defaults.dataRoot)
  const [nodePref, setNodePref] = useState<'system' | 'bundled'>('system')
  const [nodeEnv, setNodeEnv] = useState<NodeEnvironment>()
  const [busy, setBusy] = useState(false)

  // Detect the node environment; seed the choice with the effective suggestion
  // (system, when a usable one exists, else bundled).
  useEffect(() => {
    let alive = true
    void window.api.settings.getNodeEnvironment().then(r => {
      if (!alive) return
      if (!r.ok) return
      setNodeEnv(r.value)
      setNodePref(r.value.prefer)
    })
    return () => { alive = false }
  }, [])

  const browse = async (): Promise<void> => {
    const res = await window.api.settings.pickDir({
      title: t('onboarding.dataRoot'),
      defaultPath: dataRoot,
    })
    if (!res.ok) { void message.error(apiErrorText(res)); return }
    if (res.value !== '') setDataRoot(res.value)
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    const res = await window.api.settings.completeOnboarding({
      uiLanguage: language,
      dataRoot,
      nodePreference: nodePref,
    })
    setBusy(false)
    if (!res.ok) { void message.error(apiErrorText(res)); return }
    void message.success(t('onboarding.done'))
    onComplete()
  }

  return (
    <Modal
      open
      title={t('onboarding.title')}
      width={MODAL.wide}
      closable={false}
      mask={{ closable: false }}
      keyboard={false}
      okText={t('onboarding.submit')}
      onOk={() => void save()}
      okButtonProps={{ loading: busy }}
      cancelButtonProps={{ style: { display: 'none' } }}
    >
      <div style={{ paddingTop: token.paddingSM }}>
        <p style={{ color: token.colorTextSecondary, margin: '0 0 20px' }}>
          {t('onboarding.subtitle')}
        </p>

        <div style={{ marginBottom: token.paddingLG }}>
          <div style={{ fontWeight: 600 }}>{t('onboarding.language')}</div>
          <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, margin: '4px 0 8px' }}>
            {t('onboarding.language.desc')}
          </div>
          <Segmented
            value={language}
            onChange={value => void setLanguage(value as string)}
            options={[
              { value: 'zh', label: t('settings.language.zh') },
              { value: 'en', label: t('settings.language.en') },
            ]}
          />
        </div>

        <div style={{ marginBottom: token.paddingLG }}>
          <div style={{ fontWeight: 600 }}>{t('onboarding.runtime')}</div>
          <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, margin: '4px 0 8px' }}>
            {t('onboarding.runtime.desc')}
            {nodeEnv !== undefined && (
              <span style={{ display: 'block', marginTop: 4, fontFamily: 'ui-monospace, Menlo, Consolas, monospace' }}>
                {t('onboarding.runtime.system').replace('{{v}}', nodeEnv.system.installed ? nodeEnv.system.version : t('onboarding.runtime.none'))} · {t('onboarding.runtime.bundled').replace('{{v}}', nodeEnv.bundled)}
              </span>
            )}
          </div>
          <Segmented
            value={nodePref}
            onChange={value => setNodePref(value as 'system' | 'bundled')}
            options={[
              { value: 'system', label: t('onboarding.runtime.optSystem') },
              { value: 'bundled', label: t('onboarding.runtime.optBundled') },
            ]}
          />
        </div>

        <DirField
          title={t('onboarding.dataRoot')}
          desc={t('onboarding.dataRoot.desc')}
          value={dataRoot}
          onChange={setDataRoot}
          onBrowse={() => void browse()}
          browseLabel={t('onboarding.browse')}
        />
        <DerivedDirs derived={defaults.derived} />
      </div>
    </Modal>
  )
}
