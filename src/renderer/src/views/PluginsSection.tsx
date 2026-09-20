import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert, Badge, Button, Input, List, Menu, Modal, Pagination, Popover, Segmented, Select, Skeleton, Space, Tag, theme, message,
} from 'antd'
import { ArrowUpOutlined, ArrowDownOutlined, FilterOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../lib/ipc.ts'
import AppShell from '../components/AppShell.tsx'
import EmptyState from '../components/EmptyState.tsx'
import FieldLabel from '../components/FieldLabel.tsx'
import FilterChips from '../components/FilterChips.tsx'
import Panel from '../components/Panel.tsx'
import SearchInput from '../components/SearchInput.tsx'
import Toolbar from '../components/Toolbar.tsx'
import SectionHeading from '../components/SectionHeading.tsx'
import PluginCard from './PluginCard.tsx'
import { loadFilters, saveFilters, type Bucket, type SortKey } from '../lib/pluginFilters.ts'
import { DownloadVersionModal, PluginDetailModal, InstallToProfileModal, toStoreMap } from './PluginsModals.tsx'
import MarketSection from './MarketSection.tsx'
import type { InstalledOverviewRow, MarketAnnotations, NpmSearchHit, PluginKind, PluginOrigin, PluginProvenance, PluginUpdateInfo } from '../../../shared/types.ts'

type PluginView = 'overview' | 'download' | 'install' | 'market'

const PAGE_SIZE = 25
/** Cards per overview page (the grid paginates locally). */
const CARDS_PER_PAGE = 24

function fmtDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString()
}

/** 插件管理页：总览、下载中心、安装；详情 / 安装到 profile / 下载版本弹窗在 `PluginsModals`。
 * 下载中心：实时搜索（防抖）+ 分页加载更多 + 在库标记 + 可选版本下载。 */
export default function PluginsSection() {
  const { t, i18n } = useTranslation()
  const { token } = theme.useToken()
  const lang = i18n.language === 'zh' ? 'zh' : 'en'
  const [view, setView] = useState<PluginView>('overview')

  const [dir, setDir] = useState('')
  const [dirMissing, setDirMissing] = useState(false)
  const [search, setSearch] = useState('') // overview 名称过滤

  // Installed-plugin overview.
  const [overview, setOverview] = useState<InstalledOverviewRow[]>([])
  const [target, setTarget] = useState<InstalledOverviewRow | null>(null)
  const [overviewLoading, setOverviewLoading] = useState(false)
  // On-disk sizes, filled only when the user triggers the manual "calculate sizes".
  const [sizeMap, setSizeMap] = useState<Record<string, number>>({})
  const [sizeLoading, setSizeLoading] = useState(false)
  // Store plugin names whose node_modules dir is missing on disk (stale).
  const [staleStoreNames, setStaleStoreNames] = useState<Set<string>>(new Set())

  // Classification filters — multi-condition (OR within a dimension, AND across),
  // plus the persisted sort. Loaded once from localStorage; saved on every change.
  const [savedFilters] = useState(loadFilters)
  const [bucket, setBucket] = useState<Bucket>(savedFilters.bucket)
  const [origins, setOrigins] = useState<PluginOrigin[]>(savedFilters.origins)
  const [kinds, setKinds] = useState<PluginKind[]>(savedFilters.kinds)
  const [provenances, setProvenances] = useState<PluginProvenance[]>(savedFilters.provenances)
  const [annotations, setAnnotations] = useState<MarketAnnotations | null>(null)
  // Overview card sort + local pagination.
  const [sortKey, setSortKey] = useState<SortKey>(savedFilters.sortKey)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(savedFilters.sortDir)
  const [page, setPage] = useState(1)

  useEffect(() => {
    saveFilters({ bucket, origins, kinds, provenances, sortKey, sortDir })
  }, [bucket, origins, kinds, provenances, sortKey, sortDir])

  // Update detection (manual; main-process cached).
  const [updates, setUpdates] = useState<Map<string, PluginUpdateInfo>>(new Map())
  const [updatesChecking, setUpdatesChecking] = useState(false)

  // Download center.
  const [dq, setDq] = useState('dsh')
  const [hits, setHits] = useState<NpmSearchHit[]>([])
  const [total, setTotal] = useState(0)
  const [searching, setSearching] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [storeMap, setStoreMap] = useState<Map<string, string[]>>(new Map())
  const [dlPkg, setDlPkg] = useState<string | null>(null)
  const fromRef = useRef(0)

  // Install / busy state.
  const [source, setSource] = useState('')
  const [busy, setBusy] = useState(false)
  /** Which install action is running, so only that button spins / the rest disable. */
  const [busyAction, setBusyAction] = useState<null | 'network' | 'folder' | 'zip'>(null)
  const [log, setLog] = useState('')

  // "Install into a profile" dialog.
  const [installPkg, setInstallPkg] = useState<string | null>(null)

  const menuItems = [
    { key: 'overview' as const, label: t('plugin.view.overview') },
    { key: 'market' as const, label: t('plugin.view.market') },
    { key: 'download' as const, label: t('plugin.view.download') },
    { key: 'install' as const, label: t('plugin.view.install') },
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

  // When any download session settles, refresh the in-store tags (a finished
  // download flips the plugin to "in store" without needing a manual reload).
  useEffect(() => window.api.downloads.onChange(() => { void refreshStoreNames() }), [refreshStoreNames])

  useEffect(() => {
    void (async () => {
      const d = await window.api.plugins.getDir()
      if (d.ok) { setDir(d.value.dir); setDirMissing(d.value.dir === '') }
      await Promise.all([load(), refreshStoreNames()])
    })()
  }, [refreshStoreNames])

  // Catalog annotations (category / deprecation) for the overview — non-blocking;
  // degrades to none when the market is unreachable.
  useEffect(() => {
    void window.api.market.annotations().then(r => { if (r.ok) setAnnotations(r.value) })
  }, [])

  // 从市场 / 下载中心 / 安装切回「总览」时重载一次，让刚下载/安装的插件立即可
  // 见 —— view 切换不重挂载本组件，否则总览会一直持有旧的挂载时数据。
  const prevView = useRef<PluginView>(view)
  useEffect(() => {
    if (view === 'overview' && prevView.current !== 'overview') void load()
    prevView.current = view
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view])

  // ── 实时搜索（防抖）+ 分页 ─────────────────────────────────────────
  const runSearch = useCallback(async (query: string, append: boolean): Promise<void> => {
    const q = query.trim()
    if (q === '') { setHits([]); setTotal(0); fromRef.current = 0; return }
    const start = append ? fromRef.current : 0
    if (append) setLoadingMore(true)
    else setSearching(true)
    const r = await window.api.plugins.search(q, { size: PAGE_SIZE, from: start })
    if (append) setLoadingMore(false)
    else setSearching(false)
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    setHits(prev => append ? [...prev, ...r.value.hits] : r.value.hits)
    setTotal(r.value.total)
    fromRef.current = start + r.value.hits.length
  }, [])

  // 仅进入「下载中心」视图才发起实时搜索 —— 挂载/停在「总览」不请求，避免每次
  // 进入插件管理页都对默认关键词空搜一次；切入下载中心则自动搜当前关键词。
  useEffect(() => {
    if (view !== 'download') return
    const timer = setTimeout(() => void runSearch(dq, false), 300)
    return () => clearTimeout(timer)
  }, [dq, view, runSearch])

  const loadMore = (): void => void runSearch(dq, true)

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

  // One-click: archive the newest release. The download panel streams progress
  // and reports a failure; the in-store tag refreshes on settle.
  const downloadUpdate = (name: string): void => {
    const latest = updates.get(name)?.latest
    if (latest === undefined) { openDownloadVersion(name); return }
    void window.api.downloads.start(`${name}@${latest}`, name)
    void message.info(t('plugin.overview.updateStarted', { spec: `${name}@${latest}` }))
  }

  const install = (): void => {
    const s = source.trim()
    if (s === '') return
    setLog('')
    // Fire a cancellable download session; progress/cancel live in the global
    // download panel. Store tags refresh when any session settles.
    void window.api.downloads.start(s)
    void message.info(t('plugin.download.started'))
  }

  const addLocal = async (kind: 'folder' | 'zip'): Promise<void> => {
    setBusyAction(kind)
    const res = await window.api.plugins.addLocal(kind)
    setBusyAction(null)
    if (!res.ok) { void message.error(apiErrorText(res)); return }
    setLog(res.value)
    void message.success(t('plugin.localAdded'))
    await Promise.all([load(), refreshStoreNames()]) // 总览 + 在库名单同步刷新
  }

  const overviewQ = search.trim().toLowerCase()
  // Classification filters: bucket + multi-condition origin/kind/provenance.
  // Within a dimension the selected values OR; across dimensions they AND.
  const filteredOverview = useMemo(() => {
    let rows = overview
    if (overviewQ !== '') rows = rows.filter(x => x.name.toLowerCase().includes(overviewQ))
    if (bucket === 'used') rows = rows.filter(x => x.usage.length > 0)
    else if (bucket === 'unused') rows = rows.filter(x => x.inStore === true && x.usage.length === 0)
    else if (bucket === 'update') rows = rows.filter(x => updates.get(x.name)?.updateAvailable === true)
    else if (bucket === 'template') rows = rows.filter(x => x.kind === 'template')
    if (origins.length > 0) rows = rows.filter(x => origins.includes(x.origin ?? 'unknown'))
    if (kinds.length > 0) rows = rows.filter(x => kinds.includes(x.kind ?? 'dependency'))
    if (provenances.length > 0) rows = rows.filter(x => (x.provenances ?? []).some(p => provenances.includes(p)))
    return rows
  }, [overview, overviewQ, bucket, origins, kinds, provenances, updates])

  const catLabel = (id: string): string => {
    const labels = annotations?.categories[id]
    return labels?.[lang] ?? labels?.en ?? id
  }
  const updateCount = [...updates.values()].filter(u => u.updateAvailable).length

  // Localized facet labels (kind / provenance need key-suffix mapping).
  const kindLabel = (k: PluginKind): string => t(`plugin.kind.${k === 'store-only' ? 'storeOnly' : k}`)
  const provLabel = (p: PluginProvenance): string => t(`plugin.provenance.${p === 'local-link' ? 'localLink' : p === 'sub-bundle' ? 'subBundle' : p}`)
  const activeFilterCount = origins.length + kinds.length + provenances.length
  const clearAllFilters = (): void => {
    setBucket('all'); setOrigins([]); setKinds([]); setProvenances([]); setSortKey('name'); setSortDir('asc')
  }

  // Sort + paginate the filtered rows locally (direction-aware).
  const sortedOverview = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    const arr = [...filteredOverview]
    switch (sortKey) {
      case 'size': return arr.sort((a, b) => ((sizeMap[a.name] ?? -1) - (sizeMap[b.name] ?? -1)) * dir)
      case 'versions': return arr.sort((a, b) => (a.versions.length - b.versions.length) * dir)
      case 'usage': return arr.sort((a, b) => (a.usage.length - b.usage.length) * dir)
      default: return arr.sort((a, b) => a.name.localeCompare(b.name) * dir)
    }
  }, [filteredOverview, sortKey, sortDir, sizeMap])
  const lastPage = Math.max(1, Math.ceil(sortedOverview.length / CARDS_PER_PAGE))
  const currentPage = Math.min(page, lastPage)
  const pagedOverview = sortedOverview.slice((currentPage - 1) * CARDS_PER_PAGE, currentPage * CARDS_PER_PAGE)

  // Reset to the first page whenever the filter / sort changes.
  useEffect(() => { setPage(1) }, [overviewQ, bucket, origins, kinds, provenances, sortKey, sortDir])

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
        <Space orientation="vertical" style={{ width: '100%' }} size="middle">
          <SectionHeading
            title={t('plugin.overview.title')}
            description={t('plugin.overview.summary', { total: overview.length, shown: filteredOverview.length })}
            extra={
              <Space size={8}>
                <Button loading={sizeLoading} onClick={() => void calcSizes()}>{t('plugin.overview.calcSize')}</Button>
                <Button type="primary" ghost loading={updatesChecking} onClick={() => void checkUpdates(false)}>{t('plugin.overview.checkUpdates')}</Button>
              </Space>
            }
          />
          {dirMissing && <Alert type="warning" showIcon title={t('plugin.dirMissing')} />}
          <Panel pad={false}>
            <Toolbar chips={activeFilterCount > 0 ? (
              <FilterChips
                items={[
                  ...origins.map(v => ({ key: `o:${v}`, label: `${t('plugin.overview.facet.origin')}: ${t(`plugin.source.${v}`)}`, onClose: () => setOrigins(list => list.filter(x => x !== v)) })),
                  ...kinds.map(v => ({ key: `k:${v}`, label: `${t('plugin.overview.facet.kind')}: ${kindLabel(v)}`, onClose: () => setKinds(list => list.filter(x => x !== v)) })),
                  ...provenances.map(v => ({ key: `p:${v}`, label: `${t('plugin.overview.facet.provenance')}: ${provLabel(v)}`, onClose: () => setProvenances(list => list.filter(x => x !== v)) })),
                ]}
                onClear={clearAllFilters}
                clearLabel={t('plugin.overview.clearFilters')}
              />
            ) : undefined}>
              <SearchInput
                value={search}
                onChange={setSearch}
                placeholder={t('plugin.overview.searchPlaceholder')}
                ariaLabel={t('plugin.overview.searchPlaceholder')}
              />
              <Segmented
                value={bucket}
                onChange={value => setBucket(value as Bucket)}
                options={[
                  { value: 'all', label: t('plugin.overview.bucket.all') },
                  { value: 'used', label: t('plugin.overview.bucket.used') },
                  { value: 'unused', label: t('plugin.overview.bucket.unused') },
                  { value: 'update', label: t('plugin.overview.bucket.update', { count: updateCount }) },
                  { value: 'template', label: t('plugin.overview.bucket.template') },
                ]}
              />
              <Popover
                trigger="click"
                placement="bottomRight"
                content={(
                  <div style={{ width: 280, display: 'flex', flexDirection: 'column', gap: token.padding }}>
                    <div>
                      <FieldLabel>{t('plugin.overview.facet.origin')}</FieldLabel>
                      <Select
                        mode="multiple" allowClear maxTagCount="responsive" value={origins}
                        onChange={value => setOrigins(value as PluginOrigin[])}
                        placeholder={t('plugin.overview.originAll')}
                        style={{ width: '100%' }}
                        options={[
                          { value: 'npm', label: t('plugin.source.npm') },
                          { value: 'github', label: t('plugin.source.github') },
                          { value: 'local', label: t('plugin.source.local') },
                          { value: 'unknown', label: t('plugin.source.unknown') },
                        ]}
                      />
                    </div>
                    <div>
                      <FieldLabel>{t('plugin.overview.facet.kind')}</FieldLabel>
                      <Select
                        mode="multiple" allowClear maxTagCount="responsive" value={kinds}
                        onChange={value => setKinds(value as PluginKind[])}
                        placeholder={t('plugin.overview.kindAll')}
                        style={{ width: '100%' }}
                        options={[
                          { value: 'bundle', label: kindLabel('bundle') },
                          { value: 'dependency', label: kindLabel('dependency') },
                          { value: 'template', label: kindLabel('template') },
                          { value: 'store-only', label: kindLabel('store-only') },
                        ]}
                      />
                    </div>
                    <div>
                      <FieldLabel>{t('plugin.overview.facet.provenance')}</FieldLabel>
                      <Select
                        mode="multiple" allowClear maxTagCount="responsive" value={provenances}
                        onChange={value => setProvenances(value as PluginProvenance[])}
                        placeholder={t('plugin.overview.provenanceAll')}
                        style={{ width: '100%' }}
                        options={[
                          { value: 'store', label: provLabel('store') },
                          { value: 'official', label: provLabel('official') },
                          { value: 'sub-bundle', label: provLabel('sub-bundle') },
                          { value: 'local-link', label: provLabel('local-link') },
                          { value: 'external', label: provLabel('external') },
                        ]}
                      />
                    </div>
                    {activeFilterCount > 0 && (
                      <Button size="small" onClick={clearAllFilters}>{t('plugin.overview.clearFilters')}</Button>
                    )}
                  </div>
                )}
              >
                <Badge count={activeFilterCount} size="small" offset={[-2, 2]}>
                  <Button icon={<FilterOutlined />}>{t('plugin.overview.filters')}</Button>
                </Badge>
              </Popover>
              <Select
                value={sortKey}
                onChange={value => {
                  const key = value as SortKey
                  setSortKey(key)
                  // Name reads best ascending; the numeric dimensions descending.
                  setSortDir(key === 'name' ? 'asc' : 'desc')
                }}
                style={{ width: 150 }}
                options={[
                  { value: 'name', label: t('plugin.overview.sort.name') },
                  { value: 'size', label: t('plugin.overview.sort.size') },
                  { value: 'versions', label: t('plugin.overview.sort.versions') },
                  { value: 'usage', label: t('plugin.overview.sort.usage') },
                ]}
              />
              <Button
                aria-label={t(sortDir === 'asc' ? 'plugin.overview.sortAsc' : 'plugin.overview.sortDesc')}
                title={t(sortDir === 'asc' ? 'plugin.overview.sortAsc' : 'plugin.overview.sortDesc')}
                icon={sortDir === 'asc' ? <ArrowUpOutlined /> : <ArrowDownOutlined />}
                onClick={() => setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))}
              />
            </Toolbar>

            <div style={{ padding: token.padding }}>
              {overviewLoading ? (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: token.padding }}>
                  {Array.from({ length: 6 }, (_, i) => (
                    <div key={i} style={{ border: `1px solid ${token.colorBorder}`, borderRadius: token.borderRadiusLG, padding: token.padding }}>
                      <Skeleton active title={false} paragraph={{ rows: 3 }} />
                    </div>
                  ))}
                </div>
              ) : sortedOverview.length === 0 ? (
                <EmptyState title={t('plugin.overview.empty')} description={t('plugin.overview.emptyDesc')} />
              ) : (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: token.padding }}>
                    {pagedOverview.map(r => {
                      const ann = annotations?.plugins[r.name]
                      return (
                        <PluginCard
                          key={r.name}
                          row={r}
                          update={updates.get(r.name)}
                          annotation={ann}
                          categoryLabel={ann !== undefined ? catLabel(ann.category) : ''}
                          sizeBytes={sizeMap[r.name]}
                          stale={staleStoreNames.has(r.name)}
                          onOpen={() => setTarget(r)}
                          onInstallToProfile={() => { setTarget(null); setInstallPkg(r.name) }}
                          onDownloadVersion={() => openDownloadVersion(r.name)}
                          onUpdate={() => downloadUpdate(r.name)}
                          onUninstall={() => void uninstall(r.name)}
                          onReveal={() => void revealDir(r.name)}
                          onDeleteStale={() => deleteStale(r.name)}
                        />
                      )
                    })}
                  </div>
                  {lastPage > 1 && (
                    <Pagination
                      style={{ textAlign: 'center', marginTop: token.padding }}
                      current={currentPage}
                      pageSize={CARDS_PER_PAGE}
                      total={sortedOverview.length}
                      showSizeChanger={false}
                      onChange={setPage}
                    />
                  )}
                </>
              )}
            </div>
          </Panel>
        </Space>
      )}

      {view === 'market' && <MarketSection />}

      {view === 'download' && (
        <Space orientation="vertical" style={{ width: '100%' }} size="middle">
          <SectionHeading title={t('plugin.download.title')} description={t('plugin.download.desc')} />
          {dirMissing && <Alert type="warning" showIcon title={t('plugin.dirMissingDownload')} />}
          <Panel pad={false}>
          <Toolbar>
            <SearchInput
              value={dq}
              onChange={setDq}
              onPressEnter={() => void runSearch(dq, false)}
              placeholder={t('plugin.download.searchPlaceholder')}
              loading={searching}
              ariaLabel={t('plugin.download.searchPlaceholder')}
              style={{ minWidth: 240, maxWidth: 480 }}
            />
          </Toolbar>

          <div style={{ padding: token.padding }}>
          {total > 0 && hits.length > 0 && (
            <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, marginBottom: token.paddingSM }}>
              {t('plugin.download.results', { total, loaded: hits.length })}
            </div>
          )}

          {searching ? (
            <Space orientation="vertical" style={{ width: '100%' }} size="middle">
              {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} active title paragraph={{ rows: 2 }} />)}
            </Space>
          ) : (
          <List
            dataSource={hits}
            rowKey="name"
            locale={{
              emptyText: (dq ?? '') === 'dsh' ? t('plugin.download.emptyHint') : t('plugin.download.noMatch'),
            }}
            renderItem={(hit) => {
              const inStore = storeMap.has(hit.name)
              return (
                <List.Item
                  actions={[
                    <Button key="dl" size="small" disabled={dirMissing} onClick={() => setDlPkg(hit.name)}>{t('plugin.version.download')}</Button>,
                    ...(inStore ? [<Button key="install" type="primary" size="small" onClick={() => setInstallPkg(hit.name)}>{t('plugin.download.installToProfile')}</Button>] : []),
                  ]}
                >
                  <List.Item.Meta
                    title={(
                      <span>
                        {hit.name}
                        {inStore && <Tag color="blue" style={{ marginInlineStart: 6 }}>{t('plugin.download.inStore')}</Tag>}
                        <Tag style={{ marginInlineStart: 6 }}>{hit.version}</Tag>
                      </span>
                    )}
                    description={(
                      <>
                        <div style={{ wordBreak: 'break-word' }}>{hit.description || t('plugin.download.noDesc')}</div>
                        {(hit.author !== undefined || hit.date !== undefined) && (
                          <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, marginTop: 2 }}>
                            {hit.author !== undefined && <span>@{hit.author}</span>}
                            {hit.date !== undefined && fmtDate(hit.date) !== '' && <span>{hit.author !== undefined ? ' · ' : ''}{t('plugin.download.updatedAt', { date: fmtDate(hit.date) })}</span>}
                          </div>
                        )}
                        {hit.keywords !== undefined && hit.keywords.length > 0 && (
                          <div style={{ marginTop: 4 }}>
                            {hit.keywords.slice(0, 6).map(k => <Tag key={k} style={{ marginBottom: 2, marginInlineEnd: 4 }}>{k}</Tag>)}
                          </div>
                        )}
                      </>
                    )}
                  />
                </List.Item>
              )
            }}
          />
          )}

          {!searching && hits.length > 0 && hits.length < total && (
            <div style={{ textAlign: 'center', marginTop: token.padding }}>
              <Button onClick={loadMore} loading={loadingMore}>{t('plugin.download.loadMore')}</Button>
            </div>
          )}
          </div>
          </Panel>
        </Space>
      )}

      {view === 'install' && (
        <Space orientation="vertical" style={{ width: '100%' }} size="middle">
          <SectionHeading title={t('plugin.installSection.title')} />
          {dirMissing
            ? <Alert type="warning" showIcon title={t('plugin.dirMissing')} />
            : <Alert type="info" showIcon title={t('plugin.installSection.info')} />}

          <Panel title={t('plugin.installSection.network')}>
            <Input value={source} onChange={event => setSource(event.target.value)} placeholder={t('plugin.installSection.sourcePlaceholder')} style={{ maxWidth: 480 }} />
            <div style={{ marginTop: token.paddingSM }}>
              <Button type="primary" onClick={() => void install()} loading={busyAction === 'network'} disabled={!source.trim() || dirMissing || busyAction !== null}>
                {dir !== '' ? t('plugin.installSection.downloadDir', { dir }) : t('plugin.installSection.download')}
              </Button>
            </div>
          </Panel>

          <Panel title={t('plugin.installSection.local')}>
            <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, marginBottom: token.paddingSM }}>
              {t('plugin.installSection.localHint')}
            </div>
            <Space>
              <Button onClick={() => void addLocal('folder')} loading={busyAction === 'folder'} disabled={dirMissing || busyAction !== null}>{t('plugin.installSection.fromFolder')}</Button>
              <Button onClick={() => void addLocal('zip')} loading={busyAction === 'zip'} disabled={dirMissing || busyAction !== null}>{t('plugin.installSection.fromZip')}</Button>
            </Space>
          </Panel>

          {log !== '' && (
            <pre style={{ background: token.colorFillTertiary, padding: token.paddingSM, borderRadius: token.borderRadius, maxHeight: 320, overflowY: 'auto', margin: 0 }}>{log}</pre>
          )}
        </Space>
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
      onUpdate={downloadUpdate}
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
    <DownloadVersionModal
      pkg={dlPkg}
      onClose={() => setDlPkg(null)}
      onInstalled={async () => { await Promise.all([load(), refreshStoreNames()]) }}
    />
    </>
  )
}