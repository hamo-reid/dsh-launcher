import { useEffect, useState } from 'react'
import { Alert, Button, Descriptions, Input, Modal, Radio, Segmented, Select, Space, Switch, Tag, message, theme } from 'antd'
import { DownloadOutlined, FolderOpenOutlined, UploadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import Panel from '../components/Panel.tsx'
import SectionHeading from '../components/SectionHeading.tsx'
import DirField from '../components/DirField.tsx'
import DerivedDirs from '../components/DerivedDirs.tsx'
import DataRootMoveModal from './DataRootMoveModal.tsx'
import { useThemeMode } from '../ThemeProvider.tsx'
import { useAppLang } from '../i18n'
import { apiErrorText, requestHealthRefresh } from '../lib/ipc.ts'
import type { ThemeMode } from '../theme.ts'
import type { DataRootState, GithubAuthState, GithubRateLimit, NodeEnvironment } from '../../../shared/types.ts'

/** 设置页：外观(主题 + 语言) + 目录配置(DSH 版本库 / 插件保存位置)。 */
export default function SettingsSection() {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { mode, setMode } = useThemeMode()
  const { language, setLanguage } = useAppLang()
  const [dataRootInput, setDataRootInput] = useState('')
  const [dataRootState, setDataRootState] = useState<DataRootState>()
  const [rootBusy, setRootBusy] = useState(false)
  const [migrateOpen, setMigrateOpen] = useState(false)
  const [closeToTray, setCloseToTray] = useState(true)
  const [askOnClose, setAskOnClose] = useState(true)
  const [nodeEnv, setNodeEnv] = useState<NodeEnvironment>()
  const [githubAuth, setGithubAuth] = useState<GithubAuthState>()
  const [githubInput, setGithubInput] = useState('')
  const [githubBusy, setGithubBusy] = useState(false)
  const [githubLimit, setGithubLimit] = useState<GithubRateLimit>()

  const load = async (): Promise<void> => {
    const d = await window.api.settings.getDataRoot()
    // The field shows the CONFIGURED root, so an unset one stays visibly empty
    // rather than adopting — and thereby persisting — the effective default.
    if (d.ok) { setDataRootState(d.value); setDataRootInput(d.value.configured) }
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

  const derived: DataRootState['derived'] = dataRootState?.derived
    ?? { plugins: '', skillLibrary: '', dshVersions: '' }

  /** `dir === ''` resets to the default. Data is only copied when `migrate`
   * is set, which the move dialog drives after previewing. */
  const applyRoot = async (dir: string, migrate: boolean): Promise<void> => {
    setRootBusy(true)
    const res = await window.api.settings.applyDataRoot(dir, { migrate })
    setRootBusy(false)
    if (!res.ok) { void message.error(apiErrorText(res)); return }
    if (res.value.applied) {
      void message.success(t('settings.dataRoot.applied'))
    } else {
      // A failed item deliberately leaves the settings on the OLD root.
      void message.error(t('settings.dataRoot.partial', { items: res.value.failed.join(t('common.listSep')) }))
    }
    requestHealthRefresh()
    await load()
  }

  const browseDataRoot = async (): Promise<void> => {
    const res = await window.api.settings.pickDir({
      title: t('settings.dataRoot'),
      defaultPath: dataRootInput.trim() === '' ? dataRootState?.effective : dataRootInput,
    })
    if (!res.ok) { void message.error(apiErrorText(res)); return }
    if (res.value !== '') setDataRootInput(res.value)
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
          <DirField
            title={t('settings.dataRoot')}
            desc={t('settings.dataRoot.desc')}
            value={dataRootInput}
            onChange={setDataRootInput}
            onBrowse={() => void browseDataRoot()}
            browseLabel={t('onboarding.browse')}
          />
          <Space style={{ marginBottom: token.paddingLG }}>
            <Button type="primary" loading={rootBusy} onClick={() => void applyRoot(dataRootInput.trim(), false)}>
              {t('common.save')}
            </Button>
            <Button disabled={dataRootInput.trim() === ''} onClick={() => setMigrateOpen(true)}>
              {t('settings.dataRoot.migrate')}
            </Button>
            <Button
              disabled={dataRootState === undefined || dataRootState.configured === ''}
              onClick={() => void applyRoot('', false)}
            >
              {t('settings.dataRoot.reset')}
            </Button>
          </Space>
          <DerivedDirs derived={derived} />
          {(dataRootState?.legacy.length ?? 0) > 0 && (
            <Alert
              type="warning"
              showIcon
              title={t('settings.dataRoot.legacyTitle')}
              description={t('settings.dataRoot.legacyDesc', {
                paths: (dataRootState?.legacy ?? []).map(l => l.path).join(t('common.listSep')),
              })}
            />
          )}
          <DataRootMoveModal
            open={migrateOpen}
            target={dataRootInput.trim()}
            onClose={() => setMigrateOpen(false)}
            onApplied={() => { setMigrateOpen(false); requestHealthRefresh(); void load() }}
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