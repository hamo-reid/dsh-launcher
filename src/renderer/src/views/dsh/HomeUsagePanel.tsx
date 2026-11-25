/**
 * Disk usage of the SELECTED dsh's home �?the DSH page's "what is eating my disk"
 * block.
 *
 * Manual, never automatic: measuring walks every profile's `node_modules`, so it
 * runs only when asked. One dsh at a time, too: the page measures the home of the
 * install the left rail has selected, not every managed install on the machine.
 *
 * Two numbers are shown, and they are not interchangeable:
 *
 *  - `reclaimableBytes` �?bytes whose EVERY hard link lives inside that home: what
 *    deleting it actually frees. This is the headline.
 *  - `apparentBytes` �?the raw sum a file explorer shows. It counts one package
 *    body once per link (pnpm hard-links it into the store, the dsh install and
 *    every profile), so it dwarfs the number above.
 *
 * Nothing here measures the dsh install itself or the plugin store: the store is
 * where a profile's `node_modules` bytes really live, which is what the single
 * note line says instead of pretending the home owns them.
 */

import { useEffect, useState } from 'react'
import { Alert, Button, Segmented, Space, Spin, Tag, theme, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../../lib/ipc.ts'
import { fmtBytes } from '../../lib/format.ts'
import Panel from '../../components/Panel.tsx'
import HomeBrowseModal from './HomeBrowseModal.tsx'
import HomeUsagePie from './HomeUsagePie.tsx'
import type { DshEntry, DshHomeUsage, HomeEntryUsage } from '../../../../shared/types.ts'

/** How the size breakdown is drawn. */
type UsageView = 'bars' | 'pie'

// ── owner naming ────────────────────────────────────────────────────────────

/**
 * Names of the dsh that share a home, for the block's heading.
 *
 * A measured row can outlive the dsh it was measured for: the registry changes
 * while a completed scan sits on screen. Falling back to the id would print an
 * executable PATH as the heading, so an id the registry no longer knows is
 * dropped �?the home path underneath still says which folder this is.
 * @param ids - the dsh ids the scan recorded for this home.
 * @param dshes - the live registry.
 */
export function ownerNames(ids: readonly string[], dshes: readonly DshEntry[]): string {
  return ids
    .map(id => dshes.find(d => d.id === id)?.name)
    .filter((name): name is string => name !== undefined && name !== '')
    .join(', ')
}

/** A path compared the way two spellings of one directory should be. */
function samePath(left: string, right: string): boolean {
  return left.replace(/[\\/]+$/, '').toLowerCase() === right.replace(/[\\/]+$/, '').toLowerCase()
}

// ── breakdown rows ──────────────────────────────────────────────────────────

/** One measured top-level entry: name, share bar, size, percentage. */
function UsageRow({ entry, total }: { entry: HomeEntryUsage; total: number }): JSX.Element {
  const { token } = theme.useToken()
  const share = total > 0 ? Math.round((entry.apparentBytes / total) * 100) : 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
      <Typography.Text
        style={{ width: 132, minWidth: 0, fontSize: token.fontSizeSM }}
        ellipsis={{ tooltip: entry.name }}
      >
        {entry.name}
      </Typography.Text>
      <div style={{ flex: 1, minWidth: 48, height: 6, borderRadius: 3, background: token.colorFillSecondary }}>
        <div style={{
          height: '100%',
          width: `${String(Math.max(share, entry.apparentBytes > 0 ? 1 : 0))}%`,
          borderRadius: 3,
          background: entry.sharedBytes > 0 ? token.colorPrimaryBorder : token.colorPrimary,
        }} />
      </div>
      <Typography.Text style={{ width: 82, textAlign: 'right', fontSize: token.fontSizeSM, fontVariantNumeric: 'tabular-nums' }}>
        {fmtBytes(entry.apparentBytes)}
      </Typography.Text>
      <Typography.Text style={{ width: 56, textAlign: 'right', fontSize: token.fontSizeSM, color: token.colorTextTertiary, fontVariantNumeric: 'tabular-nums' }}>
        {String(share)}%
      </Typography.Text>
    </div>
  )
}

/** One home: owners, the two totals, and the breakdown in the chosen shape.
 * Exported so a render test can pin the numbers it publishes. */
export function HomeBlock({ row, owners, view, first = false }: {
  row: DshHomeUsage
  owners: string
  view: UsageView
  /** The first block in the panel carries no divider above it. */
  first?: boolean
}): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [browseOpen, setBrowseOpen] = useState(false)
  // Bytes under a profile's node_modules are the plugin store's, hard-linked in.
  const nodeModules = row.entries.find(entry => entry.role === 'profiles')?.nodeModulesBytes

  // One line for every caveat, instead of a paragraph per fact.
  const notes = [
    row.sharedBytes > 0 ? t('dsh.usage.shared', { size: fmtBytes(row.sharedBytes) }) : '',
    nodeModules !== undefined && nodeModules > 0 ? t('dsh.usage.nodeModules', { size: fmtBytes(nodeModules) }) : '',
    new Date(row.scannedAt).toLocaleTimeString(),
  ].filter(note => note !== '')

  return (
    <div style={{
      marginTop: first ? 0 : token.paddingSM,
      paddingTop: first ? 0 : token.paddingSM,
      borderTop: first ? undefined : `1px solid ${token.colorSplit}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {owners !== '' && <Typography.Text strong>{owners}</Typography.Text>}
        {!row.exists && <Tag color="warning">{t('dsh.usage.missing')}</Tag>}
        <div style={{ flex: 1 }} />
        <Button size="small" onClick={() => setBrowseOpen(true)}>{t('dsh.browse.open')}</Button>
      </div>

      <Typography.Text
        type="secondary"
        style={{ fontSize: token.fontSizeSM, display: 'block', wordBreak: 'break-all' }}
      >
        {row.home}
      </Typography.Text>

      {row.exists && (
        <>
          <Space size={12} wrap style={{ marginTop: 8 }}>
            <Typography.Text strong style={{ fontVariantNumeric: 'tabular-nums' }}>
              {t('dsh.usage.reclaimable', { size: fmtBytes(row.reclaimableBytes) })}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM, fontVariantNumeric: 'tabular-nums' }}>
              {t('dsh.usage.apparent', { size: fmtBytes(row.apparentBytes) })}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              {t('dsh.usage.files', { count: row.files })}
            </Typography.Text>
          </Space>

          <div style={{ marginTop: token.paddingSM }}>
            {view === 'pie'
              ? <HomeUsagePie entries={row.entries} />
              : row.entries.map(entry => <UsageRow key={entry.name} entry={entry} total={row.apparentBytes} />)}
          </div>

          {notes.length > 0 && (
            <div style={{ marginTop: 8, fontSize: token.fontSizeSM, color: token.colorTextTertiary }}>
              {notes.join(' · ')}
            </div>
          )}

          {row.errors > 0 && (
            <Alert type="warning" showIcon style={{ marginTop: 8 }} title={t('dsh.usage.unreadable', { count: row.errors })} />
          )}
          {row.truncated && (
            <Alert type="warning" showIcon style={{ marginTop: 8 }} title={t('dsh.usage.truncated')} />
          )}
        </>
      )}
      <HomeBrowseModal home={row.home} open={browseOpen} onClose={() => setBrowseOpen(false)} />
    </div>
  )
}

// ── the panel ──────────────────────────────────────────────────────────────

interface HomeUsagePanelProps {
  /** The registered dsh, so a shared home can name every owner. */
  dshes: readonly DshEntry[]
  /** The page's current selection �?the dsh this panel measures. */
  selectedId?: string
}

export default function HomeUsagePanel({ dshes, selectedId }: HomeUsagePanelProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [running, setRunning] = useState(false)
  // ONE measurement, for the selected dsh.
  const [usage, setUsage] = useState<DshHomeUsage | null>(null)
  const [view, setView] = useState<UsageView>('bars')
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState('')
  // The selected dsh is a system/global install: its home is the host's, not a
  // launcher cost, so there is nothing to measure �?and saying so is the answer.
  const [notManaged, setNotManaged] = useState(false)

  const selected = dshes.find(entry => entry.id === selectedId)

  // A measurement belongs to ONE dsh: switching must not leave the previous
  // dsh's numbers under the next one's heading.
  useEffect(() => {
    setUsage(null)
    setError('')
    setNotManaged(false)
  }, [selectedId])

  // The home can change under a completed scan (`dsh:setHome`), and this panel
  // never re-scans on its own �?so say when the number on screen describes a
  // different folder than the one the dsh now points at.
  const stale = usage !== null && selected !== undefined && !samePath(usage.home, selected.home)

  const run = async (): Promise<void> => {
    if (selectedId === undefined) return
    setRunning(true)
    setError('')
    setNotManaged(false)
    setUsage(null)
    try {
      // Cheap: settings only, no walking. It answers "is this dsh managed, and
      // which home does it own" in one step, so the page can explain a refusal
      // instead of showing zeros.
      const targets = await window.api.dsh.homeTargets()
      if (!targets.ok) { setError(apiErrorText(targets)); return }
      const target = targets.value.find(entry => entry.dshIds.includes(selectedId))
      if (target === undefined) { setNotManaged(true); return }
      setPending(target.home)
      const result = await window.api.dsh.homeScan(target.home)
      if (!result.ok) { setError(apiErrorText(result)); return }
      setUsage(result.value)
    } catch (thrown) {
      // The wrapper turns a throw into an envelope, so this is belt-and-braces:
      // an unexpected rejection must still release the button instead of leaving
      // the panel spinning forever.
      setError(thrown instanceof Error ? thrown.message : String(thrown))
    } finally {
      setPending(null)
      setRunning(false)
    }
  }

  return (
    <Panel
      title={t('dsh.usage.title')}
      extra={(
        <Space size={8}>
          {usage !== null && (
            <Segmented
              size="small"
              value={view}
              onChange={value => setView(value as UsageView)}
              options={[
                { value: 'bars', label: t('dsh.usage.viewBars') },
                { value: 'pie', label: t('dsh.usage.viewPie') },
              ]}
            />
          )}
          <Button
            size="small"
            loading={running}
            disabled={selectedId === undefined}
            onClick={() => void run()}
          >
            {usage === null ? t('dsh.usage.calc') : t('dsh.usage.recalc')}
          </Button>
        </Space>
      )}
    >
      {error !== '' && <Alert type="error" showIcon title={error} />}

      {notManaged && <Alert type="info" showIcon title={t('dsh.usage.notManaged')} />}

      {stale && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 8 }}
          title={t('dsh.usage.stale')}
          action={<Button size="small" onClick={() => void run()}>{t('dsh.usage.recalc')}</Button>}
        />
      )}

      {usage === null && !running && error === '' && !notManaged && (
        <div style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM }}>{t('dsh.usage.idle')}</div>
      )}

      {usage !== null && (
        <HomeBlock
          row={usage}
          view={view}
          first
          owners={ownerNames(usage.dshIds, dshes)}
        />
      )}

      {pending !== null && (
        <div style={{ marginTop: token.paddingSM, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Spin size="small" />
          <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM, wordBreak: 'break-all' }}>
            {t('dsh.usage.measuringHome', { home: pending })}
          </Typography.Text>
        </div>
      )}
    </Panel>
  )
}
