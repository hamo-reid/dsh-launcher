/**
 * The dev-plugin page's data and actions — the one source the list, the badges and
 * the open report all read, so an action's reload leaves every part of the page in
 * step instead of each widget fetching for itself.
 *
 * Nothing here renders: the view gets state back and calls in. That is what lets
 * the compare target change in a single place and have the verdicts that were
 * computed against it follow.
 */
import { useCallback, useEffect, useState } from 'react'
import { message } from 'antd'
import type { MenuProps } from 'antd'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../../lib/ipc.ts'
import {
  buildMenuItems as buildMenuItemsFor, readSavedTarget, sameTarget, saveTarget, type DevTarget,
} from '../../lib/devPlugins.ts'
import type {
  DevBuildTarget, DevDiagnosis, DevDiagnosisMeta, DevPlugin, DevRunResult, DevScriptOptions,
  IpcResult, PluginUsagePoint,
} from '../../../../shared/types.ts'

/** One selectable compare host: an installed dsh plus its profiles. */
export interface HostOption { id: string; name: string; version?: string; profiles: string[] }

/** A run result shown in the output modal (build / install). */
export interface RunOutput { name: string; ok: boolean; text: string; command: string; cwd: string }

/** The report an open dialog is showing. Its `meta` carries the chain it was
 * computed for, so a cached verdict never reads as a fresh one elsewhere. */
export interface OpenReport { name: string; diag: DevDiagnosis }

interface DevPluginsApi {
  /** The chain every verdict on screen was computed against. */
  hosts: HostOption[]
  target: DevTarget
  listMeta: DevDiagnosisMeta | undefined
  profileOptions: (hostId: string | undefined) => { value: string; label: string }[]
  retarget: (next: DevTarget) => void

  /** The list and its per-package reports. */
  plugins: DevPlugin[]
  usage: Record<string, PluginUsagePoint[]>
  diags: Record<string, DevDiagnosis>
  loading: boolean
  /** The action currently running, as `${kind}:${name}` — empty when idle. */
  busy: string
  reload: () => Promise<void>

  /** The open report. */
  detail: OpenReport | null
  closeDetail: () => void
  diagnose: (name: string, at?: DevTarget, refresh?: boolean) => Promise<void>

  /** One package's build menu: its own scripts plus its workspace root's. */
  buildMenuItems: (name: string) => MenuProps['items']

  /** Actions. Each reloads what it invalidated. */
  add: () => Promise<void>
  install: (name: string) => Promise<void>
  runBuild: (name: string, at?: DevBuildTarget) => Promise<void>
  shim: (name: string, at?: DevTarget) => Promise<void>
  unshim: (name: string) => Promise<void>
  snapshot: (name: string) => Promise<void>
  unregister: (name: string) => Promise<void>

  /** The last build / install output, shown with the invocation that produced it. */
  output: RunOutput | null
  closeOutput: () => void
}

export function useDevPlugins(): DevPluginsApi {
  const { t } = useTranslation()
  const [plugins, setPlugins] = useState<DevPlugin[]>([])
  const [usage, setUsage] = useState<Record<string, PluginUsagePoint[]>>({})
  const [diags, setDiags] = useState<Record<string, DevDiagnosis>>({})
  // Build scripts per plugin (its own + its workspace root's), for the picker.
  const [buildTargets, setBuildTargets] = useState<Record<string, { options: DevScriptOptions; current?: DevBuildTarget }>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [detail, setDetail] = useState<OpenReport | null>(null)
  const [output, setOutput] = useState<RunOutput | null>(null)

  // The target every diagnosis compares against. Patch rows and peers resolve
  // through THAT chain, so with several dsh versions installed the source has to be
  // explicit — it used to be silently the first registered dsh.
  const [hosts, setHosts] = useState<HostOption[]>([])
  const [target, setTarget] = useState<DevTarget>({})
  /** The provenance of the badge set on screen (the last run's report). */
  const [listMeta, setListMeta] = useState<DevDiagnosisMeta>()

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
  const runBuild = async (name: string, at?: DevBuildTarget): Promise<void> => {
    if (at === undefined && buildTargets[name]?.current === undefined) {
      void message.warning(t('plugin.dev.noScripts'))
      return
    }
    await runAction(name, 'build', () => window.api.plugins.devBuild(name, at))
  }

  /** Build menu: the package's scripts and its workspace root's, grouped. */
  const buildMenuItems = (name: string): MenuProps['items'] =>
    buildMenuItemsFor(buildTargets[name]?.options, {
      package: t('plugin.dev.buildScopePackage'),
      workspace: t('plugin.dev.buildScopeWorkspace'),
    })

  const install = (name: string): Promise<void> =>
    runAction(name, 'install', () => window.api.plugins.devInstall(name))

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

  const profileOptions = (hostId: string | undefined): { value: string; label: string }[] => {
    const host = hosts.find(h => h.id === hostId)
    return [
      { value: '', label: t('plugin.dev.profileNone') },
      ...(host?.profiles ?? []).map(p => ({ value: p, label: p })),
    ]
  }

  return {
    hosts, target, listMeta, profileOptions, retarget,
    plugins, usage, diags, loading, busy, reload: load,
    detail, closeDetail: () => setDetail(null), diagnose, buildMenuItems,
    add, install, runBuild, shim, unshim, snapshot, unregister,
    output, closeOutput: () => setOutput(null),
  }
}
