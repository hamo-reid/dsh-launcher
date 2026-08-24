/**
 * Community market — browse the curated awesome-dsh-plugin catalog (categories,
 * stars, bilingual descriptions), pick a loading route, and take a plugin down
 * into the store (reusing the existing version-download / install-to-profile
 * dialogs). The install TARGET is always resolved by the main process from the
 * catalog entry (`market:resolve`); nothing the user types reaches pnpm as a
 * spec through this view.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert, Button, Input, List, message, Modal, Select, Space, Spin, Tag, theme,
} from 'antd'
import { LoadingOutlined, ReloadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../lib/ipc.ts'
import Panel from '../components/Panel.tsx'
import SectionHeading from '../components/SectionHeading.tsx'
import FieldLabel from '../components/FieldLabel.tsx'
import { DownloadVersionModal, InstallToProfileModal } from './PluginsModals.tsx'
import type { MarketCatalog, MarketPlugin, MarketSort, MarketSourceState } from '../../../shared/types.ts'

const num = (n: number): string => new Intl.NumberFormat().format(n)

export default function MarketSection(): JSX.Element {
  const { t, i18n } = useTranslation()
  const { token } = theme.useToken()
  const lang = i18n.language === 'zh' ? 'zh' : 'en'

  // Catalog + loading route.
  const [catalog, setCatalog] = useState<MarketCatalog | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [srcState, setSrcState] = useState<MarketSourceState>({ source: 'official', url: '' })
  const [customUrl, setCustomUrl] = useState('')
  const [savingSource, setSavingSource] = useState(false)

  // Browse filters.
  const [q, setQ] = useState('')
  const [category, setCategory] = useState('')
  const [sort, setSort] = useState<MarketSort>('stars')

  // Store membership (for in-store marking + which plugins are downloadable).
  const [storeNames, setStoreNames] = useState<Set<string>>(new Set())

  // Dialogs.
  const [dlPkg, setDlPkg] = useState<string | null>(null) // npm name → DownloadVersionModal
  const [installPkg, setInstallPkg] = useState<string | null>(null) // npm name → InstallToProfileModal
  const [detail, setDetail] = useState<MarketPlugin | null>(null)
  const [busy, setBusy] = useState<null | string>(null) // url currently installing from GitHub

  const refreshStoreNames = useCallback(async (): Promise<void> => {
    const r = await window.api.plugins.list()
    if (r.ok) setStoreNames(new Set(r.value.map(p => p.name)))
  }, [])

  const load = useCallback(async (stateOverride = srcState): Promise<void> => {
    setLoading(true)
    setError('')
    const r = await window.api.market.list({ source: stateOverride })
    setLoading(false)
    if (!r.ok) { setError(apiErrorText(r)); return }
    setCatalog(r.value)
  }, [srcState])

  // Fetch the persisted route once, then load the catalog.
  useEffect(() => {
    void (async () => {
      const s = await window.api.market.source()
      if (s.ok) {
        setSrcState(s.value)
        setCustomUrl(s.value.url)
        await load(s.value)
      }
    })()
    void refreshStoreNames()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const applySource = async (): Promise<void> => {
    const next: MarketSourceState = { source: srcState.source, url: customUrl }
    setSavingSource(true)
    const r = await window.api.market.setSource(next)
    setSavingSource(false)
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    if (!r.value) { void message.error(t('plugin.market.invalidUrl')); return }
    setSrcState(next)
    await load(next)
    void message.success(t('plugin.market.sourceSaved'))
  }

  const categories = useMemo(() => {
    const m = catalog?.categories
    if (m == null) return []
    return Object.entries(m).map(([id, labels]) => ({ id, label: labels?.[lang] ?? labels?.en ?? id }))
  }, [catalog, lang])

  const catLabel = (id: string): string => {
    const hit = categories.find(c => c.id === id)
    return hit?.label ?? id
  }

  const rows = useMemo(() => {
    if (catalog === null) return []
    const needle = q.trim().toLowerCase()
    let out = catalog.plugins
    if (category !== '') out = out.filter(p => p.category === category)
    if (needle !== '') {
      out = out.filter(p =>
        p.name.toLowerCase().includes(needle) ||
        p.owner.toLowerCase().includes(needle) ||
        (p.npm ?? '').toLowerCase().includes(needle) ||
        Object.values(p.description ?? {}).some(d => d.toLowerCase().includes(needle)),
      )
    }
    const numKey = (p: MarketPlugin): number | null | undefined => sort === 'stars' ? p.stars : p.downloads
    return [...out].sort((a, b) => {
      if (sort === 'newest') return String(b.added ?? '').localeCompare(String(a.added ?? ''))
      const av = numKey(a)
      const bv = numKey(b)
      const an = av === null || av === undefined
      const bn = bv === null || bv === undefined
      if (an && bn) return 0
      if (an) return 1
      if (bn) return -1
      return bv - av
    })
  }, [catalog, category, q, sort])

  const descOf = (p: MarketPlugin): string => p.description?.[lang] ?? p.description?.en ?? ''
  const hasNpm = (p: MarketPlugin): boolean => p.npm !== undefined && p.npm !== null

  const downloadFromGitHub = async (p: MarketPlugin): Promise<void> => {
    setBusy(p.url)
    try {
      const r = await window.api.market.resolve(p.url)
      if (!r.ok) { void message.error(apiErrorText(r)); return }
      if (r.value.spec === null) { void message.error(t('plugin.market.noSource')); return }
      const add = await window.api.plugins.add(r.value.spec)
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
        title={t('plugin.market.title', { count: catalog?.count ?? 0 })}
        description={t('plugin.market.desc')}
      />

      {/* Loading-route picker (user-selectable pipeline). */}
      <Panel title={t('plugin.market.sourceLabel')}>
        <Space wrap style={{ width: '100%' }} align="center">
          <Select
            value={srcState.source}
            onChange={v => setSrcState(prev => ({ ...prev, source: v as MarketSourceState['source'] }))}
            style={{ minWidth: 200 }}
            options={[
              { value: 'official', label: t('plugin.market.source.official') },
              { value: 'custom', label: t('plugin.market.source.custom') },
            ]}
          />
          {srcState.source === 'custom' && (
            <Input
              allowClear
              value={customUrl}
              onChange={e => setCustomUrl(e.target.value)}
              placeholder={t('plugin.market.customUrlPlaceholder')}
              style={{ minWidth: 320, maxWidth: 480 }}
            />
          )}
          <Button loading={savingSource} onClick={() => void applySource()} disabled={srcState.source === 'custom' && !customUrl.trim()}>
            {t('common.save')}
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => void load()} disabled={loading}>
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
          action={<Button size="small" onClick={() => void load()}>{t('common.retry')}</Button>}
        />
      )}

      {catalog !== null && (
        <Panel>
          <Space wrap style={{ marginBottom: token.paddingSM }}>
            <Input
              allowClear
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder={t('plugin.market.searchPlaceholder')}
              style={{ maxWidth: 320 }}
            />
            <Select
              value={category}
              onChange={setCategory}
              style={{ minWidth: 150 }}
              options={[
                { value: '', label: t('plugin.market.categoryAll') },
                ...categories.map(c => ({ value: c.id, label: c.label })),
              ]}
            />
            <Select
              value={sort}
              onChange={v => setSort(v as MarketSort)}
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
                const inStore = p.npm !== undefined && p.npm !== null && storeNames.has(p.npm)
                return (
                  <List.Item
                    style={{ cursor: 'pointer' }}
                    onClick={() => setDetail(p)}
                    actions={[
                      inStore
                        ? <Button size="small" type="primary" onClick={e => { e.stopPropagation(); setInstallPkg(p.npm!) }}>{t('plugin.market.installToProfile')}</Button>
                        : hasNpm(p)
                          ? <Button size="small" disabled={busy !== null} onClick={e => { e.stopPropagation(); setDlPkg(p.npm!) }}>{t('plugin.market.download')}</Button>
                          : <Button size="small" loading={busy === p.url} onClick={e => { e.stopPropagation(); void downloadFromGitHub(p) }}>{t('plugin.market.downloadGitHub')}</Button>,
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
        onClose={() => setInstallPkg(null)}
        onDone={async () => { await refreshStoreNames() }}
      />
    </Space>
  )
}