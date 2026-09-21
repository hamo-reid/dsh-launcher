import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Menu, Modal, theme, message,
} from 'antd'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../lib/ipc.ts'
import AppShell from '../components/AppShell.tsx'
import Panel from '../components/Panel.tsx'
import Toolbar from '../components/Toolbar.tsx'
import SectionHeading from '../components/SectionHeading.tsx'
import { DownloadVersionModal, PluginDetailModal, InstallToProfileModal, UpdatePluginModal, type UpdatePluginTarget } from './PluginsModals.tsx'
import { toStoreMap } from '../lib/storeMap.ts'
import MarketSection from './MarketSection.tsx'
import DevPluginsView from './plugins/DevPluginsView.tsx'
import PluginsDownloadView from './plugins/PluginsDownloadView.tsx'
import PluginsInstallView from './plugins/PluginsInstallView.tsx'
import PluginsOverviewView from './plugins/PluginsOverviewView.tsx'
import type { InstalledOverviewRow, MarketAnnotations, PluginUpdateInfo } from '../../../shared/types.ts'

type PluginView = 'overview' | 'download' | 'install' | 'market' | 'dev'

/** 插件管理页：总览、下载中心、安装；详情 / 安装到 profile / 下载版本弹窗在 `PluginsModals`。
 * 下载中心：实时搜索（防抖）+ 分页加载更多 + 在库标记 + 可选版本下载。 */
export default function PluginsSection() {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [view, setView] = useState<PluginView>('overview')

  const [dir, setDir] = useState('')
  const [dirMissing, setDirMissing] = useState(false)

  // Installed-plugin overview. (The filters, sorting and paging live in the
  // overview view; the data and every write stay here.)
  const [overview, setOverview] = useState<InstalledOverviewRow[]>([])
  const [target, setTarget] = useState<InstalledOverviewRow | null>(null)
  const [overviewLoading, setOverviewLoading] = useState(false)
  // On-disk sizes, filled only when the user triggers the manual "calculate sizes".
  const [sizeMap, setSizeMap] = useState<Record<string, number>>({})
  const [sizeLoading, setSizeLoading] = useState(false)
  // Store plugin names whose node_modules dir is missing on disk (stale).
  const [staleStoreNames, setStaleStoreNames] = useState<Set<string>>(new Set())
  // Catalog annotations (category / deprecation) for the overview cards.
  const [annotations, setAnnotations] = useState<MarketAnnotations | null>(null)

  // Dev plugins live in their own registry + section; the overview hides them by
  // default so "real" plugins stay a clean list.
  const [devNames, setDevNames] = useState<Set<string>>(new Set())

  // Update detection (manual; main-process cached).
  const [updates, setUpdates] = useState<Map<string, PluginUpdateInfo>>(new Map())
  const [updatesChecking, setUpdatesChecking] = useState(false)

  const [storeMap, setStoreMap] = useState<Map<string, string[]>>(new Map())
  const [dlPkg, setDlPkg] = useState<string | null>(null)
  // The update dialog (pick a version + the profiles to re-point).
  const [updatePkg, setUpdatePkg] = useState<UpdatePluginTarget | null>(null)

  const [busy, setBusy] = useState(false)

  // "Install into a profile" dialog.
  const [installPkg, setInstallPkg] = useState<string | null>(null)

  const menuItems = [
    { key: 'overview' as const, label: t('plugin.view.overview') },
    { key: 'market' as const, label: t('plugin.view.market') },
    { key: 'download' as const, label: t('plugin.view.download') },
    { key: 'install' as const, label: t('plugin.view.install') },
    { key: 'dev' as const, label: t('plugin.view.dev') },
  ]

  const load = async (): Promise<InstalledOverviewRow[] | undefined> => {
    setOverviewLoading(true)
    const r = await window.api.plugins.overview()
    setOverviewLoading(false)
    let rows: InstalledOverviewRow[] | undefined
    if (r.ok) { setOverview(r.value); rows = r.value }
    else void message.error(apiErrorText(r))
    // Which store plugins have a missing node_modules dir (for stale marking).
    const h = await window.api.settings.checkHealth()
    if (h.ok) setStaleStoreNames(new Set(h.value.filter(x => x.kind === 'plugin-missing').map(x => x.label)))
    return rows
  }

  const refreshStoreNames = useCallback(async (): Promise<void> => {
    const r = await window.api.plugins.list()
    if (r.ok) setStoreMap(toStoreMap(r.value))
  }, [])

  // The registered dev-plugin names, so the overview can exclude them.
  const refreshDevNames = useCallback(async (): Promise<void> => {
    const d = await window.api.plugins.devList()
    if (d.ok) setDevNames(new Set(d.value.plugins.map(p => p.name)))
  }, [])

  // When any download session settles, refresh the in-store tags (a finished
  // download flips the plugin to "in store" without needing a manual reload).
  useEffect(() => window.api.downloads.onChange(() => { void refreshStoreNames() }), [refreshStoreNames])

  useEffect(() => {
    void (async () => {
      const d = await window.api.plugins.getDir()
      if (d.ok) { setDir(d.value.dir); setDirMissing(d.value.dir === '') }
      await Promise.all([load(), refreshStoreNames(), refreshDevNames()])
    })()
  }, [refreshStoreNames, refreshDevNames])

  // Catalog annotations (category / deprecation) for the overview — non-blocking;
  // degrades to none when the market is unreachable.
  useEffect(() => {
    void window.api.market.annotations().then(r => { if (r.ok) setAnnotations(r.value) })
  }, [])

  // 从市场 / 下载中心 / 安装切回「总览」时重载一次，让刚下载/安装的插件立即可
  // 见 —— view 切换不重挂载本组件，否则总览会一直持有旧的挂载时数据。
  const prevView = useRef<PluginView>(view)
  useEffect(() => {
    if (view === 'overview' && prevView.current !== 'overview') { void load(); void refreshDevNames() }
    prevView.current = view
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view])

  const uninstall = async (name: string): Promise<void> => {
    setBusy(true)
    // Cascade full uninstall: detach the plugin from every using profile, then
    // remove the whole plugin from the store (frees the archive on Windows).
    const res = await window.api.plugins.uninstall(name)
    setBusy(false)
    if (!res.ok) { void message.error(apiErrorText(res)); setTarget(null); return }
    const detached = res.value.removed.length
    setTarget(null)
    void message.success(detached > 0
      ? t('plugin.uninstalledCascade', { name, count: detached })
      : t('plugin.uninstalled', { name }))
    await Promise.all([load(), refreshStoreNames()])
  }

  // Remove a SINGLE archived version from the store. Keeps the detail modal open
  // so the user can keep managing the remaining versions — the target is re-synced
  // to the fresh overview (and closed if this was the plugin's last version).
  const uninstallVersion = async (name: string, version: string): Promise<void> => {
    setBusy(true)
    const res = await window.api.plugins.remove(name, version)
    setBusy(false)
    if (!res.ok) { void message.error(apiErrorText(res)); return }
    void message.success(t('plugin.version.uninstalled', { name, version }))
    const rows = await load()
    const fresh = rows?.find(x => x.name === name)
    setTarget(fresh !== undefined ? fresh : null)
    await refreshStoreNames()
  }

  // Remove a stale store plugin (its dir is missing on disk): confirm, then the
  // existing remove flow drops it from the store manifest (safe without files).
  const deleteStale = (name: string): void => {
    Modal.confirm({
      title: t('plugin.removeStaleConfirmTitle'),
      content: t('plugin.removeStaleConfirm', { name }),
      okText: t('common.confirm'),
      okButtonProps: { danger: true },
      onOk: async () => {
        setBusy(true)
        const res = await window.api.plugins.remove(name)
        setBusy(false)
        if (!res.ok) void message.error(apiErrorText(res))
        else { void message.success(t('plugin.uninstalled', { name })); await Promise.all([load(), refreshStoreNames()]) }
      },
    })
  }

  const revealDir = async (name: string): Promise<void> => {
    if (name === '') return
    const r = await window.api.plugins.reveal(name)
    if (!r.ok) void message.error(apiErrorText(r))
  }

  // Remove the plugin's unused archived versions (keep newest + in-use).
  const cleanupVersions = async (name: string): Promise<void> => {
    setBusy(true)
    const r = await window.api.plugins.cleanupVersions(name)
    setBusy(false)
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(r.value.removed.length > 0
      ? t('plugin.cleanup.done', { count: r.value.removed.length })
      : t('plugin.cleanup.none'))
    const rows = await load()
    setTarget(rows?.find(x => x.name === name) ?? null)
    await refreshStoreNames()
  }

  // Migrate a deprecated plugin to its catalog replacement across using profiles.
  const migrateReplacement = async (name: string, replacement: string): Promise<void> => {
    setBusy(true)
    const r = await window.api.plugins.migrateReplacement(name, replacement)
    setBusy(false)
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('plugin.migrate.done', { target: r.value.target, count: r.value.installed }))
    setTarget(null)
    await Promise.all([load(), refreshStoreNames()])
  }

  // Sizes are an explicit user action (walking each archived node_modules is costly),
  // so they are NOT recomputed on every overview load.
  const calcSizes = async (): Promise<void> => {
    setSizeLoading(true)
    const r = await window.api.plugins.calcSizes()
    setSizeLoading(false)
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    setSizeMap(r.value)
  }

  // Manual update check; the main process memoizes results for a short TTL.
  const checkUpdates = async (refresh: boolean): Promise<void> => {
    setUpdatesChecking(true)
    const r = await window.api.plugins.checkUpdates(refresh ? { refresh: true } : undefined)
    setUpdatesChecking(false)
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    setUpdates(new Map(r.value.map(u => [u.name, u])))
  }

  // Download a specific version into the store (the picker fetches the list).
  const openDownloadVersion = (name: string): void => { setTarget(null); setDlPkg(name) }

  // Update to a chosen version and (optionally) re-point the profiles using it.
  const openUpdate = (row: InstalledOverviewRow): void => {
    const latest = updates.get(row.name)?.latest
    setTarget(null)
    setUpdatePkg({
      name: row.name,
      ...(latest !== undefined ? { latest } : {}),
      usage: row.usage.map(u => ({ dsh: u.dsh, profile: u.profile, ...(u.version !== undefined ? { version: u.version } : {}) })),
    })
  }


  return (
    <>
    <AppShell
      siderWidth={200}
      sider={
        <Menu
          selectedKeys={[view]}
          items={menuItems}
          onClick={({ key }) => setView(key as PluginView)}
          style={{ borderInlineEnd: 0, paddingTop: 8 }}
        />
      }
    >
      {view === 'overview' && (
        <PluginsOverviewView
          overview={overview}
          overviewLoading={overviewLoading}
          sizeMap={sizeMap}
          sizeLoading={sizeLoading}
          staleStoreNames={staleStoreNames}
          updates={updates}
          updatesChecking={updatesChecking}
          annotations={annotations}
          devNames={devNames}
          dirMissing={dirMissing}
          onCalcSizes={() => void calcSizes()}
          onCheckUpdates={() => void checkUpdates(false)}
          onOpen={setTarget}
          onInstallToProfile={name => { setTarget(null); setInstallPkg(name) }}
          onDownloadVersion={openDownloadVersion}
          onUpdate={openUpdate}
          onUninstall={name => void uninstall(name)}
          onReveal={name => void revealDir(name)}
          onDeleteStale={deleteStale}
        />
      )}
      {view === 'market' && <MarketSection />}

      {view === 'dev' && <DevPluginsView />}

      {view === 'download' && (
        <PluginsDownloadView
          dirMissing={dirMissing}
          storeMap={storeMap}
          onDownloadVersion={openDownloadVersion}
          onInstallToProfile={name => { setTarget(null); setInstallPkg(name) }}
        />
      )}
      {view === 'install' && (
        <PluginsInstallView
          dir={dir}
          dirMissing={dirMissing}
          onInstalled={async () => { await Promise.all([load(), refreshStoreNames()]) }}
        />
      )}
    </AppShell>

    <PluginDetailModal
      target={target}
      busy={busy}
      update={target !== null ? updates.get(target.name) : undefined}
      storeVersions={target !== null ? storeMap.get(target.name) ?? [] : []}
      sizeBytes={target !== null ? sizeMap[target.name] : undefined}
      onClose={() => setTarget(null)}
      onDownloadVersion={openDownloadVersion}
      onUpdate={name => { const row = overview.find(x => x.name === name); if (row !== undefined) openUpdate(row) }}
      onUninstall={name => void uninstall(name)}
      onUninstallVersion={(name, version) => void uninstallVersion(name, version)}
      onReveal={name => void revealDir(name)}
      onInstallToProfile={name => { setTarget(null); setInstallPkg(name) }}
      onCleanupVersions={name => void cleanupVersions(name)}
      replacement={target !== null ? annotations?.plugins[target.name]?.replacement : undefined}
      onMigrate={(name, replacement) => void migrateReplacement(name, replacement)}
    />
    <InstallToProfileModal
      installPkg={installPkg}
      versions={installPkg !== null ? storeMap.get(installPkg) ?? [] : []}
      onClose={() => setInstallPkg(null)}
      onDone={async () => { await Promise.all([load(), refreshStoreNames()]) }}
    />
    <UpdatePluginModal
      target={updatePkg}
      onClose={() => setUpdatePkg(null)}
      onDone={async () => { await Promise.all([load(), refreshStoreNames()]) }}
    />
    <DownloadVersionModal
      pkg={dlPkg}
      onClose={() => setDlPkg(null)}
      onInstalled={async () => { await Promise.all([load(), refreshStoreNames()]) }}
    />
    </>
  )
}