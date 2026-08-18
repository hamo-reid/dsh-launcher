import { useState } from 'react'
import { Button, Input, Modal, Segmented, message, theme } from 'antd'
import { FolderOpenOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useAppLang } from '../i18n'
import { apiErrorText } from '../lib/ipc.ts'
import { MODAL } from '../theme.ts'

interface Props {
  /** The effective default directories the wizard is seeded with. */
  defaults: { pluginDir: string; dshVersionDir: string }
  /** Called once the wizard has persisted the user's choices. */
  onComplete: () => void
}

/** A single directory field (label + hint + input + Browse… button). */
function DirField(props: {
  title: string
  desc: string
  value: string
  onChange: (v: string) => void
  onBrowse: () => void
  browseLabel: string
}) {
  const { token } = theme.useToken()
  return (
    <div style={{ marginBottom: token.paddingLG }}>
      <div style={{ fontWeight: 600 }}>{props.title}</div>
      <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, margin: '4px 0 8px' }}>
        {props.desc}
      </div>
      <div style={{ display: 'flex', gap: token.paddingSM }}>
        <Input
          value={props.value}
          onChange={e => props.onChange(e.target.value)}
          style={{ flex: 1, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}
        />
        <Button icon={<FolderOpenOutlined />} onClick={props.onBrowse} style={{ flexShrink: 0 }}>
          {props.browseLabel}
        </Button>
      </div>
    </div>
  )
}

/** First-run onboarding wizard — sets the UI language plus the two data
 * directories. Forced (no close/cancel) so a fresh install is configured at
 * least once; seeded with working defaults the user can override via Browse….
 * Completed choices are persisted and never shown again. */
export default function OnboardingModal({ defaults, onComplete }: Props) {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { language, setLanguage } = useAppLang()
  const [pluginDir, setPluginDir] = useState(defaults.pluginDir)
  const [versionDir, setVersionDir] = useState(defaults.dshVersionDir)
  const [busy, setBusy] = useState(false)

  const browse = async (kind: 'plugin' | 'version'): Promise<void> => {
    const res = await window.api.settings.pickDir({
      title: kind === 'plugin' ? t('onboarding.pluginDir') : t('onboarding.versionDir'),
      defaultPath: kind === 'plugin' ? pluginDir : versionDir,
    })
    if (!res.ok) { void message.error(apiErrorText(res)); return }
    if (res.value !== '') {
      if (kind === 'plugin') setPluginDir(res.value)
      else setVersionDir(res.value)
    }
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    const res = await window.api.settings.completeOnboarding({
      uiLanguage: language,
      pluginDir,
      dshVersionDir: versionDir,
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
      maskClosable={false}
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

        <DirField
          title={t('onboarding.pluginDir')}
          desc={t('onboarding.pluginDir.desc')}
          value={pluginDir}
          onChange={setPluginDir}
          onBrowse={() => void browse('plugin')}
          browseLabel={t('onboarding.browse')}
        />
        <DirField
          title={t('onboarding.versionDir')}
          desc={t('onboarding.versionDir.desc')}
          value={versionDir}
          onChange={setVersionDir}
          onBrowse={() => void browse('version')}
          browseLabel={t('onboarding.browse')}
        />
      </div>
    </Modal>
  )
}