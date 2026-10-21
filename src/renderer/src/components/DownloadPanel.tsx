import { useEffect, useState, type CSSProperties } from 'react'
import { Badge, Button, Drawer, Empty, Spin, Tabs, message } from 'antd'
import { CloudDownloadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useDownloads } from '../hooks/useDownloads.ts'
import { DownloadDetailModal, DownloadRow } from './DownloadReport.tsx'
import { LAYOUT } from '../theme.ts'
import type { DownloadSessionInfo } from '../../../shared/types.ts'

/** Cross the compile-time i18n key check for a key chosen at runtime (the
 * failure classifier's own vocabulary, which comes from the main process). */
type Translate = (key: string, options?: Record<string, string>) => string

/**
 * Global download center: an always-present header entrance (badge with the task
 * count; a spinner while anything runs) that opens a right-side Drawer split into
 * DSH / plugin tabs. Each row shows status + name + a one-line cause when it
 * failed; "详情" opens the full report (`DownloadDetailModal`) — cause, advice,
 * evidence, command and the untruncated log.
 */
export default function DownloadPanel(): JSX.Element {
  const { t } = useTranslation()
  const { downloads, dshDownloads, pluginDownloads, cancel, dismiss, cleanup } = useDownloads()
  const [open, setOpen] = useState(false)
  const [activeTab, setActiveTab] = useState('plugin')
  const [detailId, setDetailId] = useState<string | null>(null)

  // A settled session leaves the live list, so its failure would otherwise be
  // silent — announce it (the retained row is easy to miss with the panel shut).
  // The toast names the cause when there is one; the row and its detail view keep
  // the evidence, so the toast does not need to.
  useEffect(() => window.api.downloads.onSettled(s => {
    if (s.status !== 'failed') return
    const translate = t as unknown as Translate
    const cause = s.failure !== undefined ? translate(s.failure.headlineKey, s.failure.params ?? {}) : s.name
    void message.error(t('download.failed', { name: s.name, cause }))
  }), [t])

  const running = downloads.some(d => d.status === 'running')

  const cleanupLeftovers = async (): Promise<void> => {
    const removed = await cleanup()
    if (removed.length > 0) void message.success(t('download.panel.cleaned', { count: removed.length }))
  }

  const renderList = (list: DownloadSessionInfo[]): JSX.Element =>
    list.length === 0
      ? <Empty description={t('download.panel.empty')} style={{ marginTop: 48 }} />
      : <>{list.map(d => <DownloadRow key={d.id} d={d} onDetail={setDetailId} onCancel={id => void cancel(id)} onDismiss={dismiss} />)}</>

  return (
    <>
      <Badge count={downloads.length} size="small" offset={[-4, 4]}>
        <Button
          type="text"
          icon={running ? <Spin size="small" /> : <CloudDownloadOutlined />}
          onClick={() => setOpen(true)}
          style={{ WebkitAppRegion: 'no-drag', height: 32, width: 34, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' } as CSSProperties}
          title={t('download.entrance.title', { count: downloads.length })}
        />
      </Badge>
      <Drawer
        title={t('download.panel.title', { count: downloads.length })}
        placement="right"
        // Offset this drawer's mask + panel below the app's on-top brand row, so
        // its mask never darkens (nor click-dismisses over) the header while the
        // tab bar below stays normally masked. Official `styles` (not global css)
        // because antd6's mask is position:absolute inside the drawer root.
        styles={{
          mask: { top: LAYOUT.headerHeight },
          wrapper: { top: LAYOUT.headerHeight },
        }}
        open={open}
        onClose={() => setOpen(false)}
      >
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={[
            { key: 'plugin', label: t('download.tab.plugins'), children: renderList(pluginDownloads) },
            { key: 'dsh', label: t('download.tab.dsh'), children: renderList(dshDownloads) },
          ]}
        />
        <div style={{ textAlign: 'right', paddingTop: 12 }}>
          <Button size="small" onClick={() => void cleanupLeftovers()}>{t('download.panel.cleanup')}</Button>
        </div>
      </Drawer>
      <DownloadDetailModal id={detailId} onClose={() => setDetailId(null)} />
    </>
  )
}
