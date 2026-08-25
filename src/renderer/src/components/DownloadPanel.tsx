import { useState, type CSSProperties } from 'react'
import { Badge, Button, Drawer, Empty, Modal, Space, Spin, Tabs, Tag, theme, message } from 'antd'
import {
  CheckCircleFilled, CloseCircleFilled, CloudDownloadOutlined, LoadingOutlined, MinusCircleFilled,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useDownloads } from '../hooks/useDownloads.ts'
import { StepIcon } from './StepIcon.tsx'
import { LAYOUT, MODAL } from '../theme.ts'
import type { DownloadSessionInfo } from '../../../shared/types.ts'

const STATUS_COLOR: Record<DownloadSessionInfo['status'], string> = {
  running: 'processing',
  done: 'success',
  failed: 'error',
  cancelled: 'default',
}

/** Status icon for the leading column: spinner / check / cross / (cancelled) dash. */
function StatusIcon({ status }: { status: DownloadSessionInfo['status'] }): JSX.Element {
  const { token } = theme.useToken()
  if (status === 'running') return <LoadingOutlined spin style={{ fontSize: 18, color: token.colorWarning }} />
  if (status === 'done') return <CheckCircleFilled style={{ fontSize: 18, color: token.colorSuccess }} />
  if (status === 'failed') return <CloseCircleFilled style={{ fontSize: 18, color: token.colorError }} />
  return <MinusCircleFilled style={{ fontSize: 18, color: token.colorBorderSecondary }} />
}

/** One download row: status icon + two-line info on the left, actions on the right. */
function DownloadRow({ d, onDetail, onCancel }: {
  d: DownloadSessionInfo
  onDetail: (id: string) => void
  onCancel: (id: string) => void
}): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  return (
    <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 4px', borderRadius: 6 }}>
      <StatusIcon status={d.status} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
          <Tag color={STATUS_COLOR[d.status]} style={{ marginInlineEnd: 0, flexShrink: 0, fontSize: token.fontSizeSM }}>
            {t(`download.status.${d.status}`)}
          </Tag>
        </div>
        <div
          style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={d.detail ?? d.source}
        >
          {d.detail ?? d.source}
        </div>
        {d.status === 'failed' && d.message !== undefined && d.message !== '' && (
          <div style={{ color: token.colorError, fontSize: token.fontSizeSM }}>{d.message}</div>
        )}
      </div>
      <Space size={4}>
        {d.kind === 'plugin' && d.status === 'running' && (
          <Button size="small" danger type="text" onClick={() => onCancel(d.id)}>{t('download.panel.cancel')}</Button>
        )}
        <Button size="small" type="text" onClick={() => onDetail(d.id)}>{t('download.detail')}</Button>
      </Space>
    </div>
  )
}

/** Detail modal: dsh installs show all steps; plugins show their log (source + message). */
function DownloadDetailModal({ session, onClose }: {
  session: DownloadSessionInfo | null
  onClose: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const steps = session?.steps ?? []
  const showSteps = session?.kind === 'dsh' && steps.length > 0

  const stepText = (key: string): string => {
    switch (key) {
      case 'version': return t('dsh.official.step.version')
      case 'install': return t('dsh.official.step.install')
      case 'register': return t('dsh.official.step.register')
      default: return key
    }
  }
  return (
    <Modal
      title={session?.name ?? ''}
      open={session !== null}
      onCancel={onClose}
      footer={<Button onClick={onClose}>{t('common.close')}</Button>}
      width={MODAL.narrow}
    >
      {session !== null && (
        showSteps ? (
          <div>
            {steps.map(step => (
              <div key={step.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
                <StepIcon status={step.status} />
                <span style={{ flex: 1, minWidth: 0 }}>{stepText(step.key)}</span>
                {step.meta !== undefined && (
                  <span style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>{step.meta}</span>
                )}
              </div>
            ))}
            {session.message !== undefined && session.message !== '' && (
              <div style={{ color: token.colorError, fontSize: token.fontSizeSM, marginTop: 8 }}>{session.message}</div>
            )}
          </div>
        ) : (
          <Space direction="vertical" size="small" style={{ width: '100%' }}>
            <div>
              <Tag color={STATUS_COLOR[session.status]}>{t(`download.status.${session.status}`)}</Tag>
            </div>
            {session.source !== '' && (
              <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, wordBreak: 'break-all' }}>{session.source}</div>
            )}
            {session.message !== undefined && session.message !== '' && (
              <div style={{ color: token.colorError, fontSize: token.fontSizeSM, wordBreak: 'break-word' }}>{session.message}</div>
            )}
          </Space>
        )
      )}
    </Modal>
  )
}

/**
 * Global download center: a **always-present** header entrance (badge with the
 * live task count; spinners while anything runs) that opens a right-side Drawer
 * split into DSH / plugin tabs. Each task row shows status + two-line info + a
 * detail button; plugins additionally get a cancel while running.
 */
export default function DownloadPanel(): JSX.Element {
  const { t } = useTranslation()
  const { downloads, dshDownloads, pluginDownloads, cancel, cleanup } = useDownloads()
  const [open, setOpen] = useState(false)
  const [activeTab, setActiveTab] = useState('plugin')
  const [detailId, setDetailId] = useState<string | null>(null)

  const running = downloads.some(d => d.status === 'running')
  const detail = downloads.find(d => d.id === detailId) ?? null

  const cleanupLeftovers = async (): Promise<void> => {
    const removed = await cleanup()
    if (removed.length > 0) void message.success(t('download.panel.cleaned', { count: removed.length }))
  }

  const renderList = (list: DownloadSessionInfo[]): JSX.Element =>
    list.length === 0
      ? <Empty description={t('download.panel.empty')} style={{ marginTop: 48 }} />
      : <>{list.map(d => <DownloadRow key={d.id} d={d} onDetail={setDetailId} onCancel={id => void cancel(id)} />)}</>

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
        width={440}
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
            {
              key: 'plugin',
              label: t('download.tab.plugins'),
              children: renderList(pluginDownloads),
            },
            {
              key: 'dsh',
              label: t('download.tab.dsh'),
              children: renderList(dshDownloads),
            },
          ]}
        />
        <div style={{ textAlign: 'right', paddingTop: 12 }}>
          <Button size="small" onClick={() => void cleanupLeftovers()}>{t('download.panel.cleanup')}</Button>
        </div>
      </Drawer>
      <DownloadDetailModal session={detail} onClose={() => setDetailId(null)} />
    </>
  )
}