/**
 * The overview grid: installed plugins, the facet filters, sorting, local paging
 * and the manual size / update actions.
 *
 * Every filter and paging state is private to this view, including its localStorage
 * persistence — they were only ever read here. What it does not own is the data or
 * the writes: the rows, sizes, updates and annotations come in as props and every
 * action goes back out as a callback, so the section stays the one place that
 * reloads after a mutation.
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Alert, Badge, Button, Checkbox, Pagination, Popover, Segmented, Select, Skeleton, Space, theme,
} from 'antd'
import { ArrowDownOutlined, ArrowUpOutlined, FilterOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import EmptyState from '../../components/EmptyState.tsx'
import FieldLabel from '../../components/FieldLabel.tsx'
import FilterChips from '../../components/FilterChips.tsx'
import Panel from '../../components/Panel.tsx'
import SearchInput from '../../components/SearchInput.tsx'
import SectionHeading from '../../components/SectionHeading.tsx'
import Toolbar from '../../components/Toolbar.tsx'
import PluginCard from '../PluginCard.tsx'
import {
  applyOverviewFilters, loadFilters, saveFilters,
  type Bucket, type Facet, type FacetMode, type SortKey,
} from '../../lib/pluginFilters.ts'
import type {
  InstalledOverviewRow, MarketAnnotations, PluginKind, PluginOrigin, PluginProvenance, PluginUpdateInfo,
} from '../../../../shared/types.ts'

/** Cards per page (the grid paginates locally). */
const CARDS_PER_PAGE = 24

interface Props {
  overview: InstalledOverviewRow[]
  overviewLoading: boolean
  /** Real on-disk sizes, filled only by the manual "calculate sizes". */
  sizeMap: Record<string, number>
  sizeLoading: boolean
  /** Store plugins whose node_modules dir is gone (stale on disk). */
  staleStoreNames: Set<string>
  updates: Map<string, PluginUpdateInfo>
  updatesChecking: boolean
  annotations: MarketAnnotations | null
  /** Registered dev-plugin names — excluded unless "show dev" is on. */
  devNames: Set<string>
  dirMissing: boolean
  onCalcSizes: () => void
  onCheckUpdates: () => void
  onOpen: (row: InstalledOverviewRow) => void
  onInstallToProfile: (name: string) => void
  onDownloadVersion: (name: string) => void
  onUpdate: (row: InstalledOverviewRow) => void
  onUninstall: (name: string) => void
  onReveal: (name: string) => void
  onDeleteStale: (name: string) => void
}

export default function PluginsOverviewView({
  overview, overviewLoading, sizeMap, sizeLoading, staleStoreNames, updates, updatesChecking,
  annotations, devNames, dirMissing, onCalcSizes, onCheckUpdates, onOpen, onInstallToProfile,
  onDownloadVersion, onUpdate, onUninstall, onReveal, onDeleteStale,
}: Props): JSX.Element {
  const { t, i18n } = useTranslation()
  const { token } = theme.useToken()
  const lang = i18n.language === 'zh' ? 'zh' : 'en'

  const [search, setSearch] = useState('')
  // Classification filters — each facet is a whitelist (`include`) or a blacklist
  // (`exclude`); within a facet the values OR, across facets they AND. Loaded once
  // from localStorage, saved on every change.
  const [savedFilters] = useState(loadFilters)
  const [bucket, setBucket] = useState<Bucket>(savedFilters.bucket)
  const [originFacet, setOriginFacet] = useState<Facet<PluginOrigin>>(savedFilters.origin)
  const [kindFacet, setKindFacet] = useState<Facet<PluginKind>>(savedFilters.kind)
  const [provFacet, setProvFacet] = useState<Facet<PluginProvenance>>(savedFilters.provenance)
  const [sortKey, setSortKey] = useState<SortKey>(savedFilters.sortKey)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(savedFilters.sortDir)
  // Whether the grid also lists registered dev plugins. Persisted with the rest of
  // the filters, so the choice survives a reload.
  const [showDev, setShowDev] = useState(savedFilters.showDev)
  const [page, setPage] = useState(1)

  useEffect(() => {
    saveFilters({ bucket, origin: originFacet, kind: kindFacet, provenance: provFacet, sortKey, sortDir, showDev })
  }, [bucket, originFacet, kindFacet, provFacet, sortKey, sortDir, showDev])

  const filtered = useMemo(
    () => applyOverviewFilters(
      overview,
      { bucket, origin: originFacet, kind: kindFacet, provenance: provFacet, sortKey, sortDir, showDev },
      { query: search, updates, devNames, showDev },
    ),
    [overview, search, bucket, originFacet, kindFacet, provFacet, sortKey, sortDir, updates, devNames, showDev],
  )

  // Sort + paginate locally (direction-aware; `name` is the fallback dimension).
  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    const arr = [...filtered]
    switch (sortKey) {
      case 'size': return arr.sort((a, b) => ((sizeMap[a.name] ?? -1) - (sizeMap[b.name] ?? -1)) * dir)
      case 'versions': return arr.sort((a, b) => (a.versions.length - b.versions.length) * dir)
      case 'usage': return arr.sort((a, b) => (a.usage.length - b.usage.length) * dir)
      default: return arr.sort((a, b) => a.name.localeCompare(b.name) * dir)
    }
  }, [filtered, sortKey, sortDir, sizeMap])

  const lastPage = Math.max(1, Math.ceil(sorted.length / CARDS_PER_PAGE))
  const currentPage = Math.min(page, lastPage)
  const paged = sorted.slice((currentPage - 1) * CARDS_PER_PAGE, currentPage * CARDS_PER_PAGE)

  // Back to the first page whenever what is being paged changes.
  useEffect(() => { setPage(1) }, [search, bucket, originFacet, kindFacet, provFacet, sortKey, sortDir])

  const updateCount = [...updates.values()].filter(u => u.updateAvailable).length
  const kindLabel = (k: PluginKind): string => t(`plugin.kind.${k === 'store-only' ? 'storeOnly' : k}`)
  const provLabel = (p: PluginProvenance): string => t(`plugin.provenance.${p === 'local-link' ? 'localLink' : p === 'sub-bundle' ? 'subBundle' : p}`)
  const catLabel = (id: string): string => {
    const labels = annotations?.categories[id]
    return labels?.[lang] ?? labels?.en ?? id
  }
  const activeFilterCount = originFacet.values.length + kindFacet.values.length + provFacet.values.length

  const clearAllFilters = (): void => {
    setBucket('all')
    setOriginFacet({ mode: 'include', values: [] })
    setKindFacet({ mode: 'include', values: [] })
    setProvFacet({ mode: 'include', values: [] })
    setSortKey('name'); setSortDir('asc')
  }

  /** A chip label: `来源: npm` for include, `来源 ≠ official` for exclude. */
  const facetChip = (facet: string, mode: FacetMode, value: string): string =>
    `${facet} ${mode === 'exclude' ? '≠' : ':'} ${value}`

  /** The include/exclude switch shown next to a facet's label. */
  const facetModeSwitch = (mode: FacetMode, onChange: (mode: FacetMode) => void): JSX.Element => (
    <Segmented
      size="small"
      value={mode}
      onChange={value => onChange(value as FacetMode)}
      options={[
        { value: 'include', label: t('plugin.overview.facetMode.include') },
        { value: 'exclude', label: t('plugin.overview.facetMode.exclude') },
      ]}
    />
  )

  return (
    <Space orientation="vertical" style={{ width: '100%' }} size="middle">
      <SectionHeading
        title={t('plugin.overview.title')}
        description={t('plugin.overview.summary', { total: overview.length, shown: filtered.length })}
        extra={
          <Space size={8}>
            <Button loading={sizeLoading} onClick={onCalcSizes}>{t('plugin.overview.calcSize')}</Button>
            <Button type="primary" ghost loading={updatesChecking} onClick={onCheckUpdates}>{t('plugin.overview.checkUpdates')}</Button>
          </Space>
        }
      />
      {dirMissing && <Alert type="warning" showIcon title={t('plugin.dirMissing')} />}
      <Panel pad={false}>
        <Toolbar chips={activeFilterCount > 0 ? (
          <FilterChips
            items={[
              ...originFacet.values.map(v => ({ key: `o:${v}`, label: facetChip(t('plugin.overview.facet.origin'), originFacet.mode, t(`plugin.source.${v}`)), onClose: () => setOriginFacet(f => ({ ...f, values: f.values.filter(x => x !== v) })) })),
              ...kindFacet.values.map(v => ({ key: `k:${v}`, label: facetChip(t('plugin.overview.facet.kind'), kindFacet.mode, kindLabel(v)), onClose: () => setKindFacet(f => ({ ...f, values: f.values.filter(x => x !== v) })) })),
              ...provFacet.values.map(v => ({ key: `p:${v}`, label: facetChip(t('plugin.overview.facet.provenance'), provFacet.mode, provLabel(v)), onClose: () => setProvFacet(f => ({ ...f, values: f.values.filter(x => x !== v) })) })),
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
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <FieldLabel>{t('plugin.overview.facet.origin')}</FieldLabel>
                    {facetModeSwitch(originFacet.mode, mode => setOriginFacet(f => ({ ...f, mode })))}
                  </div>
                  <Select
                    mode="multiple" allowClear maxTagCount="responsive" value={originFacet.values}
                    onChange={value => setOriginFacet(f => ({ ...f, values: value as PluginOrigin[] }))}
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
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <FieldLabel>{t('plugin.overview.facet.kind')}</FieldLabel>
                    {facetModeSwitch(kindFacet.mode, mode => setKindFacet(f => ({ ...f, mode })))}
                  </div>
                  <Select
                    mode="multiple" allowClear maxTagCount="responsive" value={kindFacet.values}
                    onChange={value => setKindFacet(f => ({ ...f, values: value as PluginKind[] }))}
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
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <FieldLabel>{t('plugin.overview.facet.provenance')}</FieldLabel>
                    {facetModeSwitch(provFacet.mode, mode => setProvFacet(f => ({ ...f, mode })))}
                  </div>
                  <Select
                    mode="multiple" allowClear maxTagCount="responsive" value={provFacet.values}
                    onChange={value => setProvFacet(f => ({ ...f, values: value as PluginProvenance[] }))}
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
          <Checkbox checked={showDev} onChange={e => setShowDev(e.target.checked)}>{t('plugin.overview.showDev')}</Checkbox>
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
          ) : sorted.length === 0 ? (
            <EmptyState title={t('plugin.overview.empty')} description={t('plugin.overview.emptyDesc')} />
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: token.padding }}>
                {paged.map((row) => {
                  const ann = annotations?.plugins[row.name]
                  return (
                    <PluginCard
                      key={row.name}
                      row={row}
                      update={updates.get(row.name)}
                      annotation={ann}
                      categoryLabel={ann !== undefined ? catLabel(ann.category) : ''}
                      sizeBytes={sizeMap[row.name]}
                      stale={staleStoreNames.has(row.name)}
                      onOpen={() => onOpen(row)}
                      onInstallToProfile={() => onInstallToProfile(row.name)}
                      onDownloadVersion={() => onDownloadVersion(row.name)}
                      onUpdate={() => onUpdate(row)}
                      onUninstall={() => onUninstall(row.name)}
                      onReveal={() => onReveal(row.name)}
                      onDeleteStale={() => onDeleteStale(row.name)}
                    />
                  )
                })}
              </div>
              {lastPage > 1 && (
                <Pagination
                  style={{ textAlign: 'center', marginTop: token.padding }}
                  current={currentPage}
                  pageSize={CARDS_PER_PAGE}
                  total={sorted.length}
                  showSizeChanger={false}
                  onChange={setPage}
                />
              )}
            </>
          )}
        </div>
      </Panel>
    </Space>
  )
}
