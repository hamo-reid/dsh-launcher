/**
 * The dsh home structure browser.
 *
 * One level at a time: opening a folder is its own `home:browse` call, so a deep
 * tree (`profiles` â†?a profile â†?`node_modules` â†?`.pnpm` â†?â€? costs only the
 * levels someone actually opened. Read-only, like the usage panel it hangs off,
 * and with no "open folder" of its own â€?the panel above already offers that for
 * the home itself, and a second button on every level is noise.
 *
 * The presentational half (`BrowseLevel`) is exported so a render test can pin
 * what a level says without a portal: the numbers, the "largest first, top N
 * only" caveat, and the tags that keep a hard-linked `node_modules` from reading
 * as the home's own bytes.
 */

import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Space, Spin, Tag, Tooltip, theme, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../../lib/ipc.ts'
import { fmtBytes } from '../../lib/format.ts'
import ScrollModal from '../../components/ScrollModal.tsx'
import { MODAL } from '../../theme.ts'
import type { HomeBrowseResult, HomeEntryUsage } from '../../../../shared/types.ts'

/** A child's path relative to the home: `/`-joined, '' for the home root. */
export function joinRel(relPath: string, name: string): string {
  return relPath === '' ? name : `${relPath}/${name}`
}

/** The breadcrumb of a relative path, each step carrying the path that reaches it. */
export function crumbsOf(relPath: string): { label: string; rel: string }[] {
  const parts = relPath.split('/').filter(part => part !== '')
  return parts.map((label, index) => ({ label, rel: parts.slice(0, index + 1).join('/') }))
}

/** One row: name, the tags that qualify its size, its bytes and its file count. */
function BrowseRow({ entry, onOpen }: { entry: HomeEntryUsage; onOpen: (name: string) => void }): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [hovered, setHovered] = useState(false)
  const dir = entry.kind === 'dir'
  // A `node_modules` (or a profile's) row is the plugin store's bytes wearing the
  // home's name; say so instead of letting the number stand as the home's own.
  const fromStore = entry.nodeModulesBytes !== undefined && entry.nodeModulesBytes > 0
  return (
    <div
      // Same contract as the library picker rows: a folder is a control, so it
      // must be reachable and activatable from the keyboard, not only by mouse.
      role={dir ? 'button' : undefined}
      tabIndex={dir ? 0 : undefined}
      onClick={dir ? () => onOpen(entry.name) : undefined}
      onKeyDown={dir
        ? event => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(entry.name) }
        }
        : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 8px',
        borderRadius: token.borderRadius,
        cursor: dir ? 'pointer' : 'default',
        background: hovered && dir ? token.colorFillQuaternary : undefined,
      }}
    >
      <Typography.Text
        style={{ flex: 1, minWidth: 0, fontSize: token.fontSizeSM }}
        ellipsis={{ tooltip: entry.name }}
      >
        {entry.name}{dir ? '/' : ''}
      </Typography.Text>
      {fromStore && (
        <Tooltip title={t('dsh.browse.fromStoreTip')}>
          <Tag style={{ marginInlineEnd: 0 }}>{t('dsh.browse.fromStore')}</Tag>
        </Tooltip>
      )}
      {!fromStore && entry.sharedBytes > 0 && (
        <Tooltip title={t('dsh.browse.sharedTip')}>
          <Tag style={{ marginInlineEnd: 0 }}>{t('dsh.browse.shared')}</Tag>
        </Tooltip>
      )}
      <Typography.Text style={{ width: 84, textAlign: 'right', fontSize: token.fontSizeSM, fontVariantNumeric: 'tabular-nums' }}>
        {fmtBytes(entry.apparentBytes)}
      </Typography.Text>
      <Typography.Text style={{ width: 56, textAlign: 'right', fontSize: token.fontSizeSM, color: token.colorTextTertiary, fontVariantNumeric: 'tabular-nums' }}>
        {entry.files}
      </Typography.Text>
    </div>
  )
}

/** Everything about one level: crumbs, path, totals, rows and the caveats.
 * Presentational, so it can be server-rendered in a test. */
export function BrowseLevel({ data, onNavigate }: {
  data: HomeBrowseResult
  onNavigate: (relPath: string) => void
}): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const crumbs = crumbsOf(data.relPath)
  return (
    <div>
      {/* Breadcrumb: the home root, then one step per segment. The LAST one is
          where we already are, so only the ancestors are clickable. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
        <Typography.Link onClick={() => onNavigate('')} strong>{t('dsh.browse.root')}</Typography.Link>
        {crumbs.map((crumb, index) => (
          <span key={crumb.rel} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Typography.Text type="secondary">/</Typography.Text>
            {index === crumbs.length - 1
              ? <Typography.Text strong>{crumb.label}</Typography.Text>
              : <Typography.Link onClick={() => onNavigate(crumb.rel)}>{crumb.label}</Typography.Link>}
          </span>
        ))}
      </div>

      {/* The level's own path, on a line of its own: laid out inline it glued
          itself to the crumb above and read as one unbroken string. */}
      <Typography.Text
        type="secondary"
        style={{ fontSize: token.fontSizeSM, display: 'block', marginTop: 4, wordBreak: 'break-all' }}
      >
        {data.path}
      </Typography.Text>

      <div style={{ marginTop: token.paddingSM, fontSize: token.fontSizeSM, color: token.colorTextSecondary }}>
        {t('dsh.browse.totals', { size: fmtBytes(data.apparentBytes), files: data.files })}
        {data.sharedBytes > 0 && (
          <span style={{ color: token.colorTextTertiary }}>
            {' Â· '}{t('dsh.usage.shared', { size: fmtBytes(data.sharedBytes) })}
          </span>
        )}
      </div>

      {/* Column captions, so a bare number is never ambiguous. */}
      <div style={{
        display: 'flex',
        gap: 8,
        padding: '4px 8px',
        marginTop: token.paddingSM,
        borderBottom: `1px solid ${token.colorSplit}`,
      }}>
        <Typography.Text style={{ flex: 1, fontSize: token.fontSizeSM, color: token.colorTextTertiary }}>{t('dsh.browse.colName')}</Typography.Text>
        <Typography.Text style={{ width: 84, textAlign: 'right', fontSize: token.fontSizeSM, color: token.colorTextTertiary }}>{t('dsh.browse.colSize')}</Typography.Text>
        <Typography.Text style={{ width: 56, textAlign: 'right', fontSize: token.fontSizeSM, color: token.colorTextTertiary }}>{t('dsh.browse.colFiles')}</Typography.Text>
      </div>

      {data.entries.length === 0
        // A budget that stopped before the first child has NOT shown an empty
        // folder â€?the warning below is the honest statement.
        ? (data.truncated ? null : <div style={{ padding: 16, color: token.colorTextTertiary }}>{t('dsh.browse.empty')}</div>)
        : data.entries.map(entry => (
          <BrowseRow key={entry.name} entry={entry} onOpen={name => onNavigate(joinRel(data.relPath, name))} />
        ))}

      {data.omitted > 0 && (
        <div style={{ marginTop: token.paddingSM, fontSize: token.fontSizeSM, color: token.colorTextTertiary }}>
          {t('dsh.browse.omitted', { count: data.omitted })}
        </div>
      )}
      {data.errors > 0 && (
        <Alert type="warning" showIcon style={{ marginTop: token.paddingSM }} title={t('dsh.usage.unreadable', { count: data.errors })} />
      )}
      {data.truncated && (
        <Alert type="warning" showIcon style={{ marginTop: token.paddingSM }} title={t('dsh.usage.truncated')} />
      )}
      {!data.exists && (
        <Alert type="warning" showIcon style={{ marginTop: token.paddingSM }} title={t('dsh.browse.missing')} />
      )}
    </div>
  )
}

interface HomeBrowseModalProps {
  /** The managed home to browse (absolute). */
  home: string
  open: boolean
  onClose: () => void
}

export default function HomeBrowseModal({ home, open, onClose }: HomeBrowseModalProps): JSX.Element {
  const { t } = useTranslation()
  // Which level we are looking at, relative to the home ('' = the root).
  const [relPath, setRelPath] = useState('')
  const [data, setData] = useState<HomeBrowseResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // Levels already measured in this dialog. Going back up is the most common
  // move in a browser, and re-walking a folder costs as much as the first time
  // (a `node_modules` level is ~600 ms), so a level is measured once per open.
  // Cleared on close: the numbers must not outlive the session that produced them.
  const cache = useRef(new Map<string, HomeBrowseResult>())

  // Reset on close rather than on open: resetting on open would fire one fetch
  // with the previous folder (`relPath` state is still stale in that render) and
  // flash a level the person did not ask for.
  const close = (): void => {
    setRelPath('')
    setData(null)
    setError('')
    cache.current.clear()
    onClose()
  }

  useEffect(() => {
    if (!open) return
    setError('')
    const hit = cache.current.get(relPath)
    if (hit !== undefined) {
      setData(hit)
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    void window.api.dsh.browseHome(home, relPath).then((result) => {
      if (!alive) return
      setLoading(false)
      if (!result.ok) { setError(apiErrorText(result)); return }
      cache.current.set(relPath, result.value)
      setData(result.value)
    })
    return () => { alive = false }
  }, [open, home, relPath])

  return (
    <ScrollModal
      title={t('dsh.browse.title')}
      open={open}
      onCancel={close}
      width={MODAL.wide}
      bodyMax="lg"
      maskClosable
      footer={<Button onClick={close}>{t('common.close')}</Button>}
    >
      {error !== '' && <Alert type="error" showIcon title={error} />}
      {loading && (
        <Space>
          <Spin size="small" />
          <span>{t('dsh.browse.loading')}</span>
        </Space>
      )}
      {!loading && data !== null && <BrowseLevel data={data} onNavigate={setRelPath} />}
    </ScrollModal>
  )
}
