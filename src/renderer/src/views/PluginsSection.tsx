import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert, Button, Input, List, Menu, Modal, Space, Table, Tag, theme, message,
} from 'antd'
import { LoadingOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../lib/ipc.ts'
import AppShell from '../components/AppShell.tsx'
import Panel from '../components/Panel.tsx'
import SectionHeading from '../components/SectionHeading.tsx'
import { DownloadVersionModal, PluginDetailModal, InstallToProfileModal } from './PluginsModals.tsx'
import MarketSection from './MarketSection.tsx'
import type { InstalledOverviewRow, NpmSearchHit } from '../../../shared/types.ts'

type PluginView = 'overview' | 'download' | 'install' | 'market'

const PAGE_SIZE = 25

function fmtDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString()
}

/** 插件管理页：总览、下载中心、安装；详情 / 安装到 profile / 下载版本弹窗在 `PluginsModals`。
 * 下载中心：实时搜索（防抖）+ 分页加载更多 + 在库标记 + 可选版本下载。 */
export default function PluginsSection() {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [view, setView] = useState<PluginView>('overview')

  const [dir, setDir] = useState('')
  const [dirMissing, setDirMissing] = useState(false)
  const [search, setSearch] = useState('') // overview 名称过滤

  // Installed-plugin overview.
  const [overview, setOverview] = useState<InstalledOverviewRow[]>([])
  const [target, setTarget] = useState<InstalledOverviewRow | null>(null)
  const [overviewLoading, setOverviewLoading] = useState(false)
  // Store plugin names whose node_modules dir is missing on disk (stale).
  const [staleStoreNames, setStaleStoreNames] = useState<Set<string>>(new Set())

  // Download center.
  const [dq, setDq] = useState('dsh')
  const [hits, setHits] = useState<NpmSearchHit[]>([])
  const [total, setTotal] = useState(0)
  const [searching, setSearching] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [storeNames, setStoreNames] = useState<Set<string>>(new Set())
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

  const load = async (): Promise<void> => {
    setOverviewLoading(true)
    const r = await window.api.plugins.overview()
    setOverviewLoading(false)
    if (r.ok) setOverview(r.value)
    else void message.error(apiErrorText(r))
    // Which store plugins have a missing node_modules dir (for stale marking).
    const h = await window.api.settings.checkHealth()
    if (h.ok) setStaleStoreNames(new Set(h.value.filter(x => x.kind === 'plugin-missing').map(x => x.label)))
  }

  const refreshStoreNames = useCallback(async (): Promise<void> => {
    const r = await window.api.plugins.list()
    if (r.ok) setStoreNames(new Set(r.value.map(p => p.name)))
  }, [])

  useEffect(() => {
    void (async () => {
      const d = await window.api.plugins.getDir()
      if (d.ok) { setDir(d.value.dir); setDirMissing(d.value.dir === '') }
      await Promise.all([load(), refreshStoreNames()])
    })()
  }, [refreshStoreNames])

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

  useEffect(() => {
    const timer = setTimeout(() => void runSearch(dq, false), 300)
    return () => clearTimeout(timer)
  }, [dq, runSearch])

  const loadMore = (): void => void runSearch(dq, true)

  const uninstall = async (name: string): Promise<void> => {
    setBusy(true)
    const res = await window.api.plugins.remove(name)
    setBusy(false)
    if (!res.ok) { void message.error(apiErrorText(res)); setTarget(null); return }
    setTarget(null)
    void message.success(t('plugin.uninstalled', { name }))
    await Promise.all([load(), refreshStoreNames()])
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

  const install = async (): Promise<void> => {
    const s = source.trim()
    if (s === '') return
    setBusyAction('network')
    const res = await window.api.plugins.add(s)
    setBusyAction(null)
    if (!res.ok) { void message.error(apiErrorText(res)); setLog('') } else { setLog(res.value); void message.success(t('plugin.installedStore')) }
    await Promise.all([load(), refreshStoreNames()]) // 总览 + 在库名单同步刷新
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

  const versionCell = (versions: string[]): string => {
    if (versions.length === 0) return '-'
    if (versions.length === 1) return versions[0]
    return t('plugin.overview.nVersions', { count: versions.length })
  }

  const overviewQ = search.trim().toLowerCase()
  const filteredOverview = overviewQ === '' ? overview : overview.filter(x => x.name.toLowerCase().includes(overviewQ))

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
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <SectionHeading title={t('plugin.overview.title', { count: filteredOverview.length })} />
          {dirMissing && <Alert type="warning" showIcon message={t('plugin.dirMissing')} />}
          <Panel>
          <Input
            allowClear
            placeholder={t('plugin.overview.searchPlaceholder')}
            value={search}
            onChange={event => setSearch(event.target.value)}
            style={{ maxWidth: 280, marginBottom: token.paddingSM }}
          />
          <Table
            size="small"
            rowKey="name"
            loading={overviewLoading}
            dataSource={filteredOverview}
            pagination={{ pageSize: 20, showSizeChanger: true }}
            locale={{ emptyText: t('plugin.overview.empty') }}
            onRow={r => ({ onClick: () => setTarget(r), style: { cursor: 'pointer' } })}
            columns={[
              {
                title: t('plugin.overview.colName'),
                dataIndex: 'name',
                ellipsis: true,
                render: (name: string) => {
                  const stale = staleStoreNames.has(name)
                  return (
                    <Space size={4} wrap>
                      <span>{name}</span>
                      {stale && <Tag color="error">{t('plugin.stale')}</Tag>}
                      {stale && <Button size="small" danger type="link" style={{ padding: 0 }} onClick={e => { e.stopPropagation(); deleteStale(name) }}>{t('plugin.removeStale')}</Button>}
                    </Space>
                  )
                },
              },
              {
                title: t('plugin.overview.colVersions'),
                dataIndex: 'versions',
                width: 140,
                ellipsis: { showTitle: false },
                render: (versions: string[]) => <span title={versions.join('、')}>{versionCell(versions)}</span>,
              },
              {
                title: t('plugin.overview.colUsage'),
                key: 'usage',
                width: 180,
                render: (_: unknown, r: InstalledOverviewRow) => {
                  const dshs = new Set(r.usage.map(u => u.dsh))
                  return (
                    <Space size={4} wrap>
                      <Tag>{t('plugin.overview.usageN', { count: r.usage.length })}</Tag>
                      <Tag>{t('plugin.overview.dshN', { count: dshs.size })}</Tag>
                      {r.builtin === true ? <Tag color="purple">{t('plugin.overview.builtin')}</Tag> : null}
                      {r.inStore && <Tag color="blue">{t('plugin.overview.storeTag')}</Tag>}
                    </Space>
                  )
                },
              },
              {
                title: t('plugin.overview.colDetail'),
                key: 'detail',
                width: 80,
                render: (_: unknown, r: InstalledOverviewRow) => (
                  <Button size="small" onClick={event => { event.stopPropagation(); setTarget(r) }}>{t('plugin.overview.view')}</Button>
                ),
              },
            ]}
          />
          </Panel>
        </Space>
      )}

      {view === 'market' && <MarketSection />}

      {view === 'download' && (
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <SectionHeading title={t('plugin.download.title')} description={t('plugin.download.desc')} />
          {dirMissing && <Alert type="warning" showIcon message={t('plugin.dirMissingDownload')} />}
          <Panel>
          <Input
            allowClear
            value={dq}
            onChange={event => setDq(event.target.value)}
            onPressEnter={() => void runSearch(dq, false)}
            placeholder={t('plugin.download.searchPlaceholder')}
            suffix={searching ? <LoadingOutlined /> : undefined}
            style={{ maxWidth: 480, marginBottom: token.paddingSM }}
          />

          {total > 0 && hits.length > 0 && (
            <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, marginBottom: token.paddingSM }}>
              {t('plugin.download.results', { total, loaded: hits.length })}
            </div>
          )}

          <List
            dataSource={hits}
            rowKey="name"
            loading={searching}
            locale={{
              emptyText: (dq ?? '') === 'dsh' ? t('plugin.download.emptyHint') : t('plugin.download.noMatch'),
            }}
            renderItem={(hit) => {
              const inStore = storeNames.has(hit.name)
              return (
                <List.Item
                  actions={[
                    inStore
                      ? <Button type="primary" size="small" disabled={dirMissing} onClick={() => setInstallPkg(hit.name)}>{t('plugin.download.installToProfile')}</Button>
                      : <Button type="primary" size="small" disabled={dirMissing} onClick={() => setDlPkg(hit.name)}>{t('plugin.version.download')}</Button>,
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

          {!searching && hits.length > 0 && hits.length < total && (
            <div style={{ textAlign: 'center', marginTop: token.paddingSM }}>
              <Button onClick={loadMore} loading={loadingMore}>{t('plugin.download.loadMore')}</Button>
            </div>
          )}
          </Panel>
        </Space>
      )}

      {view === 'install' && (
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <SectionHeading title={t('plugin.installSection.title')} />
          {dirMissing
            ? <Alert type="warning" showIcon message={t('plugin.dirMissing')} />
            : <Alert type="info" showIcon message={t('plugin.installSection.info')} />}

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
      onClose={() => setTarget(null)}
      onUninstall={name => void uninstall(name)}
      onReveal={name => void revealDir(name)}
      onInstallToProfile={name => { setTarget(null); setInstallPkg(name) }}
    />
    <InstallToProfileModal
      installPkg={installPkg}
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