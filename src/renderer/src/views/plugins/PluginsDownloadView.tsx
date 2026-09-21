/**
 * The download centre: a live npm search (debounced) with paged "load more" and an
 * in-store marker per hit.
 *
 * The query, the result pages and the paging cursor are all private to this view.
 * It mounts only while the download tab is active, which is what used to be the
 * `view !== 'download'` guard on its search effect — so switching to the tab still
 * searches the current query, and sitting on the overview still searches nothing.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, List, Space, Skeleton, Tag, theme, message } from 'antd'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../../lib/ipc.ts'
import { fmtDate } from '../../lib/format.ts'
import Panel from '../../components/Panel.tsx'
import SearchInput from '../../components/SearchInput.tsx'
import SectionHeading from '../../components/SectionHeading.tsx'
import Toolbar from '../../components/Toolbar.tsx'
import type { NpmSearchHit } from '../../../../shared/types.ts'

const PAGE_SIZE = 25

interface Props {
  /** A search needs a store to download into. */
  dirMissing: boolean
  /** Archived versions per plugin, so a hit can say it is already in the store. */
  storeMap: Map<string, string[]>
  onDownloadVersion: (name: string) => void
  onInstallToProfile: (name: string) => void
}

export default function PluginsDownloadView({ dirMissing, storeMap, onDownloadVersion, onInstallToProfile }: Props): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [query, setQuery] = useState('dsh')
  const [hits, setHits] = useState<NpmSearchHit[]>([])
  const [total, setTotal] = useState(0)
  const [searching, setSearching] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  /** How many hits have been fetched — the cursor for "load more". */
  const fromRef = useRef(0)

  const runSearch = useCallback(async (raw: string, append: boolean): Promise<void> => {
    const q = raw.trim()
    if (q === '') { setHits([]); setTotal(0); fromRef.current = 0; return }
    const start = append ? fromRef.current : 0
    if (append) setLoadingMore(true)
    else setSearching(true)
    const result = await window.api.plugins.search(q, { size: PAGE_SIZE, from: start })
    if (append) setLoadingMore(false)
    else setSearching(false)
    if (!result.ok) { void message.error(apiErrorText(result)); return }
    setHits(prev => (append ? [...prev, ...result.value.hits] : result.value.hits))
    setTotal(result.value.total)
    fromRef.current = start + result.value.hits.length
  }, [])

  // Debounced: typing in the query re-searches, without firing per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => void runSearch(query, false), 300)
    return () => clearTimeout(timer)
  }, [query, runSearch])

  return (
    <Space orientation="vertical" style={{ width: '100%' }} size="middle">
      <SectionHeading title={t('plugin.download.title')} description={t('plugin.download.desc')} />
      {dirMissing && <Alert type="warning" showIcon title={t('plugin.dirMissingDownload')} />}
      <Panel pad={false}>
        <Toolbar>
          <SearchInput
            value={query}
            onChange={setQuery}
            onPressEnter={() => void runSearch(query, false)}
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
                emptyText: query === 'dsh' ? t('plugin.download.emptyHint') : t('plugin.download.noMatch'),
              }}
              renderItem={(hit) => {
                const inStore = storeMap.has(hit.name)
                return (
                  <List.Item
                    actions={[
                      <Button key="dl" size="small" disabled={dirMissing} onClick={() => onDownloadVersion(hit.name)}>{t('plugin.version.download')}</Button>,
                      ...(inStore ? [<Button key="install" type="primary" size="small" onClick={() => onInstallToProfile(hit.name)}>{t('plugin.download.installToProfile')}</Button>] : []),
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
              <Button onClick={() => void runSearch(query, true)} loading={loadingMore}>{t('plugin.download.loadMore')}</Button>
            </div>
          )}
        </div>
      </Panel>
    </Space>
  )
}
