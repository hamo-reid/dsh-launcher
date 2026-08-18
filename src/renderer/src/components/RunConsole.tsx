import { useEffect, useRef, useState, type ReactNode } from 'react'
import { theme } from 'antd'
import { useTranslation } from 'react-i18next'

interface RunConsoleProps {
  /** Raw streamed output; can contain ANSI SGR escape sequences. */
  logs: string
  /** Whether the underlying process is live. */
  running?: boolean
  /** Min-height (px) of the console body. */
  height?: number
  /** Fill the parent's full height instead of a fixed `height`. */
  fill?: boolean
  title?: string
  /** Called with a line typed into the console input; enables interaction. */
  onInput?: (line: string) => void
  /** Called when a URL in the output is clicked (intercept; no direct open). */
  onUrlClick?: (url: string) => void
}

// ANSI 16-color foreground palettes (dark terminal), 30–37 low-intensity, 90–97 bright.
const ANSI_FG = ['#9d9da4', '#e0694b', '#92c46f', '#e6c562', '#5aa9e6', '#b58cd6', '#69c2c0', '#d1d1d6']
const ANSI_FG_BRIGHT = ['#ffffff', '#ff9d82', '#baf08f', '#ffe79a', '#7ec8ff', '#d3a9ff', '#8ceed0', '#ffffff']

const URL_RE = /https?:\/\/[^\s"'<>]+/gi

/** Render a log string: map ANSI SGR codes (reset/bold + fg colors) and turn
 * URLs into clickable links whose click is surfaced to the caller — it never
 * opens directly (the caller asks first). */
function ansiToNodes(text: string, onUrl?: (url: string) => void): ReactNode[] {
  const re = /\x1b\[([0-9;]*)m/g
  const nodes: ReactNode[] = []
  let last = 0
  let bold = false
  let fg = ''
  let key = 0
  const plain = (slice: string): ReactNode => (
    <span key={key++} style={{ fontWeight: bold ? 700 : 400, color: fg }}>{slice}</span>
  )
  const emit = (slice: string): void => {
    if (slice === '') return
    URL_RE.lastIndex = 0
    let seg = 0
    let m: RegExpExecArray | null
    while ((m = URL_RE.exec(slice)) !== null) {
      if (m.index > seg) nodes.push(plain(slice.slice(seg, m.index)))
      const url = m[0]
      nodes.push(
        <a
          key={key++}
          href="#"
          onClick={event => {
            event.preventDefault()
            if (onUrl !== undefined) onUrl(url)
          }}
          style={{ color: '#7ec8ff', textDecoration: 'underline', cursor: 'pointer' }}
        >
          {url}
        </a>,
      )
      seg = m.index + url.length
    }
    if (seg < slice.length) nodes.push(plain(slice.slice(seg)))
  }
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    emit(text.slice(last, match.index))
    for (const raw of match[1].split(';')) {
      const code = Number(raw)
      if (code === 0) { bold = false; fg = '' }
      else if (code === 1) { bold = true }
      else if (code >= 30 && code <= 37) { fg = ANSI_FG[code - 30] ?? '' }
      else if (code >= 90 && code <= 97) { fg = ANSI_FG_BRIGHT[code - 90] ?? '' }
    }
    last = match.index + match[0].length
  }
  emit(text.slice(last))
  return nodes
}

/** A terminal-style console that streams process output into the page,
 * dim-to-light ANSI coloured, auto-scrolling to the newest line. */
export default function RunConsole({
  logs, running = false, height = 260, fill = false, title, onInput, onUrlClick,
}: RunConsoleProps) {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const header = title ?? t('run.consoleTitle')
  const endRef = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState('')
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [logs])

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: fill ? 0 : height,
        height: fill ? '100%' : undefined,
        background: '#101218',
        border: `1px solid ${token.colorBorder}`,
        borderRadius: token.borderRadius,
        overflow: 'hidden',
      }}
    >
      {/* console chrome: traffic lights + title + status */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 12px',
          height: 34,
          background: '#181b21',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#e0694b' }} />
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#e6c562' }} />
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#92c46f' }} />
        <span style={{ flex: 1, textAlign: 'center', color: '#b9bcc4', fontSize: 12, marginRight: 30 }}>{header}</span>
        <span style={{ fontSize: 12, color: running ? '#7bd6a0' : '#7a7e89', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: running ? '#7bd6a0' : '#5a5e68',
              boxShadow: running ? '0 0 6px #7bd6a0' : undefined,
            }}
          />
          {running ? t('run.running') : t('run.stopped')}
        </span>
      </div>

      {/* console body */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: 12,
          lineHeight: 1.5,
          color: '#d6d8dd',
          padding: '8px 12px',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {logs === ''
          ? <span style={{ color: '#6b6f78' }}>{running ? t('run.waitingOutput') : t('run.notRunning')}</span>
          : ansiToNodes(logs, onUrlClick)}
        <div ref={endRef} />
      </div>

      {/* interactive input line: forwards to the process stdin when running */}
      {onInput !== undefined && running && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '4px 12px',
            borderTop: '1px solid rgba(255,255,255,0.08)',
            background: '#14161b',
          }}
        >
          <span style={{ color: '#7bd6a0', fontFamily: 'monospace', fontWeight: 700 }}>❯</span>
          <input
            autoFocus
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key !== 'Enter') return
              const line = draft
              if (line.trim() === '') return
              onInput(line)
              setDraft('')
            }}
            placeholder={t('run.inputPlaceholder')}
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: '#e6e8ee',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              fontSize: 12,
            }}
          />
        </div>
      )}
    </div>
  )
}