import { useEffect, useState } from 'react'
import { Segmented, Select, Space, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import Panel from '../components/Panel.tsx'
import SectionHeading from '../components/SectionHeading.tsx'
import ConfigRow from '../components/ConfigRow.tsx'
import { useThemeMode } from '../ThemeProvider.tsx'
import { useAppLang } from '../i18n'
import { apiErrorText } from '../lib/ipc.ts'
import type { ThemeMode } from '../theme.ts'

/** 设置页：外观(主题 + 语言) + 目录配置(DSH 版本库 / 插件保存位置)。 */
export default function SettingsSection() {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { mode, setMode } = useThemeMode()
  const { language, setLanguage } = useAppLang()
  const [versionDir, setVersionDir] = useState('')
  const [pluginDir, setPluginDir] = useState('')

  const load = async (): Promise<void> => {
    const v = await window.api.dsh.getVersionDir()
    if (v.ok) setVersionDir(v.value.dir)
    const p = await window.api.plugins.getDir()
    if (p.ok) setPluginDir(p.value.dir)
  }

  useEffect(() => { void load() }, [])

  const saveVersionDir = async (value: string): Promise<string> => {
    const res = await window.api.dsh.setVersionDir(value)
    if (res.ok) { setVersionDir(value); return '' }
    return apiErrorText(res)
  }

  const savePluginDir = async (value: string): Promise<string> => {
    const res = await window.api.plugins.setDir(value)
    if (res.ok) { setPluginDir(value); return '' }
    return apiErrorText(res)
  }

  return (
    <div style={{ padding: token.paddingLG }}>
      <SectionHeading title={t('app.tab.settings')} description="外观与目录配置。" />
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Panel title={t('settings.section.appearance')}>
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <div style={{ maxWidth: 560 }}>
              <div style={{ fontWeight: 600 }}>{t('settings.language')}</div>
              <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, marginTop: 4, marginBottom: token.paddingSM }}>
                {t('settings.language.desc')}
              </div>
              <Select
                value={language}
                onChange={value => void setLanguage(value)}
                style={{ width: 300 }}
                options={[
                  { value: 'zh', label: t('settings.language.zh') },
                  { value: 'en', label: t('settings.language.en') },
                ]}
              />
            </div>
            <div style={{ borderTop: `1px solid ${token.colorSplit}`, paddingTop: token.paddingSM }}>
              <Segmented
                value={mode}
                onChange={value => setMode(value as ThemeMode)}
                options={[
                  { value: 'light', label: t('settings.theme.light') },
                  { value: 'dark', label: t('settings.theme.dark') },
                  { value: 'system', label: t('settings.theme.system') },
                ]}
              />
              <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, marginTop: token.paddingSM }}>
                {t('settings.theme.systemHint')}
              </div>
            </div>
          </Space>
        </Panel>

        <Panel title={t('settings.section.directories')}>
          <ConfigRow
            title={t('settings.dshVersionDir')}
            description={t('settings.dshVersionDir.desc')}
            value={versionDir}
            onSave={saveVersionDir}
          />
          <div style={{ margin: '10px 0', borderTop: `1px solid ${token.colorSplit}` }} />
          <ConfigRow
            title={t('settings.pluginDir')}
            description={t('settings.pluginDir.desc')}
            value={pluginDir}
            onSave={savePluginDir}
          />
        </Panel>
      </Space>
    </div>
  )
}