/**
 * Thin Monaco wrapper: one plain editor, or a side-by-side diff when `original`
 * is given. Monaco itself is imported by `lib/monaco.ts` (worker setup included),
 * so this component must stay lazy-loaded — see the lazy import in the workspace.
 */
import { useEffect, useRef } from 'react'
import { theme as antdTheme } from 'antd'
import { monaco } from '../lib/monaco.ts'
import { useThemeMode } from '../ThemeProvider.tsx'
import type { CSSProperties } from 'react'

export type CodeLanguage = 'yaml' | 'json' | 'plaintext'

interface Props {
  value: string
  language?: CodeLanguage
  onChange?: (value: string) => void
  readOnly?: boolean
  /** Editor height; the width always fills its container. */
  height?: number | string
  /** When set, renders a diff of `original` → `value` instead of a plain editor. */
  original?: string
  style?: CSSProperties
}

export default function CodeEditor({
  value, language = 'plaintext', onChange, readOnly = false, height = 360, original, style,
}: Props): JSX.Element {
  const { token } = antdTheme.useToken()
  const { isDark } = useThemeMode()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  // Read the latest handler from the editor's own listener without re-creating it.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    monaco.editor.setTheme(isDark ? 'vs-dark' : 'vs')

    if (original !== undefined) {
      const diff = monaco.editor.createDiffEditor(host, {
        readOnly,
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 13,
        scrollBeyondLastLine: false,
        renderSideBySide: true,
      })
      const originalModel = monaco.editor.createModel(original, language)
      const modifiedModel = monaco.editor.createModel(value, language)
      diff.setModel({ original: originalModel, modified: modifiedModel })
      const sub = modifiedModel.onDidChangeContent(() => onChangeRef.current?.(modifiedModel.getValue()))
      diffRef.current = diff
      return () => {
        sub.dispose()
        diff.dispose()
        originalModel.dispose()
        modifiedModel.dispose()
        diffRef.current = null
      }
    }

    const model = monaco.editor.createModel(value, language)
    const editor = monaco.editor.create(host, {
      model,
      readOnly,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      tabSize: 2,
      scrollBeyondLastLine: false,
      wordWrap: 'on',
      fixedOverflowWidgets: true,
    })
    editorRef.current = editor
    const sub = editor.onDidChangeModelContent(() => onChangeRef.current?.(editor.getValue()))
    return () => {
      sub.dispose()
      editor.dispose()
      model.dispose()
      editorRef.current = null
    }
    // Recreate only when the mode or language changes; value / readOnly / theme
    // are applied by the effects below so typing never resets the cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, original])

  // Sync an external value change in without clobbering the cursor while typing.
  useEffect(() => {
    const model = editorRef.current?.getModel() ?? diffRef.current?.getModifiedEditor().getModel()
    if (model !== null && model !== undefined && model.getValue() !== value) model.setValue(value)
  }, [value])

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly })
    diffRef.current?.updateOptions({ readOnly })
  }, [readOnly])

  useEffect(() => {
    monaco.editor.setTheme(isDark ? 'vs-dark' : 'vs')
  }, [isDark])

  return (
    <div
      ref={hostRef}
      style={{
        height,
        width: '100%',
        border: `1px solid ${token.colorBorder}`,
        borderRadius: token.borderRadius,
        overflow: 'hidden',
        ...style,
      }}
    />
  )
}
