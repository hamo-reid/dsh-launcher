/**
 * Community market — browse the curated awesome-dsh-plugin catalog (categories,
 * stars, bilingual descriptions), pick a loading route, and take a plugin down
 * into the store (reusing the existing version-download / install-to-profile
 * dialogs). The install TARGET is always resolved by the main process from the
 * catalog entry (`market:resolve`); nothing the user types reaches pnpm as a
 * spec through this view.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert, Button, Input, List, message, Modal, Pagination, Select, Space, Spin, Tag, theme,
} from 'antd'
import { LoadingOutlined, ReloadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../lib/ipc.ts'
import Panel from '../components/Panel.tsx'
import SectionHeading from '../components/SectionHeading.tsx'
import FieldLabel from '../components/FieldLabel.tsx'
import { DownloadVersionModal, InstallToProfileModal, toStoreMap } from './PluginsModals.tsx'
import type { MarketPlugin, MarketSort, MarketSourceState } from '../../../shared/types.ts'

const num = (n: number): string => new Intl.NumberFormat().format(n)

export default function MarketSection(): JSX.Element {
  const { t, i18n } = useTranslation()
  const { token } = theme.useToken()
  const lang = i18n.language === 'zh' ? 'zh' : 'en'

  // Loading route; null until the persisted route is read back on mount.
  const [srcState, setSrcState] = useState<MarketSourceState | null>(null)
  const [customUrl, setCustomUrl] = useState('')
  const [savingSource, setSavingSource] = useState(false)

  // Server-side query → one page of rows + total (never the whole catalog).
  const [rows, setRows] = useState<MarketPlugin[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [categories, setCategories] = useState<{ id: string; label: string }[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Browse filters — `q` is the debounced query, `qInput` the raw field text.
  const [qInput, setQInput] = useState('')
  const [q, setQ] = useState('')
  const [category, setCategory] = useState('')
  const [sort, setSort] = useState<MarketSort>('stars')

  // Monotonic request id: a late response from a superseded request is dropped.
  const seqRef = useRef(0)

  // Store membership (for in-store marking + which plugins are downloadable).
  const [storeMap, setStoreMap] = useState<Map<string, string[]>>(new Map())

  // Dialogs.
  const [dlPkg, setDlPkg] = useState<string | null>(null) // npm name → DownloadVersionModal
  const [installPkg, setInstallPkg] = useState<string | null>(null) // npm name → InstallToProfileModal
  const [detail, setDetail] = useState<MarketPlugin | null>(null)
  const [busy, setBusy] = useState<null | string>(null) // url currently installing from GitHub

  const refreshStoreNames = useCallback(async (): Promise<void> => {
    const r = await window.api.plugins.list()
    if (r.ok) setStoreMap(toStoreMap(r.value))
  }, [])

  // The one request path. Reads the current filter/page state (fresh via the
  // useCallback deps) and applies the query server-side; a stale response is
  // ignored so slow pages never clobber a newer one.
  const load = useCallback(async (refresh = false): Promise<void> => {
    if (srcState === null) return
    const seq = ++seqRef.current
    setLoading(true)
    setError('')
    // Pagination / search / sort hit the memoized catalog (instant, no network);
    // only a manual refresh forces a revalidation.
    const r = await window.api.market.list({ source: srcState, page, pageSize, q, category, sort, refresh })
    if (seq !== seqRef.current) return // superseded — a newer request is in flight
    setLoading(false)
    if (!r.ok) { setError(apiErrorText(r)); return }
    setRows(r.value.items)
    setTotal(r.value.total)
    setPage(r.value.page)
    setPageSize(r.value.pageSize)
    setCategories(Object.entries(r.value.categories ?? {}).map(([id, labels]) => ({
      id,
      label: labels?.[lang] ?? labels?.en ?? id,
    })))
  }, [srcState, page, pageSize, q, category, sort, lang])

  // Read the persisted loading route back once, then let the query effect fire.
  useEffect(() => {
    void (async () => {
      const s = await window.api.market.source()
      if (s.ok) {
        setCustomUrl(s.value.url)
        setSrcState(s.value)
      }
    })()
    void refreshStoreNames()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Debounce the search box so a re-query happens only after the user pauses.
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(qInput.trim())
      setPage(1)
    }, 300)
    return () => clearTimeout(t)
  }, [qInput])

  // Any change to the query / page / route refetches (srcState has to be in
  // hand first, else we'd fire before the persisted route is known).
  useEffect(() => {
    if (srcState === null) return
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, category, sort, page, pageSize, srcState])

  const applySource = async (): Promise<void> => {
    if (srcState === null) return
    const next: MarketSourceState = { source: srcState.source, url: customUrl }
    setSavingSource(true)
    const r = await window.api.market.setSource(next)
    setSavingSource(false)
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    if (!r.value) { void message.error(t('plugin.market.invalidUrl')); return }
    // Route change → back to the first page of the (now) new catalog. The
    // query effect refetches once srcState flips.
    setPage(1)
    setSrcState(next)
    void message.success(t('plugin.market.sourceSaved'))
  }

  const catLabel = (id: string): string => {
    const hit = categories.find(c => c.id === id)
    return hit?.label ?? id
  }

  const descOf = (p: MarketPlugin): string => p.description?.[lang] ?? p.description?.en ?? ''
  const hasNpm = (p: MarketPlugin): boolean => typeof p.npm === 'string' && p.npm !== ''

  const downloadFromGitHub = async (p: MarketPlugin): Promise<void> => {
    setBusy(p.url)
    try {
      const r = await window.api.market.resolve(p.url)
      if (!r.ok) { void message.error(apiErrorText(r)); return }
      if (r.value.spec === null) { void message.error(t('plugin.market.noSource')); return }
      const add = await window.api.plugins.add(r.value.spec, p.name)
      if (!add.ok) { void message.error(apiErrorText(add)); return }
      void message.success(t('plugin.market.addedToStore', { spec: r.value.spec }))
      await refreshStoreNames()
    } finally {
      setBusy(null)
    }
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <SectionHeading
        title={t('plugin.market.title', { count: total })}
        description={t('plugin.market.desc')}
      />

      {/* Loading-route picker (user-selectable pipeline). */}
      <Panel title={t('plugin.market.sourceLabel')}>
        <Space wrap style={{ width: '100%' }} align="center">
          <Select
            value={srcState?.source ?? 'official'}
            onChange={v => setSrcState(prev => ({ source: v as MarketSourceState['source'], url: prev?.url ?? '' }))}
            style={{ minWidth: 200 }}
            options={[
              { value: 'official', label: t('plugin.market.source.official') },
              { value: 'custom', label: t('plugin.market.source.custom') },
            ]}
          />
          {srcState?.source === 'custom' && (
            <Input
              allowClear
              value={customUrl}
              onChange={e => setCustomUrl(e.target.value)}
              placeholder={t('plugin.market.customUrlPlaceholder')}
              style={{ minWidth: 320, maxWidth: 480 }}
            />
          )}
          <Button loading={savingSource} onClick={() => void applySource()} disabled={srcState?.source === 'custom' && !customUrl.trim()}>
            {t('common.save')}
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => void load(true)} disabled={loading}>
            {t('plugin.market.refresh')}
          </Button>
        </Space>
      </Panel>

      {error !== '' && (
        <Alert
          type="error"
          showIcon
          message={t('plugin.market.loadFailed')}
          description={error}
          action={<Button size="small" onClick={() => void load(true)}>{t('common.retry')}</Button>}
        />
      )}

      {srcState !== null && (
        <Panel>
          <Space wrap style={{ marginBottom: token.paddingSM }}>
            <Input
              allowClear
              value={qInput}
              onChange={e => setQInput(e.target.value)}
              placeholder={t('plugin.market.searchPlaceholder')}
              style={{ maxWidth: 320 }}
            />
            <Select
              value={category}
              onChange={v => { setCategory(v); setPage(1) }}
              style={{ minWidth: 150 }}
              options={[
                { value: '', label: t('plugin.market.categoryAll') },
                ...categories.map(c => ({ value: c.id, label: c.label })),
              ]}
            />
            <Select
              value={sort}
              onChange={v => { setSort(v as MarketSort); setPage(1) }}
              style={{ minWidth: 150 }}
              options={[
                { value: 'stars', label: t('plugin.market.sort.stars') },
                { value: 'downloads', label: t('plugin.market.sort.downloads') },
                { value: 'newest', label: t('plugin.market.sort.newest') },
              ]}
            />
          </Space>

          {loading ? (
            <div style={{ textAlign: 'center', padding: 24 }}><Spin /></div>
          ) : (
            <List
              dataSource={rows}
              rowKey="url"
              locale={{ emptyText: t('plugin.market.empty') }}
              renderItem={(p: MarketPlugin) => {
                // Store membership: npm plugins match by npm name; a GitHub-only
                // entry is identified by its catalog name (dsh repos publish the
                // repo package.json name), so a repo download is recognised in
                // the store and its install button correctly targets it.
                const storeKey = p.npm && p.npm.trim() !== '' ? p.npm : p.name
                const inStore = storeMap.has(storeKey)
                return (
                  <List.Item
                    style={{ cursor: 'pointer' }}
                    onClick={() => setDetail(p)}
                    actions={[
                      // 下载始终可用(可下载其他版本);安装到 profile 仅在已入库时显示。
                      hasNpm(p)
                        ? <Button key="dl" size="small" disabled={busy !== null} onClick={e => { e.stopPropagation(); setDlPkg(p.npm!) }}>{t('plugin.market.download')}</Button>
                        : <Button key="dl" size="small" loading={busy === p.url} onClick={e => { e.stopPropagation(); void downloadFromGitHub(p) }}>{t('plugin.market.downloadGitHub')}</Button>,
                      ...(inStore ? [<Button key="install" type="primary" size="small" onClick={e => { e.stopPropagation(); setInstallPkg(storeKey) }}>{t('plugin.market.installToProfile')}</Button>] : []),
                    ]}
                  >
                    <List.Item.Meta
                      title={(
                        <span>
                          <span style={{ fontWeight: 600 }}>{p.owner}/{p.name}</span>
                          {p.deprecated === true && <Tag color="error" style={{ marginInlineStart: 6 }}>{t('plugin.market.deprecated')}</Tag>}
                          {inStore && <Tag color="blue" style={{ marginInlineStart: 6 }}>{t('plugin.market.inStore')}</Tag>}
                        </span>
                      )}
                      description={(
                        <>
                          <div style={{ wordBreak: 'break-word' }}>{descOf(p) || t('plugin.market.noDesc')}</div>
                          <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, marginTop: 4 }}>
                            <Tag style={{ marginInlineEnd: 4 }}>{catLabel(p.category)}</Tag>
                            {p.stars != null && <span>★ {num(p.stars)}</span>}
                            {p.downloads != null && <span>{p.stars != null ? ' · ' : ''}{num(p.downloads)}/mo</span>}
                          </div>
                        </>
                      )}
                    />
                  </List.Item>
                )
              }}
            />
          )}
          {total > 0 && (
            <Pagination
              style={{ textAlign: 'center', marginTop: token.paddingSM }}
              current={page}
              pageSize={pageSize}
              total={total}
              showSizeChanger
              pageSizeOptions={[10, 20, 50]}
              onChange={(p) => setPage(p)}
              onShowSizeChange={(_current, size) => { setPageSize(size); setPage(1) }}
            />
          )}
        </Panel>
      )}

      {/* Detail dialog: full entry info + source links. */}
      <Modal
        title={detail !== null ? `${detail.owner}/${detail.name}` : ''}
        open={detail !== null}
        onCancel={() => setDetail(null)}
        footer={null}
        width={520}
      >
        {detail !== null && (
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            <div style={{ wordBreak: 'break-word', color: token.colorText }}>
              {descOf(detail) || t('plugin.market.noDesc')}
            </div>
            {(detail.stars != null || detail.downloads != null) && (
              <div style={{ color: token.colorTextSecondary }}>
                {detail.stars != null && <span>★ {num(detail.stars)}</span>}
                {detail.downloads != null && <span>{detail.stars != null ? ' · ' : ''}{num(detail.downloads)}/mo</span>}
              </div>
            )}
            <div>
              <FieldLabel>{t('plugin.market.field.category')}</FieldLabel>
              <Tag>{catLabel(detail.category)}</Tag>
              {detail.deprecated === true && (
                <Tag color="error">{t('plugin.market.deprecated')}</Tag>
              )}
            </div>
            {detail.deprecated === true && detail.replacement !== undefined && detail.replacement !== '' && (
              <Alert type="warning" showIcon message={t('plugin.market.replacedBy', { name: detail.replacement })} />
            )}
            <div>
              <FieldLabel>{t('plugin.market.field.source')}</FieldLabel>
              <Space wrap>
                <Button size="small" icon={<LoadingOutlined />} onClick={() => void window.api.run.openExternal(detail.url)}>
                  GitHub
                </Button>
                {hasNpm(detail) && <Button size="small" onClick={() => void window.api.run.openExternal(`https://www.npmjs.com/package/${detail.npm}`)}>npm</Button>}
                {hasNpm(detail) && <Tag color="blue">npm: {detail.npm}</Tag>}
              </Space>
            </div>
            {detail.added !== undefined && (
              <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>
                {t('plugin.market.added', { date: detail.added })}
              </div>
            )}
          </Space>
        )}
      </Modal>

      <DownloadVersionModal
        pkg={dlPkg}
        onClose={() => setDlPkg(null)}
        onInstalled={async () => { await refreshStoreNames() }}
      />
      <InstallToProfileModal
        installPkg={installPkg}
        versions={installPkg !== null ? storeMap.get(installPkg) ?? [] : []}
        onClose={() => setInstallPkg(null)}
        onDone={async () => { await refreshStoreNames() }}
      />
    </Space>
  )
}