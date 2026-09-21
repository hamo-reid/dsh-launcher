/**
 * Update every plugin of one profile at once, with the GitHub-auth hint a github
 * origin needs (an unauthenticated quota is what silently degrades those checks).
 */
import { useEffect, useState } from 'react'
import { Alert, Button, Modal, Space, Spin, Tag, message, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../../../lib/ipc.ts'
import { MODAL } from '../../../theme.ts'
import type { GithubAuthState, PluginApplyResult } from '../../../../../shared/types.ts'

// ── Update one profile's plugins ─────────────────────────────────────────────

interface PluginUpdatesModalProps {
  open: boolean
  dshId: string
  profile: string
  onClose: () => void
  /** Called after a successful apply, with the updated plugin names. */
  onDone: (updated: string[]) => void | Promise<void>
}

/** Per-profile plugin update: checks the plugins this profile uses and updates
 * all of them that have a newer npm release. Refused by the core while running. */
export function PluginUpdatesModal(p: PluginUpdatesModalProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [loading, setLoading] = useState(false)
  const [items, setItems] = useState<{ name: string; current?: string; latest: string }[]>([])
  const [manual, setManual] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<PluginApplyResult[] | null>(null)
  const [github, setGithub] = useState<GithubAuthState>()

  useEffect(() => {
    if (!p.open) return
    setResults(null); setItems([]); setManual([]); setLoading(true)
    void (async () => {
      const [ov, up, ga] = await Promise.all([
        window.api.plugins.overview(),
        window.api.plugins.checkUpdates(),
        window.api.settings.getGithubAuth(),
      ])
      setLoading(false)
      if (ga.ok) setGithub(ga.value)
      if (!ov.ok || !up.ok) { if (!up.ok) void message.error(apiErrorText(up)); return }
      const byName = new Map(up.value.map(u => [u.name, u]))
      const next: { name: string; current?: string; latest: string }[] = []
      const man: string[] = []
      for (const row of ov.value) {
        const usage = row.usage.find(u => u.profile === p.profile)
        if (usage === undefined) continue
        const info = byName.get(row.name)
        if (info === undefined) continue
        if (info.updateAvailable && info.latest !== undefined) {
          next.push({ name: row.name, ...(usage.version !== undefined ? { current: usage.version } : {}), latest: info.latest })
        } else if (info.manual) {
          man.push(row.name)
        }
      }
      setItems(next)
      setManual(man)
    })()
  }, [p.open, p.dshId, p.profile])

  const apply = async (): Promise<void> => {
    if (items.length === 0) return
    setBusy(true)
    const r = await window.api.plugins.applyUpdates(p.dshId, p.profile, items.map(i => ({ name: i.name, version: i.latest })))
    setBusy(false)
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    setResults(r.value.results)
    const okNames = r.value.results.filter(x => x.ok).map(x => x.name)
    if (okNames.length > 0) void message.success(t('plugin.update.applied', { count: okNames.length }))
    await p.onDone(okNames)
  }

  const footer = busy
    ? <Space><Button loading>{t('plugin.update.applying')}</Button></Space>
    : results !== null
      ? <Button type="primary" onClick={p.onClose}>{t('common.close')}</Button>
      : items.length > 0
        ? (
          <Space>
            <Button onClick={p.onClose} disabled={busy}>{t('common.cancel')}</Button>
            <Button type="primary" loading={busy} onClick={() => void apply()}>{t('plugin.update.applyAll', { count: items.length })}</Button>
          </Space>
        )
        : <Button onClick={p.onClose}>{t('common.close')}</Button>

  return (
    <Modal title={t('plugin.update.title', { profile: p.profile })} open={p.open}
      onCancel={busy ? undefined : p.onClose} closable={!busy} mask={{ closable: !busy }}
      width={MODAL.wide} footer={footer}>
      <Space orientation="vertical" style={{ width: '100%' }} size="small">
        {loading && <div><Spin size="small" /> {t('plugin.update.checking')}</div>}

        {!loading && results === null && items.length === 0 && (
          <div style={{ color: token.colorTextSecondary }}>{t('plugin.update.none')}</div>
        )}

        {!loading && results === null && items.map(item => (
          <div key={item.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: `1px solid ${token.colorSplit}` }}>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>{item.name}</span>
            {item.current !== undefined && <Tag>{item.current}</Tag>}
            <span style={{ color: token.colorTextTertiary }}>→</span>
            <Tag color="gold">{item.latest}</Tag>
          </div>
        ))}

        {results !== null && results.map(r => (
          <div key={r.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: `1px solid ${token.colorSplit}` }}>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>{r.name}@{r.version}</span>
            {r.ok ? <Tag color="success">{t('plugin.update.ok')}</Tag> : <Tag color="error">{r.text}</Tag>}
          </div>
        ))}

        {manual.length > 0 && (
          <Alert type="info" showIcon title={t('plugin.update.manualHint', { names: manual.join(t('common.listSep')) })} />
        )}

        {github?.rateLimited === true && (
          <Alert type="warning" showIcon title={t('plugin.update.githubRateLimited')} />
        )}
        {github?.rateLimited !== true && github?.authenticated === false && manual.length > 0 && (
          <Alert type="info" showIcon title={t('plugin.update.githubHint')} />
        )}
      </Space>
    </Modal>
  )
}
