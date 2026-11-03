/**
 * The download centre: a live npm search (debounced) with paged "load more" and an
 * in-store marker per hit — or, when the person picks the private source, a
 * by-name lookup against that source.
 *
 * The split exists because the two operations are not the same thing. Keyword
 * search is discovery and only the public catalogue answers it; a private
 * registry is under no obligation to implement `/-/v1/search`, and the ones that
 * do not answer 404. So the source is an explicit choice (a dropdown), and the
 * input changes meaning with it instead of one setting silently deciding for the
 * user.
 *
 * The query, the result pages and the paging cursor are all private to this view.
 * It mounts only while the download tab is active, which is what used to be the
 * `view !== 'download'` guard on its search effect.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Empty, Input, Select, Space, Skeleton, Tag, theme, message } from 'antd'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../../lib/ipc.ts'
import { fmtDate } from '../../lib/format.ts'
import Panel from '../../components/Panel.tsx'
import SearchInput from '../../components/SearchInput.tsx'
import SectionHeading from '../../components/SectionHeading.tsx'
import Toolbar from '../../components/Toolbar.tsx'
import { latestPackageVersion } from '../../../../shared/version.ts'
import type { NpmSearchHit, RegistryEntryView, RegistrySource } from '../../../../shared/types.ts'

const PAGE_SIZE = 25

interface Props {
  /** A search needs a store to download into. */
  dirMissing: boolean
  /** Archived versions per plugin, so a hit can say it is already in the store. */
  storeMap: Map<string, string[]>
  /** The configured registries, in display order. Empty hides the source choice
   * entirely: offering a registry that does not exist is a menu item that can
   * only fail. */
  registries: RegistryEntryView[]
  onDownloadVersion: (name: string, source: RegistrySource) => void
  onInstallToProfile: (name: string) => void
}


export default function PluginsDownloadView(p: Props): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const hasPrivate = p.registries.length > 0
  const [source, setSource] = useState<RegistrySource>('public')
  const [query, setQuery] = useState('dsh')
  /** The private-source name box. Kept apart from `query` so switching sources
   * does not carry a keyword into a field that resolves a package name. */
  const [lookupName, setLookupName] = useState('')
  const [hits, setHits] = useState<NpmSearchHit[]>([])
  const [total, setTotal] = useState(0)
  const [searching, setSearching] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [lookupError, setLookupError] = useState('')
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
    if (source !== 'public') return
    const timer = setTimeout(() => void runSearch(query, false), 300)
    return () => clearTimeout(timer)
  }, [query, source, runSearch])

  /** Resolve one name against the private source. There is no list to page
   * through — a private registry exposes packages by name, not by keyword — so
   * the answer is one row (or one error). */
  const runLookup = useCallback(async (): Promise<void> => {
    const name = lookupName.trim()
    setLookupError('')
    if (name === '') { setHits([]); setTotal(0); return }
    setSearching(true)
    const r = await window.api.plugins.pkgVersions(name, source)
    setSearching(false)
    if (!r.ok) {
      setHits([])
      setTotal(0)
      setLookupError(apiErrorText(r))
      return
    }
    const latest = latestPackageVersion(r.value)
    setHits([{ name, description: '', version: latest ?? '' }])
    setTotal(1)
  }, [lookupName])

  const switchSource = (next: RegistrySource): void => {
    setSource(next)
    setHits([])
    setTotal(0)
    setLookupError('')
    fromRef.current = 0
  }

  /** The entry the dropdown currently asserts, when it is one of ours. */
  const chosen = source.startsWith('reg:')
    ? p.registries.find(entry => `reg:${entry.id}` === source)
    : undefined

  /** True when the name would NOT be installed from the chosen registry: the
   * scope routing decides installs, and an explicit lookup does not change it.
   * An unscoped entry IS the fallback, so it owns unclaimed names by definition. */
  const outsideScope = (name: string): boolean => {
    const scope = chosen?.scope
    if (scope === undefined) return false
    return !name.toLowerCase().startsWith(`${scope.toLowerCase()}/`)
  }

  return (
    <Space orientation="vertical" style={{ width: '100%' }} size="middle">
      <SectionHeading title={t('plugin.download.title')} description={t('plugin.download.desc')} />
      {p.dirMissing && <Alert type="warning" showIcon title={t('plugin.dirMissingDownload')} />}
      <Panel pad={false}>
        <Toolbar>
          {hasPrivate && (
            <Select
              value={source}
              onChange={value => switchSource(value as RegistrySource)}
              style={{ width: 200 }}
              aria-label={t('plugin.download.source.label')}
              options={[
                { value: 'public', label: t('plugin.download.source.public') },
                // Only entries with a scope: one without owns no package, so
                // offering it here would promise a lookup that cannot install.
                ...p.registries
                  .filter(entry => entry.scope !== undefined)
                  .map(entry => ({
                    value: `reg:${entry.id}` as RegistrySource,
                    label: t('plugin.download.source.scoped', { label: entry.label, scope: entry.scope }),
                  })),
              ]}
            />
          )}
          {source === 'public' ? (
            <SearchInput
              value={query}
              onChange={setQuery}
              onPressEnter={() => void runSearch(query, false)}
              placeholder={t('plugin.download.searchPlaceholder')}
              loading={searching}
              ariaLabel={t('plugin.download.searchPlaceholder')}
              style={{ minWidth: 240, maxWidth: 480 }}
            />
          ) : (
            <Space.Compact style={{ minWidth: 240, maxWidth: 480, width: '100%' }}>
              <Input
                value={lookupName}
                onChange={e => setLookupName(e.target.value)}
                onPressEnter={() => void runLookup()}
                placeholder={t('plugin.download.lookupPlaceholder')}
                aria-label={t('plugin.download.lookupPlaceholder')}
                autoComplete="off"
              />
              <Button loading={searching} disabled={lookupName.trim() === ''} onClick={() => void runLookup()}>
                {t('plugin.download.lookup')}
              </Button>
            </Space.Compact>
          )}
        </Toolbar>

        <div style={{ padding: token.padding }}>
          {source !== 'public' && (
            <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, marginBottom: token.paddingSM }}>
              {t('plugin.download.lookupHint')}
            </div>
          )}
          {lookupError !== '' && <Alert type="error" showIcon title={lookupError} style={{ marginBottom: token.paddingSM }} />}

          {total > 0 && hits.length > 0 && source === 'public' && (
            <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, marginBottom: token.paddingSM }}>
              {t('plugin.download.results', { total, loaded: hits.length })}
            </div>
          )}

          {searching ? (
            <Space orientation="vertical" style={{ width: '100%' }} size="middle">
              {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} active title paragraph={{ rows: 2 }} />)}
            </Space>
          ) : hits.length === 0 ? (
            // The empty slot `List` used to render for us.
            <Empty description={source !== 'public'
              ? t('plugin.download.emptyLookup')
              : (query === 'dsh' ? t('plugin.download.emptyHint') : t('plugin.download.noMatch'))} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {hits.map((hit) => {
                const inStore = p.storeMap.has(hit.name)
                const warn = source !== 'public' && outsideScope(hit.name)
                return (
                  <div
                    key={hit.name}
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: token.padding,
                      padding: `${String(token.paddingSM)}px 0`,
                      borderBottom: `1px solid ${token.colorSplit}`,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div>
                        {hit.name}
                        {inStore && <Tag color="blue" style={{ marginInlineStart: 6 }}>{t('plugin.download.inStore')}</Tag>}
                        {hit.version !== '' && <Tag style={{ marginInlineStart: 6 }}>{hit.version}</Tag>}
                      </div>
                      {hit.description !== '' && (
                        <div style={{ wordBreak: 'break-word', color: token.colorTextSecondary, marginTop: 2 }}>{hit.description}</div>
                      )}
                      {warn && (
                        // The lookup honoured the choice; the INSTALL cannot, because
                        // pnpm follows the scope. Saying so here is the only place the
                        // mismatch can be caught before it becomes a surprise.
                        <div style={{ color: token.colorWarning, fontSize: token.fontSizeSM, marginTop: 4 }}>
                          {t('plugin.download.outOfScope', { scope: chosen?.scope ?? '' })}
                        </div>
                      )}
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
                    </div>
                    <Space size={8} style={{ flexShrink: 0 }}>
                      <Button size="small" disabled={p.dirMissing} onClick={() => p.onDownloadVersion(hit.name, source)}>{t('plugin.version.download')}</Button>
                      {inStore && <Button key="install" type="primary" size="small" onClick={() => p.onInstallToProfile(hit.name)}>{t('plugin.download.installToProfile')}</Button>}
                    </Space>
                  </div>
                )
              })}
            </div>
          )}

          {!searching && source === 'public' && hits.length > 0 && hits.length < total && (
            <div style={{ textAlign: 'center', marginTop: token.padding }}>
              <Button onClick={() => void runSearch(query, true)} loading={loadingMore}>{t('plugin.download.loadMore')}</Button>
            </div>
          )}
        </div>
      </Panel>
    </Space>
  )
}
