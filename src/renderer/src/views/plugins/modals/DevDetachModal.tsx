/**
 * Detach a dev plugin from profiles: the mirror of "attach to profile", and the
 * one thing the store page could not express — unregistering a dev plugin
 * deliberately touches no profile at all, and uninstalling deletes the archive.
 *
 * The choice lives here rather than in the caller, so opening it for one package
 * always starts from a clean slate: the last package's dsh may be gone, and its
 * profile is not this package's.
 */
import { useEffect, useMemo, useState } from 'react'
import { Alert, Checkbox, Modal, Select, Space, theme, message } from 'antd'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../../../lib/ipc.ts'
import FieldLabel from '../../../components/FieldLabel.tsx'
import { MODAL } from '../../../theme.ts'
import type { HostOption } from '../useDevPlugins.ts'

interface Props {
  /** The package to detach; the dialog is open while this is set. */
  pkg: string | null
  hosts: HostOption[]
  /** The profiles that already reference it, as `${dsh}·${profile}`. Pre-checked,
   * because the common case is "remove it from where I put it". */
  usedIn: string[]
  onClose: () => void
  onDetached: () => Promise<void>
}

export default function DevDetachModal({ pkg, hosts, usedIn, onClose, onDetached }: Props): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const [dsh, setDsh] = useState<string>()
  const [picked, setPicked] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (pkg === null) return
    // Start on the dsh that already uses it when there is one — the dsh the user
    // linked is the dsh they are asking about.
    const owner = usedIn[0]?.split('·')[0]
    setDsh(prev => (prev !== undefined && hosts.some(h => h.id === prev) ? prev : (hosts.find(h => h.name === owner)?.id ?? hosts[0]?.id)))
    setPicked(usedIn.map(k => k.split('·')[1] ?? '').filter(Boolean))
  }, [pkg])

  const host = useMemo(() => hosts.find(h => h.id === dsh), [hosts, dsh])
  const profiles = host?.profiles ?? []
  // Pre-checked names that this dsh does not have would silently do nothing.
  const selected = picked.filter(p => profiles.includes(p))

  const run = async (): Promise<void> => {
    if (pkg === null || dsh === undefined || selected.length === 0) return
    setBusy(true)
    const r = await window.api.plugins.detach(pkg, selected.map(profile => ({ dsh: host!.name, profile })))
    setBusy(false)
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    const n = r.value.detached.length
    if (n === 0) void message.warning(t('plugin.dev.detachNone'))
    else void message.success(t('plugin.dev.detachDone', { name: pkg, count: n }))
    onClose()
    await onDetached()
  }

  return (
    <Modal
      title={t('plugin.dev.detachTitle', { name: pkg ?? '' })}
      open={pkg !== null}
      onCancel={onClose}
      onOk={() => void run()}
      confirmLoading={busy}
      okButtonProps={{ disabled: selected.length === 0 }}
      width={MODAL.narrow}
    >
      <Space orientation="vertical" size="small" style={{ width: '100%' }}>
        <Alert type="info" showIcon title={t('plugin.dev.detachHint')} />
        <div>
          <FieldLabel>{t('plugin.dev.linkDsh')}</FieldLabel>
          <Select
            style={{ width: '100%' }}
            value={dsh}
            onChange={v => { setDsh(v); setPicked([]) }}
            options={hosts.map(h => ({ value: h.id, label: h.name }))}
          />
        </div>
        <div>
          <FieldLabel>{t('plugin.dev.detachProfiles')}</FieldLabel>
          {profiles.length === 0
            ? <span style={{ color: token.colorTextSecondary }}>{t('plugin.dev.detachNoProfiles')}</span>
            : (
              <Checkbox.Group value={selected} onChange={v => setPicked(v as string[])} style={{ width: '100%' }}>
                <Space direction="vertical" style={{ width: '100%' }}>
                  {profiles.map(p => (
                    <Checkbox key={p} value={p}>{p}</Checkbox>
                  ))}
                </Space>
              </Checkbox.Group>
            )}
        </div>
      </Space>
    </Modal>
  )
}
