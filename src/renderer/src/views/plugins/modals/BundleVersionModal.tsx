/**
 * Replace one profile bundle layer's version — the store/npm-backed layers only,
 * since an in-box or local layer has no installed version to point elsewhere.
 */
import { useEffect, useState } from 'react'
import { Alert, Modal, Select, Space, Spin, Tag, message } from 'antd'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../../../lib/ipc.ts'
import { toStoreMap } from '../../../lib/storeMap.ts'
import FieldLabel from '../../../components/FieldLabel.tsx'
import { MODAL } from '../../../theme.ts'
import type { PackageVersionInfo } from '../../../../../shared/types.ts'

// ── Replace one profile bundle's version ─────────────────────────────────────

export interface BundleVersionTarget {
  dshId: string
  profile: string
  bundle: string
  /** Version currently resolved in the profile, when known. */
  current?: string
}

interface BundleVersionModalProps {
  target: BundleVersionTarget | null
  onClose: () => void
  /** Called after a successful replace, so the profile detail can reload. */
  onDone: () => void | Promise<void>
}

/** Re-version one bundle layer of a profile. Store-archived versions come first;
 * the npm registry list is merged in when reachable (a github/local-only name
 * 404s here, which simply degrades to store-only). Applying reuses
 * `plugins:applyUpdates`, which downloads a missing version and re-points the
 * profile's dependency (keeping the layer activated). */
export function BundleVersionModal(p: BundleVersionModalProps): JSX.Element {
  const { t } = useTranslation()
  const [storeVersions, setStoreVersions] = useState<string[]>([])
  const [npm, setNpm] = useState<PackageVersionInfo | null>(null)
  const [version, setVersion] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (p.target === null) { setStoreVersions([]); setNpm(null); setVersion(undefined); setError(''); return }
    const bundle = p.target.bundle
    let alive = true
    setLoading(true)
    setError('')
    void (async () => {
      const [list, versions] = await Promise.all([
        window.api.plugins.list(),
        window.api.plugins.pkgVersions(bundle),
      ])
      if (!alive) return
      setLoading(false)
      setStoreVersions(list.ok ? toStoreMap(list.value).get(bundle) ?? [] : [])
      setNpm(versions.ok ? versions.value : null)
    })()
    return () => { alive = false }
  }, [p.target])

  const target = p.target
  const npmVersions = (npm?.versions ?? []).filter(v => !storeVersions.includes(v))
  // Default pick: the newest archived version, else the registry's latest.
  const latestStore = storeVersions.length > 0 ? storeVersions[storeVersions.length - 1] : undefined
  const fallback = latestStore ?? npm?.distTags.latest ?? npmVersions[npmVersions.length - 1]

  useEffect(() => { setVersion(fallback) }, [target?.bundle, fallback])

  const apply = async (): Promise<void> => {
    if (target === null || version === undefined) return
    setBusy(true)
    const r = await window.api.plugins.applyUpdates(target.dshId, target.profile, [{ name: target.bundle, version }])
    setBusy(false)
    if (!r.ok) { setError(apiErrorText(r)); return }
    const failed = r.value.results.find(x => !x.ok)
    if (failed !== undefined) { setError(`${failed.name}@${failed.version}: ${failed.text}`); return }
    void message.success(t('profile.bundle.replaced', { bundle: target.bundle, version }))
    await p.onDone()
    p.onClose()
  }

  const distTags = Object.entries(npm?.distTags ?? {})
  const options = [
    ...storeVersions.map(v => ({ value: v, label: `${v} · ${t('plugin.detail.storeTag')}` })),
    ...npmVersions.map(v => ({ value: v, label: v })),
  ]
  return (
    <Modal
      title={t('profile.bundle.replaceTitle', { bundle: target?.bundle ?? '' })}
      open={target !== null}
      onCancel={p.onClose}
      okText={t('profile.bundle.replace')}
      onOk={() => void apply()}
      confirmLoading={busy}
      okButtonProps={{ disabled: version === undefined || version === target?.current }}
      width={MODAL.narrow}
    >
      <Space orientation="vertical" style={{ width: '100%' }} size="small">
        <div style={{ color: 'inherit', fontSize: 12 }}>{t('profile.bundle.replaceHint')}</div>
        {target?.current !== undefined && target.current !== '' && (
          <div>
            <FieldLabel>{t('profile.bundle.current')}</FieldLabel>
            <Tag style={{ fontFamily: 'monospace' }}>@{target.current}</Tag>
          </div>
        )}
        {loading && <div><Spin size="small" />　{t('plugin.version.loading')}</div>}
        {error !== '' && <Alert type="error" showIcon title={error} />}
        {distTags.length > 0 && (
          <div>
            <FieldLabel>{t('plugin.version.distTags')}</FieldLabel>
            <Space wrap size={4}>{distTags.map(([tag, ver]) => <Tag key={tag}>{tag}={ver}</Tag>)}</Space>
          </div>
        )}
        <div>
          <FieldLabel>{t('profile.bundle.version')}</FieldLabel>
          <Select
            showSearch
            style={{ width: '100%' }}
            value={version}
            onChange={setVersion}
            optionFilterProp="label"
            placeholder={t('plugin.version.placeholder')}
            options={options}
          />
        </div>
        {!loading && options.length === 0 && (
          <div style={{ color: 'inherit' }}>{t('profile.bundle.noVersions')}</div>
        )}
      </Space>
    </Modal>
  )
}

