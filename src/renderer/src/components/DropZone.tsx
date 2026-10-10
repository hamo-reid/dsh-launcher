/**
 * The file-drop kit: a `useFileDrop` state machine (attach it to the surface that
 * accepts the file) plus the `DropOverlay` hint that covers that surface mid-drag.
 *
 * There is deliberately no always-visible dashed BLOCK: a drop target that spends a
 * hundred pixels of the layout on a gesture that lasts a second is a bad trade, and
 * the surface a user would aim at is the surface itself. While a drag is over it (or
 * an import runs) the overlay covers it — and with `pointer-events: none`, so the
 * DROP still lands on the container's own handlers: an overlay that could receive it
 * would be a second drop target.
 *
 * The depth counter defeats the classic flicker: every child boundary crossing fires
 * its own dragenter/dragleave pair, so a boolean flag would flap.
 */
import { useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { Spin, theme } from 'antd'
import { InboxOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'

interface FileDropHandlers {
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

interface DropOverlayProps {
  /** Shown while a drag is over the surface, or while an import runs. */
  active: boolean
  /** An import is running: replaces the hint with the importing line and a spinner. */
  busy?: boolean
  hint: string
  /** Second line naming what dropping does; omitted while busy. */
  subHint?: string
}

/** The hint that covers the surface it is given, mid-drag. Render it as the last
 * child of a `position: relative` container that carries `useFileDrop`'s handlers. */
export function DropOverlay(p: DropOverlayProps): JSX.Element | null {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  if (!p.active) return null
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: token.paddingXS,
        borderRadius: token.borderRadiusLG,
        border: `2px dashed ${token.colorPrimary}`,
        background: token.colorPrimaryBg,
        color: token.colorPrimary,
        pointerEvents: 'none',
      }}
    >
      {p.busy === true ? <Spin size="small" /> : <InboxOutlined style={{ fontSize: 28 }} />}
      <div style={{ fontWeight: 600 }}>
        {p.busy === true ? t('ext.skills.dropImporting') : p.hint}
      </div>
      {p.busy !== true && p.subHint !== undefined && (
        <div style={{ fontSize: token.fontSizeSM }}>{p.subHint}</div>
      )}
    </div>
  )
}
