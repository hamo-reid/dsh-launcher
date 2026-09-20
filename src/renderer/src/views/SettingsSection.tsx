import { useEffect, useState } from 'react'
import { Alert, Button, Descriptions, Input, Modal, Radio, Segmented, Select, Space, Switch, Tag, message, theme } from 'antd'
import { DownloadOutlined, FolderOpenOutlined, UploadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import Panel from '../components/Panel.tsx'
import SectionHeading from '../components/SectionHeading.tsx'
import ConfigRow from '../components/ConfigRow.tsx'
import { useThemeMode } from '../ThemeProvider.tsx'
import { useAppLang } from '../i18n'
import { apiErrorText } from '../lib/ipc.ts'
import type { ThemeMode } from '../theme.ts'
import type { GithubAuthState, GithubRateLimit, NodeEnvironment } from '../../../shared/types.ts'

/** 设置页：外观(主题 + 语言) + 目录配置(DSH 版本库 / 插件保存位置)。 */
export default function SettingsSection() {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { mode, setMode } = useThemeMode()
  const { language, setLanguage } = useAppLang()
  const [versionDir, setVersionDir] = useState('')
  const [pluginDir, setPluginDir] = useState('')
  const [closeToTray, setCloseToTray] = useState(true)
  const [askOnClose, setAskOnClose] = useState(true)
  const [nodeEnv, setNodeEnv] = useState<NodeEnvironment>()
  const [githubAuth, setGithubAuth] = useState<GithubAuthState>()
  const [githubInput, setGithubInput] = useState('')
  const [githubBusy, setGithubBusy] = useState(false)
  const [githubLimit, setGithubLimit] = useState<GithubRateLimit>()

  const load = async (): Promise<void> => {
    const v = await window.api.dsh.getVersionDir()
    if (v.ok) setVersionDir(v.value.dir)
    const p = await window.api.plugins.getDir()
    if (p.ok) setPluginDir(p.value.dir)
    const c = await window.api.settings.getCloseToTray()
    if (c.ok) setCloseToTray(c.value)
    const a = await window.api.settings.getAskOnClose()
    if (a.ok) setAskOnClose(a.value)
    const n = await window.api.settings.getNodeEnvironment()
    if (n.ok) setNodeEnv(n.value)
    const g = await window.api.settings.getGithubAuth()
    if (g.ok) setGithubAuth(g.value)
  }

  useEffect(() => { void load() }, [])

  const saveCloseToTray = async (enabled: boolean): Promise<void> => {
    const res = await window.api.settings.setCloseToTray(enabled)
    if (res.ok) setCloseToTray(enabled)
    else void message.error(apiErrorText(res))
  }

  const saveAskOnClose = async (enabled: boolean): Promise<void> => {
    const res = await window.api.settings.setAskOnClose(enabled)
    if (res.ok) setAskOnClose(enabled)
    else void message.error(apiErrorText(res))
  }

  const saveNodePref = async (useSystem: boolean): Promise<void> => {
    const res = await window.api.settings.setNodePreference(useSystem ? 'system' : 'bundled')
    if (!res.ok) { void message.error(apiErrorText(res)); return }
    const n = await window.api.settings.getNodeEnvironment()
    if (n.ok) setNodeEnv(n.value)
  }

  const saveGithubToken = async (): Promise<void> => {
    setGithubBusy(true)
    const r = await window.api.settings.setGithubToken(githubInput.trim())
    setGithubBusy(false)
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    setGithubAuth(r.value)
    setGithubInput('')
    setGithubLimit(undefined)
    void message.success(t('settings.github.saved'))
  }

  const clearGithubToken = async (): Promise<void> => {
    setGithubBusy(true)
    const r = await window.api.settings.setGithubToken('')
    setGithubBusy(false)
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    setGithubAuth(r.value)
    setGithubLimit(undefined)
    void message.success(t('settings.github.cleared'))
  }

  const testGithubToken = async (): Promise<void> => {
    setGithubBusy(true)
    const r = await window.api.settings.testGithubToken()
    setGithubBusy(false)
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    setGithubLimit(r.value)
  }

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

  const exportSettings = async (): Promise<void> => {
    const r = await window.api.settings.exportSettings()
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    if (r.value === '') return // cancelled
    void message.success(t('settings.backup.exported', { path: r.value }))
  }

  const importSettings = (): void => {
    Modal.confirm({
      title: t('settings.backup.importConfirmTitle'),
      content: t('settings.backup.importConfirmBody'),
      okText: t('common.confirm'),
      okButtonProps: { danger: true },
      onOk: async () => {
        const r = await window.api.settings.importSettings()
        if (!r.ok) { void message.error(apiErrorText(r)); return }
        if (!r.value) return // cancelled
        void message.success(t('settings.backup.imported'))
        await load()
      },
    })
  }

  return (
    // Content (App.tsx) 是 flex:1 + overflow:hidden;这里占满其高度并自行滚动,
    // 否则窗口调小时设置内容会被裁剪而无法滚到。
    <div style={{ height: '100%', overflowY: 'auto', padding: token.paddingLG }}>
      <SectionHeading title={t('app.tab.settings')} description="外观与目录配置。" />
      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
        <Panel title={t('settings.section.appearance')}>
          <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
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

        <Panel title={t('settings.section.behavior')}>
          <div style={{ maxWidth: 620, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
              <div>
                <div style={{ fontWeight: 600 }}>{t('settings.askOnClose')}</div>
                <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, marginTop: 4 }}>
                  {t('settings.askOnClose.desc')}
                </div>
              </div>
              <Switch checked={askOnClose} onChange={value => void saveAskOnClose(value)} />
            </div>
            <div>
              <div style={{ fontWeight: 600 }}>{t('settings.closeToTray')}</div>
              <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, marginTop: 4, marginBottom: token.paddingSM }}>
                {t('settings.closeToTray.desc')}
              </div>
              <Radio.Group
                value={closeToTray ? 'tray' : 'quit'}
                onChange={e => void saveCloseToTray(e.target.value === 'tray')}
              >
                <Radio value="tray">{t('settings.closeAction.tray')}</Radio>
                <Radio value="quit">{t('settings.closeAction.quit')}</Radio>
              </Radio.Group>
            </div>
          </div>
        </Panel>

        <Panel title={t('settings.section.runtime')}>
          <div style={{ maxWidth: 560 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, marginBottom: token.paddingSM }}>
              <div>
                <div style={{ fontWeight: 600 }}>{t('settings.runtime.preferSystem')}</div>
                <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, marginTop: 4 }}>
                  {t('settings.runtime.preferSystem.desc')}
                </div>
              </div>
              <Switch checked={nodeEnv?.preference === 'system'} onChange={value => void saveNodePref(value)} />
            </div>
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label={t('settings.runtime.bundled')}>
                <span style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace' }}>{nodeEnv?.bundled ?? '—'}</span>
              </Descriptions.Item>
              <Descriptions.Item label={t('settings.runtime.system')}>
                {nodeEnv === undefined
                  ? '—'
                  : nodeEnv.system.installed
                    ? <span style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace' }}>{nodeEnv.system.version}</span>
                    : t('settings.runtime.systemNone')}
              </Descriptions.Item>
              <Descriptions.Item label={t('settings.runtime.use')}>
                {nodeEnv === undefined
                  ? '—'
                  : nodeEnv.prefer === 'system'
                    ? t('settings.runtime.useSystem', { v: nodeEnv.system.version })
                    : t('settings.runtime.useBundled', { v: nodeEnv.bundled })}
              </Descriptions.Item>
            </Descriptions>
            <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, marginTop: token.paddingSM }}>
              {t('settings.runtime.desc')}
            </div>
          </div>
        </Panel>

        <Panel title={t('settings.section.github')}>
          <div style={{ maxWidth: 620 }}>
            <div style={{ fontWeight: 600 }}>{t('settings.github.title')}</div>
            <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, margin: '4px 0 12px' }}>
              {t('settings.github.desc')}
            </div>
            <Space size="small" wrap style={{ marginBottom: token.paddingSM }}>
              <Tag color={githubAuth?.authenticated === true ? 'green' : 'default'}>
                {githubAuth?.authenticated === true
                  ? t(`settings.github.source.${githubAuth.source}`)
                  : t('settings.github.source.none')}
              </Tag>
              {githubAuth?.encryption === 'plaintext' && <Tag color="orange">{t('settings.github.encryption.plaintext')}</Tag>}
              {githubAuth?.rateLimited === true && <Tag color="red">{t('settings.github.rateLimited')}</Tag>}
            </Space>
            <Space.Compact style={{ width: '100%', maxWidth: 560 }}>
              <Input.Password
                value={githubInput}
                onChange={e => setGithubInput(e.target.value)}
                placeholder={t('settings.github.placeholder')}
                autoComplete="off"
              />
              <Button type="primary" loading={githubBusy} disabled={githubInput.trim() === ''} onClick={() => void saveGithubToken()}>
                {t('common.save')}
              </Button>
              <Button loading={githubBusy} onClick={() => void testGithubToken()}>{t('settings.github.test')}</Button>
              <Button danger loading={githubBusy} disabled={githubAuth?.authenticated !== true} onClick={() => void clearGithubToken()}>
                {t('settings.github.clear')}
              </Button>
            </Space.Compact>
            {githubLimit !== undefined && (
              <Alert
                style={{ marginTop: token.paddingSM }}
                type={githubLimit.ok ? 'success' : 'error'}
                showIcon
                title={githubLimit.ok
                  ? t('settings.github.testOk', { login: githubLimit.login ?? '—', limit: githubLimit.limit, remaining: githubLimit.remaining })
                  : t('settings.github.testFailed')}
              />
            )}
            <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, marginTop: token.paddingSM }}>
              {t('settings.github.hint')}
            </div>
          </div>
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

        <Panel title={t('settings.section.logs')}>
          <div style={{ maxWidth: 560 }}>
            <div style={{ fontWeight: 600 }}>{t('settings.logs.title')}</div>
            <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, margin: '4px 0 12px' }}>
              {t('settings.logs.desc')}
            </div>
            <Button
              icon={<FolderOpenOutlined />}
              onClick={async () => {
                const r = await window.api.logs.reveal()
                if (!r.ok) void message.error(apiErrorText(r))
              }}
            >
              {t('settings.logs.reveal')}
            </Button>
          </div>
        </Panel>

        <Panel title={t('settings.section.backup')}>
          <div style={{ maxWidth: 620 }}>
            <div style={{ fontWeight: 600 }}>{t('settings.backup.title')}</div>
            <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, margin: '4px 0 12px' }}>
              {t('settings.backup.desc')}
            </div>
            <Space>
              <Button icon={<DownloadOutlined />} onClick={() => void exportSettings()}>{t('settings.backup.export')}</Button>
              <Button icon={<UploadOutlined />} danger onClick={() => importSettings()}>{t('settings.backup.import')}</Button>
            </Space>
          </div>
        </Panel>
      </Space>
    </div>
  )
}