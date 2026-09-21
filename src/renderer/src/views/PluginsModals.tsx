/** Modals for the Plugins page — the plugin detail / README dialog and the
 * install-into-profile picker. Each owns its own local state & data loading. */

import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Checkbox, Modal, Popconfirm, Select, Space, Spin, Tabs, Tag, Tooltip, message, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../lib/ipc.ts'
import { fmtBytes } from '../lib/format.ts'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import FieldLabel from '../components/FieldLabel.tsx'
import { MODAL } from '../theme.ts'
import type { GithubAuthState, InstalledOverviewRow, PackageVersionInfo, PluginApplyResult, PluginUpdateInfo, PluginUpdateResult } from '../../../shared/types.ts'

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

/** Semantically-coloured source tags — mirrors PluginsSection. */
const SOURCE_COLORS: Record<string, string> = {
  github: 'green',
  npm: 'blue',
  local: 'cyan',
  dsh: 'purple',
  store: 'default',
}

// ── Plugin detail: usage + README ──────────────────────────────────────────

interface PluginDetailModalProps {
  target: InstalledOverviewRow | null
  busy: boolean
  /** Update-check result for this plugin, when a check has run. */
  update?: PluginUpdateInfo
  /** Archived versions of the plugin in the store — the ones a single-version
   * delete operates on. */
  storeVersions: string[]
  /** Real on-disk size from the overview's manual size calc, when computed. */
  sizeBytes?: number
  onClose: () => void
  /** Open the version picker to download another version into the store. */
  onDownloadVersion: (name: string) => void
  /** One-click download of the newest release into the store. */
  onUpdate: (name: string) => void
  onUninstall: (name: string) => void
  onUninstallVersion: (name: string, version: string) => void
  onReveal: (name: string) => void
  onInstallToProfile: (name: string) => void
  /** Remove the plugin's unused archived versions (keep newest + in-use). */
  onCleanupVersions: (name: string) => void
  /** Catalog replacement name when this plugin is deprecated. */
  replacement?: string
  /** Migrate the deprecated plugin to `replacement` across using profiles. */
  onMigrate: (name: string, replacement: string) => void
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
  const usedVersions = new Set((target?.usage ?? []).map(u => u.version).filter((v): v is string => v !== undefined && v !== ''))
  const latestStoreVersion = p.storeVersions.length > 0 ? p.storeVersions[p.storeVersions.length - 1] : undefined
  const unusedVersions = p.storeVersions.filter(v => v !== latestStoreVersion && !usedVersions.has(v))
  return (
    <Modal title={target?.name ?? ''} open={target !== null} onCancel={p.onClose} width={MODAL.wide}
      footer={target !== null ? (
        <Space>
          <Button onClick={() => void p.onReveal(target.name)}>{t('plugin.detail.reveal')}</Button>
          <Button onClick={() => p.onDownloadVersion(target.name)}>{t('plugin.detail.downloadVersion')}</Button>
          {p.update?.updateAvailable === true && p.update.latest !== undefined && (
            <Button type="primary" ghost onClick={() => p.onUpdate(target.name)}>
              {t('plugin.overview.updateTo', { version: p.update.latest })}
            </Button>
          )}
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
                      ? t('plugin.detail.removeAllCascadeList', { profiles: using.join(t('common.listSep')) })
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
          {p.replacement !== undefined && p.replacement !== '' && (
            <Button
              type="primary"
              onClick={() => {
                const replacement = p.replacement as string
                Modal.confirm({
                  title: t('plugin.detail.migrateConfirmTitle', { name: target.name, target: replacement }),
                  content: t('plugin.detail.migrateConfirmBody'),
                  okText: t('common.confirm'),
                  onOk: () => { p.onMigrate(target.name, replacement) },
                })
              }}
            >
              {t('plugin.detail.migrateTo', { target: p.replacement })}
            </Button>
          )}
        </Space>
      ) : null}>
      <Tabs activeKey={tab} onChange={key => setTab(key as 'usage' | 'readme')} items={[
        {
          key: 'usage',
          label: t('plugin.detail.usageTab'),
          children: (
            <Space orientation="vertical" style={{ width: '100%' }} size="middle">
              <Space wrap>
                {(target?.sources ?? []).map(s => (
                  <Tag key={s} color={SOURCE_COLORS[s] ?? 'default'}>{t(`plugin.source.${s}`)}</Tag>
                ))}
                {(target?.sources.length ?? 0) === 0 && <span style={{ color: token.colorTextTertiary }}>-</span>}
                <Tag>{t('plugin.detail.usageCount', { count: target?.usage.length ?? 0 })}</Tag>
                {p.sizeBytes !== undefined && <Tag>{t('plugin.detail.size')}: {fmtBytes(p.sizeBytes)}</Tag>}
              </Space>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <FieldLabel>{t('plugin.detail.versionsLabel')}</FieldLabel>
                  {unusedVersions.length > 0 && (
                    <Popconfirm
                      title={t('plugin.detail.cleanupConfirm', { count: unusedVersions.length })}
                      okText={t('common.confirm')}
                      okButtonProps={{ danger: true }}
                      onConfirm={() => { if (target !== null) p.onCleanupVersions(target.name) }}
                    >
                      <Button size="small" loading={p.busy}>{t('plugin.detail.cleanupVersions', { count: unusedVersions.length })}</Button>
                    </Popconfirm>
                  )}
                </div>
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
                                <Tooltip title={t('plugin.detail.inUseBy', { profiles: users.join(t('common.listSep')) })}>
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
    const res = await window.api.plugins.installToProfile(installDsh, installProfile, p.installPkg, version)
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
      confirmLoading={installing} destroyOnHidden width={MODAL.narrow}>
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
    // Fire a cancellable session; progress/cancel + store refresh are handled by
    // the global download panel, so the dialog simply closes once initiated.
    const r = await window.api.downloads.start(`${p.pkg}@${version}`, p.pkg)
    if (!r.ok) { setError(apiErrorText(r)); return }
    void message.success(t('plugin.version.downloadStarted', { spec: `${p.pkg}@${version}` }))
    p.onClose()
  }

  const tags = info !== null ? Object.entries(info.distTags) : []
  return (
    <Modal title={t('plugin.version.title', { name: p.pkg ?? '' })} open={p.pkg !== null} onCancel={p.onClose}
      okText={t('plugin.version.download')} onOk={() => void doDownload()} confirmLoading={installing}
      okButtonProps={{ disabled: version === undefined || loading || info === null }}
      width={MODAL.narrow}>
      <Space orientation="vertical" style={{ width: '100%' }} size="small">
        {loading && <div style={{ color: 'inherit' }}><Spin size="small" />　{t('plugin.version.loading')}</div>}

        {error !== '' && <Alert type="error" showIcon title={error} />}

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

// ── Replace one profile bundle's version ─────────────────────────────────────

export interface BundleVersionTarget {
  dshId: string
  profile: string
  bundle: string
  /** Version currently resolved in the profile, when known. */
  current?: string
}

interface BundleVersionModalProps {
  target: BundleVersionTarget | null
  onClose: () => void
  /** Called after a successful replace, so the profile detail can reload. */
  onDone: () => void | Promise<void>
}

/** Re-version one bundle layer of a profile. Store-archived versions come first;
 * the npm registry list is merged in when reachable (a github/local-only name
 * 404s here, which simply degrades to store-only). Applying reuses
 * `plugins:applyUpdates`, which downloads a missing version and re-points the
 * profile's dependency (keeping the layer activated). */
export function BundleVersionModal(p: BundleVersionModalProps): JSX.Element {
  const { t } = useTranslation()
  const [storeVersions, setStoreVersions] = useState<string[]>([])
  const [npm, setNpm] = useState<PackageVersionInfo | null>(null)
  const [version, setVersion] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (p.target === null) { setStoreVersions([]); setNpm(null); setVersion(undefined); setError(''); return }
    const bundle = p.target.bundle
    let alive = true
    setLoading(true)
    setError('')
    void (async () => {
      const [list, versions] = await Promise.all([
        window.api.plugins.list(),
        window.api.plugins.pkgVersions(bundle),
      ])
      if (!alive) return
      setLoading(false)
      setStoreVersions(list.ok ? toStoreMap(list.value).get(bundle) ?? [] : [])
      setNpm(versions.ok ? versions.value : null)
    })()
    return () => { alive = false }
  }, [p.target])

  const target = p.target
  const npmVersions = (npm?.versions ?? []).filter(v => !storeVersions.includes(v))
  // Default pick: the newest archived version, else the registry's latest.
  const latestStore = storeVersions.length > 0 ? storeVersions[storeVersions.length - 1] : undefined
  const fallback = latestStore ?? npm?.distTags.latest ?? npmVersions[npmVersions.length - 1]

  useEffect(() => { setVersion(fallback) }, [target?.bundle, fallback])

  const apply = async (): Promise<void> => {
    if (target === null || version === undefined) return
    setBusy(true)
    const r = await window.api.plugins.applyUpdates(target.dshId, target.profile, [{ name: target.bundle, version }])
    setBusy(false)
    if (!r.ok) { setError(apiErrorText(r)); return }
    const failed = r.value.results.find(x => !x.ok)
    if (failed !== undefined) { setError(`${failed.name}@${failed.version}: ${failed.text}`); return }
    void message.success(t('profile.bundle.replaced', { bundle: target.bundle, version }))
    await p.onDone()
    p.onClose()
  }

  const distTags = Object.entries(npm?.distTags ?? {})
  const options = [
    ...storeVersions.map(v => ({ value: v, label: `${v} · ${t('plugin.detail.storeTag')}` })),
    ...npmVersions.map(v => ({ value: v, label: v })),
  ]
  return (
    <Modal
      title={t('profile.bundle.replaceTitle', { bundle: target?.bundle ?? '' })}
      open={target !== null}
      onCancel={p.onClose}
      okText={t('profile.bundle.replace')}
      onOk={() => void apply()}
      confirmLoading={busy}
      okButtonProps={{ disabled: version === undefined || version === target?.current }}
      width={MODAL.narrow}
    >
      <Space orientation="vertical" style={{ width: '100%' }} size="small">
        <div style={{ color: 'inherit', fontSize: 12 }}>{t('profile.bundle.replaceHint')}</div>
        {target?.current !== undefined && target.current !== '' && (
          <div>
            <FieldLabel>{t('profile.bundle.current')}</FieldLabel>
            <Tag style={{ fontFamily: 'monospace' }}>@{target.current}</Tag>
          </div>
        )}
        {loading && <div><Spin size="small" />　{t('plugin.version.loading')}</div>}
        {error !== '' && <Alert type="error" showIcon title={error} />}
        {distTags.length > 0 && (
          <div>
            <FieldLabel>{t('plugin.version.distTags')}</FieldLabel>
            <Space wrap size={4}>{distTags.map(([tag, ver]) => <Tag key={tag}>{tag}={ver}</Tag>)}</Space>
          </div>
        )}
        <div>
          <FieldLabel>{t('profile.bundle.version')}</FieldLabel>
          <Select
            showSearch
            style={{ width: '100%' }}
            value={version}
            onChange={setVersion}
            optionFilterProp="label"
            placeholder={t('plugin.version.placeholder')}
            options={options}
          />
        </div>
        {!loading && options.length === 0 && (
          <div style={{ color: 'inherit' }}>{t('profile.bundle.noVersions')}</div>
        )}
      </Space>
    </Modal>
  )
}

// ── Update one plugin to a chosen version across profiles ────────────────────

/** What the overview hands the update dialog. */
export interface UpdatePluginTarget {
  name: string
  /** Preferred default version (the update check's latest). */
  latest?: string
  /** Profiles using it, as (dsh name, profile, resolved version when installed). */
  usage: { dsh: string; profile: string; version?: string }[]
}

interface UpdatePluginModalProps {
  target: UpdatePluginTarget | null
  onClose: () => void
  onDone: () => void | Promise<void>
}

/** Pick a version (any npm release, or one already archived) and which profiles
 * to re-point, then download once and apply. With no profile selected it simply
 * archives the version into the store. */
export function UpdatePluginModal(p: UpdatePluginModalProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [versions, setVersions] = useState<string[]>([])
  const [distTags, setDistTags] = useState<Record<string, string>>({})
  const [archived, setArchived] = useState<string[]>([])
  const [version, setVersion] = useState<string>()
  const [scopes, setScopes] = useState<{ id: string; name: string; profiles: string[] }[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [keepOld, setKeepOld] = useState(true)
  const [applyEnabled, setApplyEnabled] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<PluginUpdateResult | null>(null)

  const keyOf = (dshId: string, profile: string): string => `${dshId}\u0000${profile}`

  useEffect(() => {
    if (p.target === null) { setResult(null); setError(''); return }
    const target = p.target
    const name = target.name
    let alive = true
    setLoading(true)
    setError('')
    setResult(null)
    void (async () => {
      const [info, list, options] = await Promise.all([
        window.api.plugins.pkgVersions(name),
        window.api.plugins.list(),
        window.api.plugins.installOptions(),
      ])
      if (!alive) return
      setLoading(false)
      const npm = info.ok ? info.value.versions : []
      const tags = info.ok ? info.value.distTags : {}
      const store = list.ok ? toStoreMap(list.value).get(name) ?? [] : []
      const nextScopes = options.ok ? options.value : []
      setVersions(npm)
      setDistTags(tags)
      setArchived(store)
      setScopes(nextScopes)
      setVersion(target.latest ?? tags.latest ?? npm[npm.length - 1])
      // Applying to profiles is opt-in and starts with nothing ticked.
      setKeepOld(true)
      setApplyEnabled(false)
      setSelected([])
    })()
    return () => { alive = false }
  }, [p.target])

  const choices = [...new Set([...archived, ...versions])]
  // Only profiles where the plugin is actually installed can be re-pointed.
  const installed = (p.target?.usage ?? []).filter(u => u.version !== undefined && u.version !== '')
  const toggle = (key: string): void =>
    setSelected(prev => prev.includes(key) ? prev.filter(x => x !== key) : [...prev, key])

  const apply = async (): Promise<void> => {
    if (p.target === null || version === undefined) return
    setBusy(true)
    const targets = applyEnabled
      ? selected.map((key) => {
        const at = key.indexOf('\u0000')
        return { dshId: key.slice(0, at), profile: key.slice(at + 1) }
      })
      : []
    const r = await window.api.plugins.applyUpdate(p.target.name, version, targets, { keepOld })
    setBusy(false)
    if (!r.ok) { setError(apiErrorText(r)); return }
    setResult(r.value)
    const ok = r.value.results.filter(x => x.ok).length
    if (r.value.results.length > 0) void message.success(t('plugin.updateTo.done', { count: ok }))
    await p.onDone()
  }

  return (
    <Modal
      title={t('plugin.updateTo.title', { name: p.target?.name ?? '' })}
      open={p.target !== null}
      onCancel={p.onClose}
      width={MODAL.wide}
      footer={result !== null
        ? <Button type="primary" onClick={p.onClose}>{t('common.close')}</Button>
        : (
          <Space>
            <Button onClick={p.onClose} disabled={busy}>{t('common.cancel')}</Button>
            <Button type="primary" loading={busy} disabled={version === undefined} onClick={() => void apply()}>
              {t('common.confirm')}
            </Button>
          </Space>
        )}
    >
      <Space orientation="vertical" size="small" style={{ width: '100%' }}>
        {loading && <div><Spin size="small" /> {t('plugin.version.loading')}</div>}
        {error !== '' && <Alert type="error" showIcon title={error} />}

        {result === null ? (
          <>
            {Object.keys(distTags).length > 0 && (
              <div>
                <FieldLabel>{t('plugin.version.distTags')}</FieldLabel>
                <Space wrap size={4}>
                  {Object.entries(distTags).map(([tag, ver]) => <Tag key={tag}>{tag}={ver}</Tag>)}
                </Space>
              </div>
            )}
            <div>
              <FieldLabel>{t('plugin.updateTo.version')}</FieldLabel>
              <Select
                showSearch
                style={{ width: '100%' }}
                value={version}
                onChange={setVersion}
                optionFilterProp="label"
                options={choices.map(v => ({
                  value: v,
                  label: archived.includes(v) ? `${v} · ${t('plugin.detail.storeTag')}` : v,
                }))}
              />
            </div>
            <div>
              <Checkbox checked={keepOld} onChange={e => setKeepOld(e.target.checked)}>
                {t('plugin.updateTo.keepOld')}
              </Checkbox>
              <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>
                {t('plugin.updateTo.keepOldHint')}
              </div>
            </div>
            <div>
              <Checkbox
                checked={applyEnabled}
                disabled={installed.length === 0}
                onChange={e => setApplyEnabled(e.target.checked)}
              >
                {t('plugin.updateTo.applyTo')}
              </Checkbox>
              <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>
                {installed.length === 0 ? t('plugin.updateTo.noneInstalled') : t('plugin.updateTo.applyHint')}
              </div>
              {applyEnabled && installed.length > 0 && (
                <>
                  <Space size={4} style={{ margin: '4px 0' }}>
                    <Button size="small" onClick={() => setSelected(installed.flatMap(u => {
                      const id = scopes.find(s => s.name === u.dsh)?.id
                      return id === undefined ? [] : [keyOf(id, u.profile)]
                    }))}>{t('plugin.updateTo.selectAll')}</Button>
                    <Button size="small" onClick={() => setSelected([])}>{t('plugin.updateTo.selectNone')}</Button>
                  </Space>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {installed.map(u => {
                      const id = scopes.find(s => s.name === u.dsh)?.id
                      const key = id === undefined ? '' : keyOf(id, u.profile)
                      return (
                        <Checkbox
                          key={`${u.dsh}:${u.profile}`}
                          disabled={key === ''}
                          checked={key !== '' && selected.includes(key)}
                          onChange={() => { if (key !== '') toggle(key) }}
                        >
                          {u.dsh} · {u.profile} · @{u.version}
                        </Checkbox>
                      )
                    })}
                  </div>
                </>
              )}
            </div>
          </>
        ) : (
          <>
            {result.downloaded && (
              <Alert type="success" showIcon title={t('plugin.updateTo.downloaded', { name: p.target?.name ?? '', version })} />
            )}
            {(result.removed?.length ?? 0) > 0 && (
              <Alert type="info" showIcon title={t('plugin.updateTo.cleaned', { count: result.removed?.length ?? 0 })} />
            )}
            {result.results.map(r => (
              <div key={`${r.dsh}:${r.profile}`} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Tag color={r.ok ? 'success' : 'error'}>{r.ok ? t('plugin.update.ok') : t('download.status.failed')}</Tag>
                <span>{r.profile}</span>
                <span style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>{r.text}</span>
              </div>
            ))}
          </>
        )}
      </Space>
    </Modal>
  )
}

// ── Update one profile's plugins ─────────────────────────────────────────────

interface PluginUpdatesModalProps {
  open: boolean
  dshId: string
  profile: string
  onClose: () => void
  /** Called after a successful apply, with the updated plugin names. */
  onDone: (updated: string[]) => void | Promise<void>
}

/** Per-profile plugin update: checks the plugins this profile uses and updates
 * all of them that have a newer npm release. Refused by the core while running. */
export function PluginUpdatesModal(p: PluginUpdatesModalProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [loading, setLoading] = useState(false)
  const [items, setItems] = useState<{ name: string; current?: string; latest: string }[]>([])
  const [manual, setManual] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<PluginApplyResult[] | null>(null)
  const [github, setGithub] = useState<GithubAuthState>()

  useEffect(() => {
    if (!p.open) return
    setResults(null); setItems([]); setManual([]); setLoading(true)
    void (async () => {
      const [ov, up, ga] = await Promise.all([
        window.api.plugins.overview(),
        window.api.plugins.checkUpdates(),
        window.api.settings.getGithubAuth(),
      ])
      setLoading(false)
      if (ga.ok) setGithub(ga.value)
      if (!ov.ok || !up.ok) { if (!up.ok) void message.error(apiErrorText(up)); return }
      const byName = new Map(up.value.map(u => [u.name, u]))
      const next: { name: string; current?: string; latest: string }[] = []
      const man: string[] = []
      for (const row of ov.value) {
        const usage = row.usage.find(u => u.profile === p.profile)
        if (usage === undefined) continue
        const info = byName.get(row.name)
        if (info === undefined) continue
        if (info.updateAvailable && info.latest !== undefined) {
          next.push({ name: row.name, ...(usage.version !== undefined ? { current: usage.version } : {}), latest: info.latest })
        } else if (info.manual) {
          man.push(row.name)
        }
      }
      setItems(next)
      setManual(man)
    })()
  }, [p.open, p.dshId, p.profile])

  const apply = async (): Promise<void> => {
    if (items.length === 0) return
    setBusy(true)
    const r = await window.api.plugins.applyUpdates(p.dshId, p.profile, items.map(i => ({ name: i.name, version: i.latest })))
    setBusy(false)
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    setResults(r.value.results)
    const okNames = r.value.results.filter(x => x.ok).map(x => x.name)
    if (okNames.length > 0) void message.success(t('plugin.update.applied', { count: okNames.length }))
    await p.onDone(okNames)
  }

  const footer = busy
    ? <Space><Button loading>{t('plugin.update.applying')}</Button></Space>
    : results !== null
      ? <Button type="primary" onClick={p.onClose}>{t('common.close')}</Button>
      : items.length > 0
        ? (
          <Space>
            <Button onClick={p.onClose} disabled={busy}>{t('common.cancel')}</Button>
            <Button type="primary" loading={busy} onClick={() => void apply()}>{t('plugin.update.applyAll', { count: items.length })}</Button>
          </Space>
        )
        : <Button onClick={p.onClose}>{t('common.close')}</Button>

  return (
    <Modal title={t('plugin.update.title', { profile: p.profile })} open={p.open}
      onCancel={busy ? undefined : p.onClose} closable={!busy} mask={{ closable: !busy }}
      width={MODAL.wide} footer={footer}>
      <Space orientation="vertical" style={{ width: '100%' }} size="small">
        {loading && <div><Spin size="small" /> {t('plugin.update.checking')}</div>}

        {!loading && results === null && items.length === 0 && (
          <div style={{ color: token.colorTextSecondary }}>{t('plugin.update.none')}</div>
        )}

        {!loading && results === null && items.map(item => (
          <div key={item.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: `1px solid ${token.colorSplit}` }}>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>{item.name}</span>
            {item.current !== undefined && <Tag>{item.current}</Tag>}
            <span style={{ color: token.colorTextTertiary }}>→</span>
            <Tag color="gold">{item.latest}</Tag>
          </div>
        ))}

        {results !== null && results.map(r => (
          <div key={r.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: `1px solid ${token.colorSplit}` }}>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>{r.name}@{r.version}</span>
            {r.ok ? <Tag color="success">{t('plugin.update.ok')}</Tag> : <Tag color="error">{r.text}</Tag>}
          </div>
        ))}

        {manual.length > 0 && (
          <Alert type="info" showIcon title={t('plugin.update.manualHint', { names: manual.join(t('common.listSep')) })} />
        )}

        {github?.rateLimited === true && (
          <Alert type="warning" showIcon title={t('plugin.update.githubRateLimited')} />
        )}
        {github?.rateLimited !== true && github?.authenticated === false && manual.length > 0 && (
          <Alert type="info" showIcon title={t('plugin.update.githubHint')} />
        )}
      </Space>
    </Modal>
  )
}