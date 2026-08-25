import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

/**
 * Stable heavy dependencies get their own chunks so the initial bundle stays
 * small and vendor code is not re-parsed on every app change. Renderer views
 * are additionally lazy-loaded (see `App.tsx` / `ProfileSection.tsx`), so a
 * view's heavy deps (markdown toolchain, dnd) only load when that section is
 * first opened.
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {},
  renderer: {
    plugins: [react()],
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined
            // Markdown toolchain first — several of its modules also contain
            // "react", so it must be split before the react bucket matches.
            if (/react-markdown|remark|rehype|hast|unist|mdast|micromark|vfile|character-entities|character-reference|comma-separated-tokens|ccount|decode-named-character|markdown-table|stringify-entities|parse-entities|property-information|web-namespaces|html-void-elements|space-separated-tokens|trim-lines|tight-bounds|longest-streak|emoji-regex|mdurl|zwitch|bail|trough|unified|is-plain-obj/.test(id)) return 'vendor-markdown'
            if (/@dnd-kit/.test(id)) return 'vendor-dnd'
            if (/\/dayjs@/.test(id)) return 'vendor-dayjs'
            // antd + its rc-* primitives form one closed group — splitting the
            // rc-* modules off would create a vendor <-> vendor-antd cycle.
            if (/\@ant-design|\/antd[@/]|\/rc-[a-z0-9-]+@/.test(id)) return 'vendor-antd'
            if (/react-i18next|i18next/.test(id)) return 'vendor-i18n'
            if (/\/react@|\/react-dom@|\/scheduler@/.test(id)) return 'vendor-react'
            // Leave everything else to Rollup's default — forcing the shared
            // cross-cutting deps (@babel/runtime, etc.) into one bucket creates
            // a vendor <-> vendor-antd cycle. Auto chunks stay small & acyclic.
            return undefined
          },
        },
      },
    },
  },
})