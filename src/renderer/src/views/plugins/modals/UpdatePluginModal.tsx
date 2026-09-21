/**
 * Update one plugin to a chosen version, optionally re-pointing every profile that
 * uses it. The profile checkboxes are the point of the dialog: a store update that
 * leaves profiles on the old link is the failure mode it exists to prevent.
 */
import { useEffect, useState } from 'react'
import { Alert, Button, Checkbox, Modal, Select, Space, Spin, Tag, message, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../../../lib/ipc.ts'
import { toStoreMap } from '../../../lib/storeMap.ts'
import FieldLabel from '../../../components/FieldLabel.tsx'
import { MODAL } from '../../../theme.ts'
import type { PluginUpdateResult } from '../../../../../shared/types.ts'

// ── Update one plugin to a chosen version across profiles ────────────────────

/** What the overview hands the update dialog. */
export interface UpdatePluginTarget {
  name: string
  /** Preferred default version (the update check's latest). */
  latest?: string
  /** Profiles using it, as (dsh name, profile, resolved version when installed). */
  usage: { dsh: string; profile: string; version?: string }[]
}

interface UpdatePluginModalProps {
  target: UpdatePluginTarget | null
  onClose: () => void
  onDone: () => void | Promise<void>
}

/** Pick a version (any npm release, or one already archived) and which profiles
 * to re-point, then download once and apply. With no profile selected it simply
 * archives the version into the store. */
export function UpdatePluginModal(p: UpdatePluginModalProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [versions, setVersions] = useState<string[]>([])
  const [distTags, setDistTags] = useState<Record<string, string>>({})
  const [archived, setArchived] = useState<string[]>([])
  const [version, setVersion] = useState<string>()
  const [scopes, setScopes] = useState<{ id: string; name: string; profiles: string[] }[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [keepOld, setKeepOld] = useState(true)
  const [applyEnabled, setApplyEnabled] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<PluginUpdateResult | null>(null)

  const keyOf = (dshId: string, profile: string): string => `${dshId}\u0000${profile}`

  useEffect(() => {
    if (p.target === null) { setResult(null); setError(''); return }
    const target = p.target
    const name = target.name
    let alive = true
    setLoading(true)
    setError('')
    setResult(null)
    void (async () => {
      const [info, list, options] = await Promise.all([
        window.api.plugins.pkgVersions(name),
        window.api.plugins.list(),
        window.api.plugins.installOptions(),
      ])
      if (!alive) return
      setLoading(false)
      const npm = info.ok ? info.value.versions : []
      const tags = info.ok ? info.value.distTags : {}
      const store = list.ok ? toStoreMap(list.value).get(name) ?? [] : []
      const nextScopes = options.ok ? options.value : []
      setVersions(npm)
      setDistTags(tags)
      setArchived(store)
      setScopes(nextScopes)
      setVersion(target.latest ?? tags.latest ?? npm[npm.length - 1])
      // Applying to profiles is opt-in and starts with nothing ticked.
      setKeepOld(true)
      setApplyEnabled(false)
      setSelected([])
    })()
    return () => { alive = false }
  }, [p.target])

  const choices = [...new Set([...archived, ...versions])]
  // Only profiles where the plugin is actually installed can be re-pointed.
  const installed = (p.target?.usage ?? []).filter(u => u.version !== undefined && u.version !== '')
  const toggle = (key: string): void =>
    setSelected(prev => prev.includes(key) ? prev.filter(x => x !== key) : [...prev, key])

  const apply = async (): Promise<void> => {
    if (p.target === null || version === undefined) return
    setBusy(true)
    const targets = applyEnabled
      ? selected.map((key) => {
        const at = key.indexOf('\u0000')
        return { dshId: key.slice(0, at), profile: key.slice(at + 1) }
      })
      : []
    const r = await window.api.plugins.applyUpdate(p.target.name, version, targets, { keepOld })
    setBusy(false)
    if (!r.ok) { setError(apiErrorText(r)); return }
    setResult(r.value)
    const ok = r.value.results.filter(x => x.ok).length
    if (r.value.results.length > 0) void message.success(t('plugin.updateTo.done', { count: ok }))
    await p.onDone()
  }

  return (
    <Modal
      title={t('plugin.updateTo.title', { name: p.target?.name ?? '' })}
      open={p.target !== null}
      onCancel={p.onClose}
      width={MODAL.wide}
      footer={result !== null
        ? <Button type="primary" onClick={p.onClose}>{t('common.close')}</Button>
        : (
          <Space>
            <Button onClick={p.onClose} disabled={busy}>{t('common.cancel')}</Button>
            <Button type="primary" loading={busy} disabled={version === undefined} onClick={() => void apply()}>
              {t('common.confirm')}
            </Button>
          </Space>
        )}
    >
      <Space orientation="vertical" size="small" style={{ width: '100%' }}>
        {loading && <div><Spin size="small" /> {t('plugin.version.loading')}</div>}
        {error !== '' && <Alert type="error" showIcon title={error} />}

        {result === null ? (
          <>
            {Object.keys(distTags).length > 0 && (
              <div>
                <FieldLabel>{t('plugin.version.distTags')}</FieldLabel>
                <Space wrap size={4}>
                  {Object.entries(distTags).map(([tag, ver]) => <Tag key={tag}>{tag}={ver}</Tag>)}
                </Space>
              </div>
            )}
            <div>
              <FieldLabel>{t('plugin.updateTo.version')}</FieldLabel>
              <Select
                showSearch
                style={{ width: '100%' }}
                value={version}
                onChange={setVersion}
                optionFilterProp="label"
                options={choices.map(v => ({
                  value: v,
                  label: archived.includes(v) ? `${v} · ${t('plugin.detail.storeTag')}` : v,
                }))}
              />
            </div>
            <div>
              <Checkbox checked={keepOld} onChange={e => setKeepOld(e.target.checked)}>
                {t('plugin.updateTo.keepOld')}
              </Checkbox>
              <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>
                {t('plugin.updateTo.keepOldHint')}
              </div>
            </div>
            <div>
              <Checkbox
                checked={applyEnabled}
                disabled={installed.length === 0}
                onChange={e => setApplyEnabled(e.target.checked)}
              >
                {t('plugin.updateTo.applyTo')}
              </Checkbox>
              <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>
                {installed.length === 0 ? t('plugin.updateTo.noneInstalled') : t('plugin.updateTo.applyHint')}
              </div>
              {applyEnabled && installed.length > 0 && (
                <>
                  <Space size={4} style={{ margin: '4px 0' }}>
                    <Button size="small" onClick={() => setSelected(installed.flatMap(u => {
                      const id = scopes.find(s => s.name === u.dsh)?.id
                      return id === undefined ? [] : [keyOf(id, u.profile)]
                    }))}>{t('plugin.updateTo.selectAll')}</Button>
                    <Button size="small" onClick={() => setSelected([])}>{t('plugin.updateTo.selectNone')}</Button>
                  </Space>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {installed.map(u => {
                      const id = scopes.find(s => s.name === u.dsh)?.id
                      const key = id === undefined ? '' : keyOf(id, u.profile)
                      return (
                        <Checkbox
                          key={`${u.dsh}:${u.profile}`}
                          disabled={key === ''}
                          checked={key !== '' && selected.includes(key)}
                          onChange={() => { if (key !== '') toggle(key) }}
                        >
                          {u.dsh} · {u.profile} · @{u.version}
                        </Checkbox>
                      )
                    })}
                  </div>
                </>
              )}
            </div>
          </>
        ) : (
          <>
            {result.downloaded && (
              <Alert type="success" showIcon title={t('plugin.updateTo.downloaded', { name: p.target?.name ?? '', version })} />
            )}
            {(result.removed?.length ?? 0) > 0 && (
              <Alert type="info" showIcon title={t('plugin.updateTo.cleaned', { count: result.removed?.length ?? 0 })} />
            )}
            {result.results.map(r => (
              <div key={`${r.dsh}:${r.profile}`} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Tag color={r.ok ? 'success' : 'error'}>{r.ok ? t('plugin.update.ok') : t('download.status.failed')}</Tag>
                <span>{r.profile}</span>
                <span style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>{r.text}</span>
              </div>
            ))}
          </>
        )}
      </Space>
    </Modal>
  )
}

