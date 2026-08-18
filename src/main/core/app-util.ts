/**
 * Pure helpers shared across the IPC layer — patch verification, row re-basing,
 * README image inlining and zip packing. No Electron or settings dependency.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type AdmZip from 'adm-zip'
import { parsePatchRows } from './patch.ts'

/** Whether the on-disk patch reflects the requested disabled state. Enabling
 * (`disabled === false`) may legitimately have REMOVED the row entirely (a
 * disable-only override with nothing else reverts to the default = enabled), so
 * an absent row is success there; only disabling requires the row to exist. */
export function verifyDisabledState(after: string, id: string, disabled: boolean): boolean {
  const row = parsePatchRows(after).find(candidate => candidate.id === id)
  if (disabled) return row !== undefined && row.disabled === true
  return row === undefined || row.disabled === false
}

/** Re-base a copied row block to top level: strip the block's common leading
 * indent (the source row's own `- id:` indent) so it becomes a valid top-level
 * row when appended, while child keys keep their relative nesting. */
export function dedentRowBlock(block: string): string {
  const lines = block.split('\n')
  const base = /^(\s*)/.exec(lines[0] ?? '')?.[1].length ?? 0
  return lines
    .map(line => {
      const lead = /^(\s*)/.exec(line)?.[1].length ?? 0
      return lead >= base ? line.slice(base) : line
    })
    .join('\n')
}

const IMG_MIME: Record<string, string> = {
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
}

/** Rewrite relative image paths in README markdown to data: URLs resolved
 * against the plugin dir, so they render in both dev (http) and packaged (file)
 * pages. External/https and already-data URLs are untouched. */
export function inlineRelativeImages(content: string, dir: string): string {
  const rewrite = (src: string): string => {
    if (/^[a-z]+:/i.test(src) || src.startsWith('//') || src.startsWith('data:') || src.startsWith('#')) return src
    if (!existsSync(join(dir, src))) return src
    const mime = IMG_MIME[`.${(src.split('.').pop() ?? '').toLowerCase()}`]
    if (mime === undefined) return src
    try { return `data:${mime};base64,${readFileSync(join(dir, src)).toString('base64')}` } catch { return src }
  }
  content = content.replace(/src\s*=\s*["']([^"'?]+)["']/g, (m, src: string) => {
    const out = rewrite(src)
    return out === src ? m : `src="${out}"`
  })
  content = content.replace(/!\[[^\]]*\]\(([^)\s][^)\n]*?)\)/g, (m, p: string) => {
    const clean = p.replace(/\s+["']<.*/, '').trim()
    const out = rewrite(clean)
    return out === clean ? m : `![](${out})`
  })
  return content
}

/** Recursively add a plugin dir to a zip under `prefix`, SKIPPING node_modules.
 * Dependencies are re-downloaded on the target machine; packing them would
 * bloat the archive and drag platform-specific binaries across machines. */
export function addDirToZip(zip: AdmZip, base: string, prefix: string): void {
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const full = join(dir, entry.name)
      const r = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(full, r)
      else zip.addFile(`${prefix}/${r}`, readFileSync(full))
    }
  }
  walk(base, '')
}