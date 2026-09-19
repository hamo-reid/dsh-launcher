/**
 * Monaco bootstrap for the profile editor.
 *
 * The typed API comes from `editor.api`; `editor.main` is imported for its side
 * effects — it registers every editing contribution (find, suggest, context
 * menu, …), all basic languages (which includes YAML highlighting) and the
 * language features (JSON validation among them).
 *
 * Monaco's web workers are routed to Vite-emitted, same-origin chunks. There is
 * deliberately no CDN loader: the renderer is sandboxed and offline, and the
 * page CSP only permits same-origin (and blob:) workers.
 *
 * Imported only by the lazy-loaded `CodeEditor`, so Monaco lands in its own
 * dynamic chunk and never weighs on app startup.
 */
import * as monaco from 'monaco-editor/editor/editor.api.js'
import 'monaco-editor/editor/editor.main.js'
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker'

interface MonacoEnvironment {
  getWorker: (moduleId: string, label: string) => Worker
}

;(globalThis as unknown as { MonacoEnvironment: MonacoEnvironment }).MonacoEnvironment = {
  getWorker(_moduleId, label) {
    if (label === 'json') return new JsonWorker()
    return new EditorWorker()
  },
}

export { monaco }
