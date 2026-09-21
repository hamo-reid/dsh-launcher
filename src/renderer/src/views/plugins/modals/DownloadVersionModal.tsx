/**
 * Download one specific version of a plugin into the store.
 *
 * Both sides of the list are remote: the store's archived versions and the
 * registry's published ones, with the former filtered out of the latter so the
 * dialog never offers what is already downloaded.
 */
import { useEffect, useState } from 'react'
import { Alert, Modal, Select, Space, Spin, Tag, message } from 'antd'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../../../lib/ipc.ts'
import FieldLabel from '../../../components/FieldLabel.tsx'
import { MODAL } from '../../../theme.ts'
import type { PackageVersionInfo } from '../../../../../shared/types.ts'

// ── Download with a selectable version ──────────────────────────────────────
interface DownloadVersionModalProps {
  pkg: string | null
  onClose: () => void
  /** Called once the package has been added to the store. */
  onInstalled: () => void | Promise<void>
}
export function DownloadVersionModal(p: DownloadVersionModalProps): JSX.Element {
  const { t } = useTranslation()
  const [info, setInfo] = useState<PackageVersionInfo | null>(null)
  const [version, setVersion] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (p.pkg === null) { setInfo(null); setVersion(undefined); setError(''); return }
    let alive = true
    setLoading(true)
    setError('')
    void window.api.plugins.pkgVersions(p.pkg).then(r => {
      if (!alive) return
      setLoading(false)
      if (!r.ok) { setError(apiErrorText(r)); return }
      setInfo(r.value)
      setVersion(r.value.distTags.latest ?? r.value.versions[0])
    })
    return () => { alive = false }
  }, [p.pkg])

  const doDownload = async (): Promise<void> => {
    if (p.pkg === null || version === undefined) return
    // Fire a cancellable session; progress/cancel + store refresh are handled by
    // the global download panel, so the dialog simply closes once initiated.
    const r = await window.api.downloads.start(`${p.pkg}@${version}`, p.pkg)
    if (!r.ok) { setError(apiErrorText(r)); return }
    void message.success(t('plugin.version.downloadStarted', { spec: `${p.pkg}@${version}` }))
    p.onClose()
  }

  const tags = info !== null ? Object.entries(info.distTags) : []
  return (
    <Modal title={t('plugin.version.title', { name: p.pkg ?? '' })} open={p.pkg !== null} onCancel={p.onClose}
      okText={t('plugin.version.download')} onOk={() => void doDownload()} confirmLoading={installing}
      okButtonProps={{ disabled: version === undefined || loading || info === null }}
      width={MODAL.narrow}>
      <Space orientation="vertical" style={{ width: '100%' }} size="small">
        {loading && <div style={{ color: 'inherit' }}><Spin size="small" />　{t('plugin.version.loading')}</div>}

        {error !== '' && <Alert type="error" showIcon title={error} />}

        {info !== null && !loading && (
          <>
            {tags.length > 0 && (
              <div>
                <FieldLabel>{t('plugin.version.distTags')}</FieldLabel>
                <Space wrap size={4}>
                  {tags.map(([tag, ver]) => <Tag key={tag}>{tag}={ver}</Tag>)}
                </Space>
              </div>
            )}
            <div>
              <FieldLabel>{t('plugin.version.select')}</FieldLabel>
              <Select showSearch style={{ width: '100%' }} value={version} onChange={setVersion}
                placeholder={t('plugin.version.placeholder')} optionFilterProp="label"
                options={info.versions.map(v => ({ value: v, label: v }))} />
            </div>
          </>
        )}
      </Space>
    </Modal>
  )
}

