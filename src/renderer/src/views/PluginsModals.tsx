/** Modals for the Plugins page — the plugin detail / README dialog and the
 * install-into-profile picker. Each owns its own local state & data loading. */

import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Modal, Popconfirm, Select, Space, Spin, Tabs, Tag, Tooltip, message, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../lib/ipc.ts'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import FieldLabel from '../components/FieldLabel.tsx'
import { MODAL } from '../theme.ts'
import type { InstalledOverviewRow, PackageVersionInfo } from '../../../shared/types.ts'

/** Render a plugin README with images resolved against its install dir. */
function PluginReadme({ text, dir }: { text: string; dir: string }): JSX.Element {
  const { token } = theme.useToken()
  const mdComponents = useMemo<Components>(() => ({
    a: props => <a {...props} target="_blank" rel="noreferrer" style={{ color: token.colorPrimary }} />,
    code: props => <code {...props} style={{ background: token.colorFillTertiary, padding: '1px 5px', borderRadius: 4, fontSize: '0.9em' }} />,
    pre: props => <pre {...props} style={{ background: token.colorFillTertiary, padding: token.paddingSM, borderRadius: 6, overflowX: 'auto' }} />,
    img: props => {
      const raw = props.src ?? ''
      const src = dir !== '' && !/^[a-z]+:/i.test(raw)
        ? `file:///${dir.replace(/\\/g, '/')}${raw.startsWith('/') ? '' : '/'}${raw}`
        : raw
      return <img {...props} src={src} style={{ maxWidth: '100%', ...(props.style as object | undefined) }} />
    },
  }), [dir, token])
  return (
    <div style={{ maxHeight: 420, overflowY: 'auto', lineHeight: 1.7 }}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, rehypeSanitize]} components={mdComponents}>{text}</ReactMarkdown>
    </div>
  )
}

// ── Plugin detail: usage + README ──────────────────────────────────────────

interface PluginDetailModalProps {
  target: InstalledOverviewRow | null
  busy: boolean
  /** Archived versions of the plugin in the store — the ones a single-version
   * delete operates on. */
  storeVersions: string[]
  onClose: () => void
  onUninstall: (name: string) => void
  onUninstallVersion: (name: string, version: string) => void
  onReveal: (name: string) => void
  onInstallToProfile: (name: string) => void
}
export function PluginDetailModal(p: PluginDetailModalProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [tab, setTab] = useState<'usage' | 'readme'>('usage')
  const [readmeText, setReadmeText] = useState('')
  const [readmeDir, setReadmeDir] = useState('')

  useEffect(() => {
    if (p.target === null) { setReadmeText(''); setReadmeDir(''); setTab('usage'); return }
    let alive = true
    void window.api.plugins.readme(p.target.name).then(result => {
      if (result.ok && alive) { setReadmeText(result.value.content); setReadmeDir(result.value.dir) }
    })
    return () => { alive = false }
  }, [p.target])

  const target = p.target
  return (
    <Modal title={target?.name ?? ''} open={target !== null} onCancel={p.onClose} width={MODAL.wide}
      footer={target !== null ? (
        <Space>
          <Button onClick={() => void p.onReveal(target.name)}>{t('plugin.detail.reveal')}</Button>
          {target.inStore === true && (
            <>
              <Button danger type="primary" ghost loading={p.busy}
                onClick={() => {
                  const using = (target?.usage ?? []).map(u => `DSH「${u.dsh}」· profile「${u.profile}」`)
                  // Cascade: the plugin is in use, so the user must know the
                  // profiles will lose their reference along with the store removal.
                  Modal.confirm({
                    title: using.length > 0
                      ? t('plugin.detail.removeAllCascade', { name: target.name })
                      : t('plugin.detail.removeAllVersionsConfirm', { name: target.name }),
                    content: using.length > 0
                      ? t('plugin.detail.removeAllCascadeList', { profiles: using.join('、') })
                      : undefined,
                    okText: t('common.confirm'),
                    okButtonProps: { danger: true },
                    onOk: () => { void p.onUninstall(target.name) },
                  })
                }}>
                {t('plugin.detail.removeAllVersions')}
              </Button>
              <Button type="primary" onClick={() => { void p.onInstallToProfile(target.name) }}>{t('plugin.detail.installToProfile')}</Button>
            </>
          )}
        </Space>
      ) : null}>
      <Tabs activeKey={tab} onChange={key => setTab(key as 'usage' | 'readme')} items={[
        {
          key: 'usage',
          label: t('plugin.detail.usageTab'),
          children: (
            <Space direction="vertical" style={{ width: '100%' }} size="middle">
              <Space wrap>
                {target?.inStore === true && <Tag color="blue">{t('plugin.detail.storeTag')}</Tag>}
                {target?.builtin === true && <Tag color="purple">{t('plugin.detail.builtin')}</Tag>}
                <Tag>{t('plugin.detail.usageCount', { count: target?.usage.length ?? 0 })}</Tag>
              </Space>
              <div>
                <FieldLabel>{t('plugin.detail.versionsLabel')}</FieldLabel>
                {target !== null && p.storeVersions.length === 0 && (target.versions.length === 0)
                  ? <span style={{ color: token.colorTextSecondary }}>{t('plugin.detail.noVersions')}</span>
                  : (
                    <div>
                      {/* 本地存储归档版本 —— 逐个可管理：未使用可单删，使用中标记并禁用 */}
                      {p.storeVersions.length > 0 && p.storeVersions.map(v => {
                        const users = (target?.usage ?? []).filter(u => u.version === v).map(u => u.profile)
                        const inUse = users.length > 0
                        return (
                          <div key={v} style={{ display: 'flex', alignItems: 'center', padding: '4px 0', borderBottom: `1px solid ${token.colorSplit}` }}>
                            <Tag color="blue" style={{ flexShrink: 0 }}>{t('plugin.detail.storeTag')}</Tag>
                            <span style={{ fontFamily: 'monospace', marginInline: 6, color: token.colorText }}>{v}</span>
                            {inUse
                              ? (
                                <Tooltip title={t('plugin.detail.inUseBy', { profiles: users.join('、') })}>
                                  <Tag color="green" style={{ marginInlineStart: 'auto' }}>{t('plugin.detail.versionInUse')}</Tag>
                                </Tooltip>
                              )
                              : (
                                <span style={{ marginInlineStart: 'auto' }}>
                                  <Popconfirm title={t('plugin.detail.removeVersionConfirm', { version: v })}
                                    okText={t('common.confirm')} okButtonProps={{ danger: true }}
                                    onConfirm={() => { if (target !== null) void p.onUninstallVersion(target.name, v) }}>
                                    <Button size="small" danger type="text" loading={p.busy}>{t('plugin.detail.removeVersion')}</Button>
                                  </Popconfirm>
                                </span>
                              )}
                          </div>
                        )
                      })}
                      {/* 非 store 的已解析版本（内置 bundle / 本地 link）—— 只读展示 */}
                      {(target?.versions ?? []).filter(v => !p.storeVersions.includes(v)).map(v => (
                        <div key={v} style={{ display: 'flex', alignItems: 'center', padding: '4px 0', borderBottom: `1px solid ${token.colorSplit}` }}>
                          <Tag color="purple" style={{ flexShrink: 0 }}>{t('plugin.detail.notInStore')}</Tag>
                          <span style={{ fontFamily: 'monospace', marginInline: 6, color: token.colorText }}>{v}</span>
                        </div>
                      ))}
                    </div>
                  )}
              </div>
              <div>
                <FieldLabel>{t('plugin.detail.usageTab')}</FieldLabel>
                {target !== null && target.usage.length === 0
                  ? <span style={{ color: token.colorTextSecondary }}>{t('plugin.detail.noUsage')}</span>
                  : (target?.usage ?? []).map((u, i) => (
                      <div key={i} style={{ padding: '6px 0', fontSize: token.fontSize, lineHeight: 1.6, borderBottom: i < (target?.usage.length ?? 0) - 1 ? `1px solid ${token.colorSplit}` : 0 }}>
                        <span>DSH「{u.dsh}」</span>
                        {u.dshVersion !== undefined && <Tag style={{ marginInline: 4 }}>v{u.dshVersion}</Tag>}
                        <span>· profile「{u.profile}」</span>
                        {u.version !== undefined && <Tag style={{ marginInline: 4, fontFamily: 'monospace' }}>@{u.version}</Tag>}
                      </div>
                    ))}
              </div>
            </Space>
          ),
        },
        {
          key: 'readme',
          label: t('plugin.detail.readmeTab'),
          children: readmeText === '' ? (
            <div style={{ color: token.colorTextSecondary }}>{t('plugin.detail.noReadme')}</div>
          ) : (
            <PluginReadme text={readmeText} dir={readmeDir} />
          ),
        },
      ]} />
    </Modal>
  )
}

// ── store membership ────────────────────────────────────────────────────────

/** Build a plugin-name → archived versions map from `plugins:list` rows. The
 * same plugin can hold several versions (the versioned store), so "in store" is
 * "this name has at least one archived version", and install-to-profile offers
 * the version list. */
export function toStoreMap(rows: { name: string; version: string }[]): Map<string, string[]> {
  const m = new Map<string, string[]>()
  for (const p of rows) {
    const a = m.get(p.name)
    if (a === undefined) m.set(p.name, [p.version])
    else a.push(p.version)
  }
  return m
}

// ── Install into a profile ─────────────────────────────────────────────────

interface InstallToProfileModalProps {
  installPkg: string | null
  /** Archived store versions of the plugin; the one to link is chosen here. */
  versions: string[]
  onClose: () => void
  onDone: () => void | Promise<void>
}
export function InstallToProfileModal(p: InstallToProfileModalProps): JSX.Element {
  const { t } = useTranslation()
  const [installScopes, setInstallScopes] = useState<{ id: string; name: string; version?: string; profiles: string[] }[]>([])
  const [installDsh, setInstallDsh] = useState<string>()
  const [installProfile, setInstallProfile] = useState<string>()
  // Which archived version to link; defaults to the latest archived one.
  const [version, setVersion] = useState<string>()
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    if (p.installPkg === null) return
    setVersion(p.versions.length > 0 ? p.versions[p.versions.length - 1] : undefined)
    void (async () => {
      const opts = await window.api.plugins.installOptions()
      if (opts.ok) setInstallScopes(opts.value)
    })()
  }, [p.installPkg, p.versions])

  const doInstall = async (): Promise<void> => {
    if (p.installPkg === null || installDsh === undefined || installProfile === undefined) { void message.warning(t('plugin.install.needBoth')); return }
    setInstalling(true)
    const res = await window.api.plugins.installToProfile(installProfile, p.installPkg, version, installDsh)
    setInstalling(false)
    if (!res.ok) { void message.error(apiErrorText(res)); return }
    void message.success(`${p.installPkg}${version !== undefined ? `@${version}` : ''} → ${installProfile}：${res.value}`)
    p.onClose()
    setInstallDsh(undefined)
    setInstallProfile(undefined)
    await p.onDone()
  }

  const showVersionPicker = p.versions.length > 1
  return (
    <Modal title={t('plugin.install.title', { name: p.installPkg ?? '' })} open={p.installPkg !== null} okText={t('plugin.install.install')} onOk={() => void doInstall()}
      okButtonProps={{ disabled: installProfile === undefined }} onCancel={() => { p.onClose(); setInstallDsh(undefined); setInstallProfile(undefined) }}
      confirmLoading={installing} destroyOnClose width={MODAL.narrow}>
      <div style={{ marginBottom: 10, color: 'inherit' }}>
        {t('plugin.install.prompt', { name: p.installPkg ?? '' })}
      </div>
      {showVersionPicker && (
        <div style={{ marginBottom: 8 }}>
          <FieldLabel>{t('plugin.install.version')}</FieldLabel>
          <Select value={version} onChange={setVersion} style={{ width: '100%' }} placeholder={t('plugin.install.versionPlaceholder')}
            options={p.versions.map(v => ({ value: v, label: v }))} />
        </div>
      )}
      <div style={{ marginBottom: 6 }}>
        <FieldLabel>{t('plugin.install.dsh')}</FieldLabel>
        <Select value={installDsh} onChange={v => { setInstallDsh(v); setInstallProfile(undefined) }} style={{ width: '100%' }} placeholder={t('plugin.install.dshPlaceholder')}
          options={installScopes.map(s => ({ value: s.id, label: `${s.name}${s.version !== undefined ? ` (v${s.version})` : ''}` }))} />
      </div>
      <div>
        <FieldLabel>{t('plugin.install.profile')}</FieldLabel>
        <Select value={installProfile} onChange={setInstallProfile} style={{ width: '100%' }} placeholder={t('plugin.install.profilePlaceholder')}
          disabled={installDsh === undefined}
          options={(installScopes.find(s => s.id === installDsh)?.profiles ?? []).map(x => ({ value: x, label: x }))} />
      </div>
    </Modal>
  )
}

// ── Download with a selectable version ──────────────────────────────────────

interface DownloadVersionModalProps {
  pkg: string | null
  onClose: () => void
  /** Called once the package has been added to the store. */
  onInstalled: () => void | Promise<void>
}
export function DownloadVersionModal(p: DownloadVersionModalProps): JSX.Element {
  const { t } = useTranslation()
  const [info, setInfo] = useState<PackageVersionInfo | null>(null)
  const [version, setVersion] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (p.pkg === null) { setInfo(null); setVersion(undefined); setError(''); return }
    let alive = true
    setLoading(true)
    setError('')
    void window.api.plugins.pkgVersions(p.pkg).then(r => {
      if (!alive) return
      setLoading(false)
      if (!r.ok) { setError(apiErrorText(r)); return }
      setInfo(r.value)
      setVersion(r.value.distTags.latest ?? r.value.versions[0])
    })
    return () => { alive = false }
  }, [p.pkg])

  const doDownload = async (): Promise<void> => {
    if (p.pkg === null || version === undefined) return
    setInstalling(true)
    const r = await window.api.plugins.add(`${p.pkg}@${version}`)
    setInstalling(false)
    if (!r.ok) { setError(apiErrorText(r)); return }
    await p.onInstalled()
    void message.success(t('plugin.version.downloaded', { spec: `${p.pkg}@${version}` }))
    p.onClose()
  }

  const tags = info !== null ? Object.entries(info.distTags) : []
  return (
    <Modal title={t('plugin.version.title', { name: p.pkg ?? '' })} open={p.pkg !== null} onCancel={p.onClose}
      okText={t('plugin.version.download')} onOk={() => void doDownload()} confirmLoading={installing}
      okButtonProps={{ disabled: version === undefined || loading || info === null }}
      width={MODAL.narrow}>
      <Space direction="vertical" style={{ width: '100%' }} size="small">
        {loading && <div style={{ color: 'inherit' }}><Spin size="small" />　{t('plugin.version.loading')}</div>}

        {error !== '' && <Alert type="error" showIcon message={error} />}

        {info !== null && !loading && (
          <>
            {tags.length > 0 && (
              <div>
                <FieldLabel>{t('plugin.version.distTags')}</FieldLabel>
                <Space wrap size={4}>
                  {tags.map(([tag, ver]) => <Tag key={tag}>{tag}={ver}</Tag>)}
                </Space>
              </div>
            )}
            <div>
              <FieldLabel>{t('plugin.version.select')}</FieldLabel>
              <Select showSearch style={{ width: '100%' }} value={version} onChange={setVersion}
                placeholder={t('plugin.version.placeholder')} optionFilterProp="label"
                options={info.versions.map(v => ({ value: v, label: v }))} />
            </div>
          </>
        )}
      </Space>
    </Modal>
  )
}