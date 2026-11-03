import { useEffect, useState } from 'react'
import { Alert, Button, Descriptions, Empty, Input, Modal, Radio, Segmented, Select, Space, Switch, Tag, message, theme } from 'antd'
import { DownloadOutlined, FolderOpenOutlined, UploadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import Panel from '../components/Panel.tsx'
import SectionHeading from '../components/SectionHeading.tsx'
import DirField from '../components/DirField.tsx'
import DerivedDirs from '../components/DerivedDirs.tsx'
import DataRootMoveModal from './DataRootMoveModal.tsx'
import AppShell from '../components/AppShell.tsx'
import NavList from '../components/NavList.tsx'
import FieldLabel from '../components/FieldLabel.tsx'
import { useThemeMode } from '../ThemeProvider.tsx'
import { useAppLang } from '../i18n'
import { apiErrorText, requestHealthRefresh } from '../lib/ipc.ts'
import type { ThemeMode } from '../theme.ts'
import type { DataRootState, GithubAuthState, GithubRateLimit, NodeEnvironment, RegistryEntryView, RegistryProbe } from '../../../shared/types.ts'

/** The settings categories, in reading order: the things a person changes about
 * the app, then the things it talks to, then where its files live. */
const PANES = [
  { key: 'appearance', label: 'settings.nav.appearance' },
  { key: 'behavior', label: 'settings.nav.behavior' },
  { key: 'network', label: 'settings.nav.network' },
  { key: 'storage', label: 'settings.nav.storage' },
] as const

type PaneKey = (typeof PANES)[number]['key']

/** 设置页：左侧分类 + 右侧配置面板。外观 / 行为 / 网络与凭据 / 存储与备份。 */
export default function SettingsSection() {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { mode, setMode } = useThemeMode()
  const { language, setLanguage } = useAppLang()
  const [pane, setPane] = useState<PaneKey>('appearance')
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
  /** The configured registries, as the editor lists them. */
  const [registries, setRegistries] = useState<RegistryEntryView[]>([])
  /** The entry being added or edited, or null while the list is shown. */
  const [form, setForm] = useState<{ id?: string; label: string; url: string; scope: string; token: string } | null>(null)
  /** Last probe per entry id. */
  const [probes, setProbes] = useState<Record<string, RegistryProbe>>({})
  /** A registry write/test is in flight. */
  const [registryBusy, setRegistryBusy] = useState(false)

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
    const list = await window.api.settings.listRegistries()
    if (list.ok) setRegistries(list.value)
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

  /** Open the form for a new entry, or for an existing one. */
  const editRegistry = (entry?: RegistryEntryView): void => {
    setForm({
      ...(entry !== undefined ? { id: entry.id } : {}),
      label: entry?.label ?? '',
      url: entry?.url ?? '',
      scope: entry?.scope ?? '',
      token: '',
    })
  }

  /** Persist whatever the form holds. The token is only sent when the field was
   * touched — an untouched field must not wipe a credential. */
  const submitRegistry = async (): Promise<void> => {
    if (form === null) return
    setRegistryBusy(true)
    const r = await window.api.settings.saveRegistry({
      ...(form.id !== undefined ? { id: form.id } : {}),
      label: form.label.trim(),
      url: form.url.trim(),
      scope: form.scope.trim(),
      ...(form.token !== '' ? { token: form.token } : {}),
    })
    setRegistryBusy(false)
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    setRegistries(r.value)
    setForm(null)
    void message.success(t('settings.registry.saved'))
  }

  const removeRegistry = async (entry: RegistryEntryView): Promise<void> => {
    setRegistryBusy(true)
    const r = await window.api.settings.removeRegistry(entry.id)
    setRegistryBusy(false)
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    setRegistries(r.value)
    setProbes(prev => { const next = { ...prev }; delete next[entry.id]; return next })
    void message.success(t('settings.registry.removed'))
  }

  const testRegistry = async (id?: string): Promise<void> => {
    const key = id ?? ''
    setRegistryBusy(true)
    const r = await window.api.settings.testRegistry(id)
    setRegistryBusy(false)
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    setProbes(prev => ({ ...prev, [key]: r.value }))
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

  /** What the probe means, as one severity and one sentence.
   *
   * A registry's root answering 404 is normal, so a status code is never the
   * headline: the answer is about the ADDRESS and the CREDENTIAL, which need
   * different fixes. */
  const registryProbeAlert = (probe: RegistryProbe): { type: 'success' | 'info' | 'warning' | 'error'; text: string } => {
    if (!probe.reachable) {
      return { type: 'error', text: t('settings.registry.probeUnreachable', { detail: probe.detail ?? '' }) }
    }
    if (probe.auth === 'ok') {
      return {
        type: 'success',
        text: probe.user !== undefined
          ? t('settings.registry.probeOkUser', { registry: probe.registry, user: probe.user })
          : t('settings.registry.probeOk', { registry: probe.registry }),
      }
    }
    if (probe.auth === 'rejected') {
      return { type: 'warning', text: t('settings.registry.probeRejected', { registry: probe.registry, status: probe.status ?? 0 }) }
    }
    if (probe.auth === 'required') {
      return { type: 'warning', text: t('settings.registry.probeNeedsToken', { registry: probe.registry }) }
    }
    return { type: 'info', text: t('settings.registry.probeUnverified', { registry: probe.registry }) }
  }

  const muted = { color: token.colorTextSecondary, fontSize: token.fontSizeSM }

  return (
    <AppShell
      sider={
        <>
          <div style={{ padding: 12 }}>
            <FieldLabel>{t('settings.nav.title')}</FieldLabel>
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            <NavList
              items={PANES}
              keyOf={item => item.key}
              selectedKey={pane}
              onSelect={item => setPane(item.key)}
              renderTitle={item => t(item.label)}
            />
          </div>
        </>
      }
    >
      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
        <SectionHeading title={t('app.tab.settings')} />

        {pane === 'appearance' && (
          <Panel title={t('settings.section.appearance')}>
            <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
              <div style={{ maxWidth: 560 }}>
                <div style={{ fontWeight: 600 }}>{t('settings.language')}</div>
                <div style={{ ...muted, marginTop: 4, marginBottom: token.paddingSM }}>
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
                <div style={{ ...muted, marginTop: token.paddingSM }}>
                  {t('settings.theme.systemHint')}
                </div>
              </div>
            </Space>
          </Panel>
        )}

        {pane === 'behavior' && (
          <>
            <Panel title={t('settings.section.behavior')}>
              <div style={{ maxWidth: 620, display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{t('settings.askOnClose')}</div>
                    <div style={{ ...muted, marginTop: 4 }}>
                      {t('settings.askOnClose.desc')}
                    </div>
                  </div>
                  <Switch checked={askOnClose} onChange={value => void saveAskOnClose(value)} />
                </div>
                <div>
                  <div style={{ fontWeight: 600 }}>{t('settings.closeToTray')}</div>
                  <div style={{ ...muted, marginTop: 4, marginBottom: token.paddingSM }}>
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
                    <div style={{ ...muted, marginTop: 4 }}>
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
                <div style={{ ...muted, marginTop: token.paddingSM }}>
                  {t('settings.runtime.desc')}
                </div>
              </div>
            </Panel>
          </>
        )}

        {pane === 'network' && (
          <>
            <Panel title={t('settings.section.github')}>
              <div style={{ maxWidth: 620 }}>
                <div style={{ fontWeight: 600 }}>{t('settings.github.title')}</div>
                <div style={{ ...muted, margin: '4px 0 12px' }}>
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
                <div style={{ ...muted, marginTop: token.paddingSM }}>
                  {t('settings.github.hint')}
                </div>
              </div>
            </Panel>

            <Panel title={t('settings.section.registry')}>
              <div style={{ maxWidth: 720 }}>
                <div style={{ ...muted, margin: '4px 0 12px' }}>{t('settings.registry.desc')}</div>

                {registries.length === 0 && form === null && (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description={t('settings.registry.empty')}
                    style={{ marginBottom: token.padding }}
                  />
                )}

                <Space orientation="vertical" size={8} style={{ width: '100%' }}>
                  {registries.map((entry) => {
                    const probe = probes[entry.id]
                    return (
                      <div
                        key={entry.id}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                          padding: '10px 12px',
                          borderRadius: token.borderRadiusLG,
                          border: `1px solid ${token.colorBorder}`,
                          background: token.colorBgContainer,
                        }}
                      >
                        <div style={{ flex: 1, minWidth: 240 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <span style={{ fontWeight: 500 }}>{entry.label}</span>
                            {entry.scope !== undefined
                              ? <Tag color="blue">{entry.scope}</Tag>
                              : <Tag>{t('settings.registry.fallbackTag')}</Tag>}
                            {entry.hasToken && (
                              <Tag color={entry.encryption === 'safe' ? 'green' : 'orange'}>
                                {entry.encryption === 'safe'
                                  ? t('settings.registry.token.safe')
                                  : t('settings.registry.token.plain')}
                              </Tag>
                            )}
                          </div>
                          <div style={{ ...muted, marginTop: 2, wordBreak: 'break-all' }}>{entry.url}</div>
                          {probe !== undefined && (
                            <Alert
                              style={{ marginTop: 6 }}
                              type={registryProbeAlert(probe).type}
                              showIcon
                              title={registryProbeAlert(probe).text}
                            />
                          )}
                        </div>
                        <Space size={8} style={{ flexShrink: 0 }}>
                          <Button size="small" loading={registryBusy} onClick={() => void testRegistry(entry.id)}>
                            {t('settings.registry.test')}
                          </Button>
                          <Button size="small" onClick={() => editRegistry(entry)}>{t('common.edit')}</Button>
                          <Button size="small" danger onClick={() => void removeRegistry(entry)}>{t('common.delete')}</Button>
                        </Space>
                      </div>
                    )
                  })}
                </Space>

                {form === null ? (
                  <Button style={{ marginTop: token.padding }} onClick={() => editRegistry()}>
                    {t('settings.registry.add')}
                  </Button>
                ) : (
                  <div style={{ marginTop: token.padding, padding: 12, borderRadius: token.borderRadiusLG, background: token.colorBgLayout }}>
                    <Space orientation="vertical" size={8} style={{ width: '100%' }}>
                      <div>
                        <div style={{ fontWeight: 500 }}>{t('settings.registry.urlLabel')}</div>
                        <Input
                          value={form.url}
                          onChange={e => setForm({ ...form, url: e.target.value })}
                          placeholder={t('settings.registry.placeholder')}
                          autoComplete="off"
                        />
                      </div>
                      <div>
                        <div style={{ fontWeight: 500 }}>{t('settings.registry.scope.label')}</div>
                        <Input
                          value={form.scope}
                          onChange={e => setForm({ ...form, scope: e.target.value })}
                          placeholder={t('settings.registry.scope.placeholder')}
                          autoComplete="off"
                        />
                        <div style={{ ...muted, marginTop: 4 }}>{t('settings.registry.scope.hint')}</div>
                      </div>
                      <div>
                        <div style={{ fontWeight: 500 }}>{t('settings.registry.token.label')}</div>
                        <Input.Password
                          value={form.token}
                          onChange={e => setForm({ ...form, token: e.target.value })}
                          placeholder={form.id !== undefined
                            ? t('settings.registry.token.replace')
                            : t('settings.registry.token.placeholder')}
                          autoComplete="new-password"
                        />
                        <div style={{ ...muted, marginTop: 4 }}>{t('settings.registry.token.hint')}</div>
                      </div>
                      <Space>
                        <Button type="primary" loading={registryBusy} disabled={form.url.trim() === ''} onClick={() => void submitRegistry()}>
                          {t('common.save')}
                        </Button>
                        <Button onClick={() => setForm(null)}>{t('common.cancel')}</Button>
                      </Space>
                    </Space>
                  </div>
                )}
              </div>
            </Panel>
          </>
        )}

        {pane === 'storage' && (
          <>
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
            </Panel>

            <Panel title={t('settings.section.logs')}>
              <div style={{ maxWidth: 560 }}>
                <div style={{ fontWeight: 600 }}>{t('settings.logs.title')}</div>
                <div style={{ ...muted, margin: '4px 0 12px' }}>
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
                <div style={{ ...muted, margin: '4px 0 12px' }}>
                  {t('settings.backup.desc')}
                </div>
                <Space>
                  <Button icon={<DownloadOutlined />} onClick={() => void exportSettings()}>{t('settings.backup.export')}</Button>
                  <Button icon={<UploadOutlined />} danger onClick={() => importSettings()}>{t('settings.backup.import')}</Button>
                </Space>
              </div>
            </Panel>
          </>
        )}
      </Space>

      {/* Outside the pane switch on purpose: a migration in progress must not
          disappear because the user looked at another category. */}
      <DataRootMoveModal
        open={migrateOpen}
        target={dataRootInput.trim()}
        onClose={() => setMigrateOpen(false)}
        onApplied={() => { setMigrateOpen(false); requestHealthRefresh(); void load() }}
      />
    </AppShell>
  )
}
