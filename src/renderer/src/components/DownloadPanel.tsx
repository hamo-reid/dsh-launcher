import { useState, type CSSProperties } from 'react'
import { Button, Drawer, Empty, Space, Spin, Tag, Typography } from 'antd'
import { CloudDownloadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { usePluginDownloads } from '../hooks/usePluginDownloads.ts'
import type { DownloadStatus } from '../../../shared/types.ts'

const STATUS_COLOR: Record<DownloadStatus, string> = {
  running: 'processing',
  done: 'success',
  failed: 'error',
  cancelled: 'default',
}

/** Global download entrance: a header-side button (only while downloads exist)
 * that opens a Drawer sliding in from the right with every live session — each
 * cancellable — plus the store "cleanup leftovers" affordance. Rendered in the
 * app header's right edge, across all tabs. */
export default function DownloadPanel() {
  const { t } = useTranslation()
  const { downloads, cancel } = usePluginDownloads()
  const [open, setOpen] = useState(false)
  const running = downloads.some(d => d.status === 'running')

  // No sessions at all → the entrance stays hidden.
  if (downloads.length === 0) return null

  return (
    <>
      <Button
        type="text"
        icon={running ? <Spin size="small" /> : <CloudDownloadOutlined />}
        onClick={() => setOpen(true)}
        style={{ WebkitAppRegion: 'no-drag', height: 32, display: 'inline-flex', alignItems: 'center' } as CSSProperties}
        title={t('download.entrance.title', { count: downloads.length })}
      >
        <Typography.Text strong style={{ fontSize: 12 }}>{downloads.length}</Typography.Text>
      </Button>
      <Drawer
        title={running ? <Space size={6}><Spin size="small" />{t('download.panel.title', { count: downloads.length })}</Space> : t('download.panel.title', { count: downloads.length })}
        placement="right"
        width={420}
        open={open}
        onClose={() => setOpen(false)}
      >
        {downloads.length === 0 ? (
          <Empty description={t('download.panel.empty')} style={{ marginTop: 48 }} />
        ) : (
          <Space direction="vertical" style={{ width: '100%' }} size="small">
            {downloads.map(d => (
              <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', borderRadius: 6 }}>
                <span style={{ fontWeight: 500, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>{d.name}</span>
                <span
                  style={{ color: 'inherit', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}
                  title={d.source}
                >
                  {d.source}
                </span>
                <Tag color={STATUS_COLOR[d.status]} style={{ marginInlineEnd: 0, flexShrink: 0 }}>{t(`download.status.${d.status}`)}</Tag>
                {d.status === 'running' && (
                  <Button size="small" danger type="text" style={{ flexShrink: 0 }} onClick={() => { void cancel(d.id) }}>
                    {t('download.panel.cancel')}
                  </Button>
                )}
              </div>
            ))}
          </Space>
        )}
      </Drawer>
    </>
  )
}