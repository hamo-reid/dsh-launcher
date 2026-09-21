/**
 * Dev plugins: local source dirs linked (`link:`) into profiles, kept in their
 * own registry and managed separately from the plugin store — never update
 * checked, version-managed or removed with it, and never deleted from disk.
 *
 * Resolution is shown per package: the entry build output, the patch rows dsh
 * actually loads, and the `@deepseek-ai/*` peers a `link:` must resolve from the
 * dev package itself. Each problem has an explicit fix (install / shim / build /
 * relink), so a pnpm monorepo package can be made runnable without guessing.
 */
import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Dropdown, Empty, Input, Modal, Radio, Select, Space, Spin, Tag, Tooltip, Typography, theme, message } from 'antd'
import type { MenuProps } from 'antd'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../lib/ipc.ts'
import { fmtDateTime } from '../lib/format.ts'
import ConfirmMenu, { type MenuAction } from '../components/ConfirmMenu.tsx'
import FieldLabel from '../components/FieldLabel.tsx'
import Panel from '../components/Panel.tsx'
import ScrollModal from '../components/ScrollModal.tsx'
import SectionHeading from '../components/SectionHeading.tsx'
import { MODAL } from '../theme.ts'
import type {
  DevBuildScope, DevBuildTarget, DevDiagnosis, DevDiagnosisMeta, DevLinkMode, DevPlugin, DevResolveRoot, DevResolveState,
  DevRunResult, DevScriptOptions, IpcResult, PluginUsagePoint,
} from '../../../shared/types.ts'

/** A run result shown in the output modal (build / install). */
interface RunOutput { name: string; ok: boolean; text: string; command: string; cwd: string }

/** One selectable compare host: an installed dsh plus its profiles. */
interface HostOption { id: string; name: string; version?: string; profiles: string[] }

/** The compare TARGET: which dsh, and optionally which of its profiles. It is what
 * the list's badges were computed against and what a new dialog starts from, and it
 * survives a reload (renderer-local view preference, like the overview's filters).
 * A stale dsh falls back to the first registered one, a stale profile to "none". */
interface DevTarget { dshId?: string; profile?: string }

const TARGET_KEY = 'pm.dev.target'
function readSavedTarget(): DevTarget {
  try {
    const raw = localStorage.getItem(TARGET_KEY)
    if (raw === null) return {}
    const parsed = JSON.parse(raw) as { dshId?: unknown; profile?: unknown } | null
    if (parsed === null || typeof parsed !== 'object') return {}
    return {
      ...(typeof parsed.dshId === 'string' && parsed.dshId !== '' ? { dshId: parsed.dshId } : {}),
      ...(typeof parsed.profile === 'string' && parsed.profile !== '' ? { profile: parsed.profile } : {}),
    }
  } catch {
    return {}
  }
}

function saveTarget(target: DevTarget): void {
  try { localStorage.setItem(TARGET_KEY, JSON.stringify(target)) } catch { /* storage unavailable */ }
}

/** Whether two targets mean the same chain (absent profile = host layers only). */
function sameTarget(a: DevTarget, b: DevTarget): boolean {
  return (a.dshId ?? '') === (b.dshId ?? '') && (a.profile ?? '') === (b.profile ?? '')
}

/** `dsh@1.2.0` when the name already carries the version, else `name (version)`. */
function hostLabel(host: HostOption | undefined, fallback?: string): string {
  if (host === undefined) return fallback ?? '—'
  return host.version !== undefined && host.version !== '' && !host.name.includes(host.version)
    ? `${host.name} (${host.version})`
    : host.name
}

export default function DevPluginsView(): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [plugins, setPlugins] = useState<DevPlugin[]>([])
  const [usage, setUsage] = useState<Record<string, PluginUsagePoint[]>>({})
  const [diags, setDiags] = useState<Record<string, DevDiagnosis>>({})
  // Build scripts per plugin (its own + its workspace root's), for the picker.
  const [buildTargets, setBuildTargets] = useState<Record<string, { options: DevScriptOptions; current?: DevBuildTarget }>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  // The report an open dialog is showing. Its `meta` carries the chain it was
  // computed for, so a cached verdict never reads as a fresh one elsewhere.
  const [detail, setDetail] = useState<{ name: string; diag: DevDiagnosis } | null>(null)
  const [linkPkg, setLinkPkg] = useState<DevPlugin | null>(null)
  const [output, setOutput] = useState<RunOutput | null>(null)

  // The target every diagnosis compares against. Patch rows and peers resolve
  // through THAT chain, so with several dsh versions installed the source has to be
  // explicit — it used to be silently the first registered dsh.
  const [hosts, setHosts] = useState<HostOption[]>([])
  const [target, setTarget] = useState<DevTarget>({})
  /** The provenance of the badge set on screen (the last run's report). */
  const [listMeta, setListMeta] = useState<DevDiagnosisMeta>()

  // Linking needs a dsh + one of its profiles (reuse the install picker's data).
  const [scopes, setScopes] = useState<{ id: string; name: string; profiles: string[] }[]>([])
  const [linkDsh, setLinkDsh] = useState<string>()
  const [linkProfile, setLinkProfile] = useState<string>()
  const [linkMode, setLinkMode] = useState<DevLinkMode>('link')
  const [linking, setLinking] = useState(false)

  // The host list, resolved once; the remembered target is restored when its dsh is
  // still installed (and its profile still exists).
  useEffect(() => {
    void (async () => {
      const r = await window.api.plugins.installOptions()
      if (!r.ok) return
      setHosts(r.value)
      const saved = readSavedTarget()
      const host = r.value.find(h => h.id === saved.dshId) ?? r.value[0]
      setTarget(prev => {
        if (!sameTarget(prev, {})) return prev
        if (host === undefined) return {}
        const profile = saved.profile !== undefined && host.profiles.includes(saved.profile) ? saved.profile : undefined
        return { dshId: host.id, ...(profile !== undefined ? { profile } : {}) }
      })
    })()
  }, [])

  /** Change the target (and remember it): every verdict on screen depends on it. */
  const retarget = (next: DevTarget): void => {
    setTarget(next)
    saveTarget(next)
  }

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    const r = await window.api.plugins.devList()
    if (!r.ok) { setLoading(false); void message.error(apiErrorText(r)); return }
    setPlugins(r.value.plugins)
    setUsage(r.value.usage)
    // Diagnosis + build scripts are filesystem-only (no network), so run both for
    // every package to show a status badge and an actionable build menu up front.
    // The diagnosis is cached in the main process, so this is a map hit unless the
    // target or a layer file changed.
    const diagNext: Record<string, DevDiagnosis> = {}
    const scriptNext: Record<string, { options: DevScriptOptions; current?: DevBuildTarget }> = {}
    await Promise.all(r.value.plugins.map(async p => {
      const [d, s] = await Promise.all([
        window.api.plugins.devDiagnose(p.name, target),
        window.api.plugins.devScripts(p.name),
      ])
      if (d.ok) diagNext[p.name] = d.value
      if (s.ok) scriptNext[p.name] = s.value
    }))
    setDiags(diagNext)
    setBuildTargets(scriptNext)
    setListMeta(Object.values(diagNext)[0]?.meta)
    setLoading(false)
  }, [target.dshId, target.profile])

  useEffect(() => { void load() }, [load])

  const add = async (): Promise<void> => {
    const r = await window.api.plugins.devAdd()
    if (!r.ok) { if (r.code !== 'common.cancelled') void message.error(apiErrorText(r)); return }
    void message.success(t('plugin.dev.added', { name: r.value.name }))
    await load()
  }

  const diagnose = async (name: string, at: DevTarget = target, refresh = false): Promise<void> => {
    setBusy(`diag:${name}`)
    const r = await window.api.plugins.devDiagnose(name, { ...at, refresh })
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    setDetail({ name, diag: r.value })
    setDiags(prev => ({ ...prev, [name]: r.value }))
    setListMeta(r.value.meta)
  }

  // Changing the target invalidates the open dialog's verdicts; recompute them
  // against the new one instead of leaving a report for a chain no longer shown.
  useEffect(() => {
    if (detail === null) return
    const was: DevTarget = { dshId: detail.diag.meta.dshId, profile: detail.diag.meta.profile }
    if (sameTarget(was, target)) return
    void diagnose(detail.name, target)
  }, [target, detail])

  const runAction = async (
    name: string, key: string, fn: () => Promise<IpcResult<DevRunResult>>,
  ): Promise<void> => {
    setBusy(`${key}:${name}`)
    const r = await fn()
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    if (r.value.ok) void message.success(t('plugin.dev.actionDone', { name }))
    setOutput({ name, ok: r.value.ok, text: r.value.text, command: r.value.command, cwd: r.value.cwd })
  }

  /** Run the remembered/default build target, or one picked from the menu. */
  const runBuild = async (name: string, target?: DevBuildTarget): Promise<void> => {
    if (target === undefined && buildTargets[name]?.current === undefined) {
      void message.warning(t('plugin.dev.noScripts'))
      return
    }
    await runAction(name, 'build', () => window.api.plugins.devBuild(name, target))
  }

  /** Build menu: the package's scripts and its workspace root's, grouped. */
  const buildMenuItems = (name: string): MenuProps['items'] => {
    const info = buildTargets[name]
    if (info === undefined) return []
    const group = (
      label: string, scope: DevBuildScope, scripts: string[],
    ): NonNullable<MenuProps['items']>[number] | null =>
      scripts.length === 0 ? null : { type: 'group', label, children: scripts.map(s => ({ key: `${scope}:${s}`, label: s })) }
    return [
      group(t('plugin.dev.buildScopePackage'), 'package', info.options.package),
      group(t('plugin.dev.buildScopeWorkspace'), 'workspace', info.options.workspace),
    ].filter((g): g is NonNullable<MenuProps['items']>[number] => g !== null)
  }

  const parseBuildKey = (key: string): DevBuildTarget => {
    const at = key.indexOf(':')
    return { script: key.slice(at + 1), scope: key.slice(0, at) === 'workspace' ? 'workspace' : 'package' }
  }

  const shim = async (name: string, at: DevTarget = target): Promise<void> => {
    setBusy(`shim:${name}`)
    // Shim from the chain the dialog SHOWED, never from whatever the selector says
    // by the time the click lands.
    const r = await window.api.plugins.devShimPeers(name, at)
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    if (r.value.added.length === 0) void message.warning(t('plugin.dev.shimNone'))
    else void message.success(t('plugin.dev.shimDone', { count: r.value.added.length }))
    await diagnose(name, at, true)
    await load()
  }

  const unshim = async (name: string): Promise<void> => {
    setBusy(`unshim:${name}`)
    const r = await window.api.plugins.devUnshimPeers(name)
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('plugin.dev.unshimDone', { count: r.value.removed.length }))
    await diagnose(name)
    await load()
  }

  const snapshot = async (name: string): Promise<void> => {
    setBusy(`snap:${name}`)
    const r = await window.api.plugins.devSnapshot(name)
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('plugin.dev.snapshotDone', { name }))
  }

  const unregister = async (name: string): Promise<void> => {
    const r = await window.api.plugins.devRemove(name)
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('plugin.dev.unregistered', { name }))
    await load()
  }

  const openLink = async (p: DevPlugin): Promise<void> => {
    setLinkPkg(p)
    setLinkMode('link')
    setLinkProfile(undefined)
    const r = await window.api.plugins.installOptions()
    if (r.ok) {
      setScopes(r.value)
      setLinkDsh(prev => (prev !== undefined && r.value.some(s => s.id === prev)) ? prev : r.value[0]?.id)
    }
  }

  const doLink = async (): Promise<void> => {
    if (linkPkg === null || linkDsh === undefined || linkProfile === undefined) return
    setLinking(true)
    const r = await window.api.plugins.devLinkToProfile(linkDsh, linkProfile, linkPkg.name, linkMode)
    setLinking(false)
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(r.value)
    setLinkPkg(null)
    await load()
  }

  const status = (name: string): { color: string; label: string } | null => {
    const d = diags[name]
    if (d === undefined) return null
    if (d.entryMissing) return { color: 'error', label: t('plugin.dev.status.noEntry') }
    const issues = d.missingPatchRows.length + d.missingPeers.length
    return issues > 0
      ? { color: 'warning', label: t('plugin.dev.status.issues', { count: issues }) }
      : { color: 'success', label: t('plugin.dev.status.ok') }
  }

  const rowActions = (p: DevPlugin): MenuAction[] => [
    { key: 'reveal', label: t('plugin.dev.reveal') },
    ...(p.workspaceRoot !== undefined ? [{ key: 'reveal-ws', label: t('plugin.dev.revealWorkspace') } as MenuAction] : []),
    { key: 'snapshot', label: t('plugin.dev.snapshot'), confirmText: t('plugin.dev.snapshotConfirm', { name: p.name }) },
    { key: 'remove', label: t('plugin.dev.unregister'), danger: true, confirmText: t('plugin.dev.unregisterConfirm', { name: p.name }) },
  ]

  const onRowAction = (p: DevPlugin, key: string): void => {
    if (key === 'reveal') void window.api.plugins.devReveal(p.name)
    else if (key === 'reveal-ws') void window.api.plugins.devRevealWorkspace(p.name)
    else if (key === 'snapshot') void snapshot(p.name)
    else if (key === 'remove') void unregister(p.name)
  }

  const linkedProfiles = (name: string): string[] => (usage[name] ?? []).map(u => u.profile)

  /** Where a resolved reference came from (monorepo vs host-provided). */
  const rootLabel = (root: DevResolveRoot | undefined): string => t(`plugin.dev.root.${root ?? 'monorepo'}`)

  /** How one resolved reference reads. "Missing" (nothing has it) and "dangling"
   * (the directory entry is there but its link target is gone) are different
   * problems with different fixes, so they never share a tag. */
  const resolveTag = (
    hit: { dir?: string; root?: DevResolveRoot; state?: DevResolveState; link?: string },
    peer = false,
  ): JSX.Element => {
    if (hit.dir === undefined || hit.state === undefined) {
      return <Tag color="error">{t('plugin.dev.diagMissing')}</Tag>
    }
    if (hit.state === 'dangling') {
      return (
        <Tooltip title={hit.link !== undefined ? t('plugin.dev.diagDanglingHint', { target: hit.link }) : hit.dir}>
          <Tag color="warning">{t('plugin.dev.diagDangling')}</Tag>
        </Tooltip>
      )
    }
    return <Tag color={hit.root === 'monorepo' ? 'geekblue' : peer ? 'orange' : 'success'}>{rootLabel(hit.root)}</Tag>
  }

  /** What a report was computed against, and when — the chain a verdict belongs to
   * is not visible from the verdict itself, so it is always shown with it. */
  const scopeText = (meta: DevDiagnosisMeta | undefined): string => {
    if (meta === undefined) return ''
    const host = hostLabel(hosts.find(h => h.id === meta.dshId), meta.dshName)
    const at = fmtDateTime(meta.at)
    return meta.profile !== undefined && meta.profile !== ''
      ? t('plugin.dev.detectedAt', { time: at, host, profile: meta.profile })
      : t('plugin.dev.detectedAtHost', { time: at, host })
  }

  const profileOptions = (hostId: string | undefined): { value: string; label: string }[] => {
    const host = hosts.find(h => h.id === hostId)
    return [
      { value: '', label: t('plugin.dev.profileNone') },
      ...(host?.profiles ?? []).map(p => ({ value: p, label: p })),
    ]
  }

  return (
    <>
      <Space orientation="vertical" style={{ width: '100%' }} size="middle">
        <SectionHeading
          title={t('plugin.dev.title')}
          description={t('plugin.dev.desc')}
          extra={<Button type="primary" onClick={() => void add()}>{t('plugin.dev.add')}</Button>}
        />
        <Alert type="info" showIcon title={t('plugin.dev.hint')} />
        {/* The badges below belong to the last run — say which chain that was. */}
        {listMeta !== undefined && (
          <div style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM }}>
            <Tooltip title={t('plugin.dev.detectedHint')}>{scopeText(listMeta)}</Tooltip>
          </div>
        )}
        <Panel pad={false}>
          {loading ? (
            <div style={{ padding: token.padding, textAlign: 'center' }}><Spin /></div>
          ) : plugins.length === 0 ? (
            <div style={{ padding: token.padding }}>
              <Empty description={t('plugin.dev.emptyDesc')} />
            </div>
          ) : (
            <div>
              {plugins.map(p => {
                const st = status(p.name)
                const used = linkedProfiles(p.name)
                return (
                  <div
                    key={p.name}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: `1px solid ${token.colorSplit}` }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 600 }}>{p.name}</span>
                        {p.version !== undefined && <Tag style={{ fontFamily: 'monospace' }}>@{p.version}</Tag>}
                        <Tag color={p.bundle ? 'geekblue' : 'default'}>
                          {t(p.bundle ? 'plugin.dev.bundle' : 'plugin.dev.dependency')}
                        </Tag>
                        {st !== null && <Tag color={st.color}>{st.label}</Tag>}
                      </div>
                      <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, marginTop: 2, wordBreak: 'break-all' }}>
                        <Tooltip title={p.dir}>{t('plugin.dev.dir')}: {p.dir}</Tooltip>
                        {p.workspaceRoot !== undefined && <span> · {t('plugin.dev.workspace')}: {p.workspaceRoot}</span>}
                        <span> · {used.length > 0 ? t('plugin.dev.usedBy', { profiles: used.join(t('common.listSep')) }) : t('plugin.dev.unused')}</span>
                      </div>
                    </div>
                    <Space size={4} wrap style={{ flexShrink: 0 }}>
                      <Button size="small" loading={busy === `diag:${p.name}`} onClick={() => void diagnose(p.name)}>{t('plugin.dev.diagnose')}</Button>
                      <Button size="small" type="primary" ghost onClick={() => void openLink(p)}>{t('plugin.dev.linkToProfile')}</Button>
                      <Dropdown.Button
                        size="small"
                        loading={busy === `build:${p.name}`}
                        onClick={() => void runBuild(p.name)}
                        menu={{ items: buildMenuItems(p.name), onClick: ({ key }) => void runBuild(p.name, parseBuildKey(key)) }}
                      >
                        {t('plugin.dev.build')}
                      </Dropdown.Button>
                      <ConfirmMenu actions={rowActions(p)} onAction={key => onRowAction(p, key)} />
                    </Space>
                  </div>
                )
              })}
            </div>
          )}
        </Panel>
      </Space>

      {/* Diagnosis: the patch rows dsh loads, then the peers a link must resolve.
          A monorepo plugin can carry dozens of each, so the body scrolls INSIDE
          the dialog — otherwise the list grows past the viewport and the action
          row at the bottom (install / shim / build) becomes unreachable. */}
      <ScrollModal
        title={t('plugin.dev.diagTitle', { name: detail?.name ?? '' })}
        open={detail !== null}
        onCancel={() => setDetail(null)}
        footer={<Button onClick={() => setDetail(null)}>{t('common.close')}</Button>}
        width={MODAL.wide}
        bodyMax="lg"
      >
        {detail !== null && (
          <Space orientation="vertical" size="small" style={{ width: '100%' }}>
            {/* The target lives HERE, not in the section header: the report below
                only means anything together with the chain it was computed for. */}
            <Space size={8} wrap>
              <Tooltip title={t('plugin.dev.hostHint')}>
                <span style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>
                  {t('plugin.dev.hostSource')}
                </span>
              </Tooltip>
              <Select
                size="small"
                style={{ minWidth: 180 }}
                value={target.dshId}
                placeholder={t('plugin.dev.hostNone')}
                disabled={hosts.length === 0}
                onChange={value => retarget({ dshId: value })}
                options={hosts.map(h => ({ value: h.id, label: hostLabel(h) }))}
              />
              <Select
                size="small"
                style={{ minWidth: 140 }}
                value={target.profile ?? ''}
                disabled={target.dshId === undefined}
                onChange={value => retarget({ dshId: target.dshId, ...(value !== '' ? { profile: value } : {}) })}
                options={profileOptions(target.dshId)}
              />
              <Button size="small" loading={busy === `diag:${detail.name}`} onClick={() => void diagnose(detail.name, target, true)}>
                {t('plugin.dev.rediagnose')}
              </Button>
              <span style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM }}>{scopeText(detail.diag.meta)}</span>
            </Space>
            {detail.diag.index.conflicts.length > 0 && (
              <Alert
                type="error"
                showIcon
                title={t('plugin.dev.diagConflicts')}
                description={detail.diag.index.conflicts
                  .map(c => `${c.id} → ${c.names.join(' / ')}（${c.sources.join(', ')}）`).join(' · ')}
              />
            )}
            <div>
              <FieldLabel>{t('plugin.dev.diagEntry')}</FieldLabel>
              {detail.diag.entryMissing
                ? <Tag color="error">{t('plugin.dev.diagEntryMissing')}</Tag>
                : <span style={{ fontFamily: 'monospace', fontSize: token.fontSizeSM }}>{detail.diag.entry ?? '-'}</span>}
            </div>
            <div>
              <FieldLabel>{t('plugin.dev.diagPatchRows')}</FieldLabel>
              {detail.diag.patchRows.length === 0
                ? <span style={{ color: token.colorTextSecondary }}>{t('plugin.dev.diagNoPatch')}</span>
                : detail.diag.patchRows.map(r => (
                  <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0', flexWrap: 'wrap' }}>
                    <Tag style={{ fontFamily: 'monospace' }}>{r.id}</Tag>
                    <span style={{ fontFamily: 'monospace', fontSize: token.fontSizeSM }}>{r.name === '' ? '-' : r.name}</span>
                    {r.nameFrom === 'index' && r.from !== undefined && (
                      <Tooltip title={t('plugin.dev.diagInferredHint')}>
                        <Tag color="blue">{t('plugin.dev.diagInferred', { source: r.from })}</Tag>
                      </Tooltip>
                    )}
                    {r.pkg !== undefined && <Tag>{t('plugin.dev.diagSubpath')}</Tag>}
                    {r.name === '' ? null : resolveTag(r)}
                    {r.profileDir !== undefined && (
                      <Tooltip title={r.profileDir}>
                        <Tag color="cyan">{t('plugin.dev.diagInProfile')}</Tag>
                      </Tooltip>
                    )}
                  </div>
                ))}
            </div>
            <div>
              <FieldLabel>{t('plugin.dev.diagPeers')}</FieldLabel>
              {detail.diag.peers.length === 0
                ? <span style={{ color: token.colorTextSecondary }}>-</span>
                : detail.diag.peers.map(peer => (
                  <div key={peer.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0', flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: 'monospace', fontSize: token.fontSizeSM }}>{peer.name}</span>
                    {resolveTag(peer, true)}
                    {detail.diag.shimmed.includes(peer.name) && <Tag color="gold">{t('plugin.dev.diagShimmed')}</Tag>}
                  </div>
                ))}
            </div>
            <Alert type="info" showIcon title={t('plugin.dev.fixHint')} />
            <Space wrap>
              <Button loading={busy === `install:${detail.name}`} onClick={() => void runAction(detail.name, 'install', () => window.api.plugins.devInstall(detail.name))}>{t('plugin.dev.fixInstall')}</Button>
              <Button loading={busy === `shim:${detail.name}`} onClick={() => void shim(detail.name, { dshId: detail.diag.meta.dshId, profile: detail.diag.meta.profile })}>{t('plugin.dev.fixShim')}</Button>
              {detail.diag.shimmed.length > 0 && (
                <Button loading={busy === `unshim:${detail.name}`} onClick={() => void unshim(detail.name)}>{t('plugin.dev.fixUnshim')}</Button>
              )}
              <Dropdown.Button
                loading={busy === `build:${detail.name}`}
                onClick={() => void runBuild(detail.name)}
                menu={{ items: buildMenuItems(detail.name), onClick: ({ key }) => void runBuild(detail.name, parseBuildKey(key)) }}
              >
                {t('plugin.dev.build')}
              </Dropdown.Button>
            </Space>
          </Space>
        )}
      </ScrollModal>

      {/* Attach to a profile: live link (dev) or a store snapshot (stable). */}
      <Modal
        title={t('plugin.dev.linkTitle', { name: linkPkg?.name ?? '' })}
        open={linkPkg !== null}
        onCancel={() => setLinkPkg(null)}
        onOk={() => void doLink()}
        confirmLoading={linking}
        okButtonProps={{ disabled: linkDsh === undefined || linkProfile === undefined }}
        width={MODAL.narrow}
      >
        <Space orientation="vertical" size="small" style={{ width: '100%' }}>
          <div>
            <FieldLabel>{t('plugin.dev.linkDsh')}</FieldLabel>
            <Select
              style={{ width: '100%' }}
              value={linkDsh}
              onChange={v => { setLinkDsh(v); setLinkProfile(undefined) }}
              options={scopes.map(s => ({ value: s.id, label: s.name }))}
            />
          </div>
          <div>
            <FieldLabel>{t('plugin.dev.linkProfile')}</FieldLabel>
            <Select
              style={{ width: '100%' }}
              value={linkProfile}
              onChange={setLinkProfile}
              disabled={linkDsh === undefined}
              options={(scopes.find(s => s.id === linkDsh)?.profiles ?? []).map(p => ({ value: p, label: p }))}
            />
          </div>
          <div>
            <FieldLabel>{t('plugin.dev.linkMode')}</FieldLabel>
            <Radio.Group value={linkMode} onChange={e => setLinkMode(e.target.value as DevLinkMode)}>
              <Radio.Button value="link">{t('plugin.dev.linkModeLink')}</Radio.Button>
              <Radio.Button value="copy">{t('plugin.dev.linkModeCopy')}</Radio.Button>
            </Radio.Group>
            <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, marginTop: 4 }}>{t('plugin.dev.linkModeHint')}</div>
          </div>
        </Space>
      </Modal>

      {/* pnpm output for a build / install, with the exact invocation shown so
          it can be copied and re-run outside the launcher. */}
      <Modal
        title={t(output?.ok === true ? 'plugin.dev.runOk' : 'plugin.dev.runFailed', { name: output?.name ?? '' })}
        open={output !== null}
        onCancel={() => setOutput(null)}
        footer={<Button onClick={() => setOutput(null)}>{t('common.close')}</Button>}
        width={MODAL.wide}
      >
        <Space orientation="vertical" size="small" style={{ width: '100%' }}>
          <div>
            <FieldLabel>{t('plugin.dev.runCwd')}</FieldLabel>
            <div style={{ fontFamily: 'monospace', fontSize: token.fontSizeSM, wordBreak: 'break-all' }}>{output?.cwd ?? ''}</div>
          </div>
          <div>
            <FieldLabel>{t('plugin.dev.runCommand')}</FieldLabel>
            <Typography.Text
              copyable={{ text: output?.command ?? '' }}
              code
              style={{ fontSize: token.fontSizeSM, wordBreak: 'break-all' }}
            >
              {output?.command ?? ''}
            </Typography.Text>
          </div>
          <Input.TextArea
            readOnly
            value={output?.text ?? ''}
            autoSize={{ minRows: 8, maxRows: 22 }}
            style={{ fontFamily: 'monospace', fontSize: token.fontSizeSM }}
          />
        </Space>
      </Modal>
    </>
  )
}
