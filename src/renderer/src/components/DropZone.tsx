/**
 * File drop zone: a `useFileDrop` state machine (attach to a container) plus a
 * `DropZone` visual block (purely presentational — it owns no drop handler, so
 * a drop on it bubbles to the container exactly once).
 *
 * The depth counter defeats the classic flicker: every child boundary crossing
 * fires its own dragenter/dragleave pair, so a boolean flag would flap.
 */
import { useRef, useState } from 'react'
import type { CSSProperties, DragEvent, KeyboardEvent } from 'react'
import { Spin, Typography, theme } from 'antd'
import { InboxOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'

export interface FileDropHandlers {
  onDragEnter: (e: DragEvent<HTMLDivElement>) => void
  onDragOver: (e: DragEvent<HTMLDivElement>) => void
  onDragLeave: (e: DragEvent<HTMLDivElement>) => void
  onDrop: (e: DragEvent<HTMLDivElement>) => void
}

interface FileDropOptions {
  /** Extensions to accept (case-insensitive), e.g. `['.zip']`. Empty accepts all. */
  accept?: string[]
  /** Files that passed the filter. */
  onDrop: (files: File[]) => void
  /** All dropped files, when none passed the filter. */
  onReject?: (names: string[]) => void
  /** While set, drags are ignored (an import is already running). */
  disabled?: boolean
}

export function useFileDrop(opts: FileDropOptions): { dragging: boolean; handlers: FileDropHandlers } {
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)

  const accept = opts.accept ?? []
  const matches = (name: string): boolean => {
    if (accept.length === 0) return true
    const lower = name.toLowerCase()
    return accept.some(ext => lower.endsWith(ext.toLowerCase()))
  }

  return {
    dragging,
    handlers: {
      onDragEnter: (e: DragEvent<HTMLDivElement>): void => {
        e.stopPropagation()
        if (opts.disabled === true) return
        depth.current += 1
        // Only file drags highlight (ignore text selections and the like).
        if (e.dataTransfer.types.includes('Files')) setDragging(true)
      },
      onDragOver: (e: DragEvent<HTMLDivElement>): void => {
        e.stopPropagation()
        if (opts.disabled === true) return
        // Required: without it the browser navigates to the dropped file.
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      },
      onDragLeave: (e: DragEvent<HTMLDivElement>): void => {
        e.stopPropagation()
        if (opts.disabled === true) return
        depth.current -= 1
        if (depth.current <= 0) {
          depth.current = 0
          setDragging(false)
        }
      },
      onDrop: (e: DragEvent<HTMLDivElement>): void => {
        e.stopPropagation()
        e.preventDefault()
        depth.current = 0
        setDragging(false)
        if (opts.disabled === true) return
        const all = [...e.dataTransfer.files]
        const ok = all.filter(file => matches(file.name))
        if (ok.length > 0) opts.onDrop(ok)
        else if (all.length > 0) opts.onReject?.(all.map(file => file.name))
      },
    },
  }
}

interface DropZoneProps {
  dragging: boolean
  busy?: boolean
  /** Click (or Enter/Space) falls back to the button flow. */
  onPick: () => void
  style?: CSSProperties
}

/** The always-visible dashed block. Clickable — a drop hint that cannot be
 * clicked reads as broken. */
export default function DropZone(p: DropZoneProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const active = p.dragging || p.busy === true

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      p.onPick()
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={t('ext.skills.import')}
      onClick={() => p.onPick()}
      onKeyDown={onKeyDown}
      style={{
        border: `1px dashed ${active ? token.colorPrimary : token.colorBorder}`,
        borderRadius: token.borderRadiusLG,
        background: active ? token.colorPrimaryBg : token.colorFillQuaternary,
        padding: `${token.paddingLG}px ${token.padding}px`,
        minHeight: 96,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: token.paddingXS,
        color: active ? token.colorPrimary : token.colorTextTertiary,
        transition: 'all .15s',
        cursor: p.busy === true ? 'wait' : 'pointer',
        pointerEvents: p.busy === true ? 'none' : undefined,
        ...p.style,
      }}
    >
      {p.busy === true ? <Spin size="small" /> : <InboxOutlined style={{ fontSize: 22 }} />}
      <Typography.Text style={{ color: 'inherit', fontWeight: 600 }}>
        {p.busy === true ? t('ext.skills.dropImporting') : t('ext.skills.dropHint')}
      </Typography.Text>
      {p.busy !== true && (
        <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
          {t('ext.skills.dropSubHint')}
        </Typography.Text>
      )}
    </div>
  )
}
