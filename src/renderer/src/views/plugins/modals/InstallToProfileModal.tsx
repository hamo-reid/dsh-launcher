/**
 * Install a plugin from the store into one profile.
 *
 * The profile list is loaded when the dialog opens (so a profile created since
 * mount is offered), and the version pick defaults to the newest archive.
 */
import { useEffect, useState } from 'react'
import { Modal, Select, message } from 'antd'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../../../lib/ipc.ts'
import FieldLabel from '../../../components/FieldLabel.tsx'
import { MODAL } from '../../../theme.ts'

// ── Install into a profile ─────────────────────────────────────────────────

interface InstallToProfileModalProps {
  installPkg: string | null
  /** Archived store versions of the plugin; the one to link is chosen here. */
  versions: string[]
  onClose: () => void
  onDone: () => void | Promise<void>
}
export function InstallToProfileModal(p: InstallToProfileModalProps): JSX.Element {
  const { t } = useTranslation()
  const [installScopes, setInstallScopes] = useState<{ id: string; name: string; version?: string; profiles: string[] }[]>([])
  const [installDsh, setInstallDsh] = useState<string>()
  const [installProfile, setInstallProfile] = useState<string>()
  // Which archived version to link; defaults to the latest archived one.
  const [version, setVersion] = useState<string>()
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    if (p.installPkg === null) return
    setVersion(p.versions.length > 0 ? p.versions[p.versions.length - 1] : undefined)
    void (async () => {
      const opts = await window.api.plugins.installOptions()
      if (opts.ok) setInstallScopes(opts.value)
    })()
  }, [p.installPkg, p.versions])

  const doInstall = async (): Promise<void> => {
    if (p.installPkg === null || installDsh === undefined || installProfile === undefined) { void message.warning(t('plugin.install.needBoth')); return }
    setInstalling(true)
    const res = await window.api.plugins.installToProfile(installDsh, installProfile, p.installPkg, version)
    setInstalling(false)
    if (!res.ok) { void message.error(apiErrorText(res)); return }
    void message.success(`${p.installPkg}${version !== undefined ? `@${version}` : ''} → ${installProfile}：${res.value}`)
    p.onClose()
    setInstallDsh(undefined)
    setInstallProfile(undefined)
    await p.onDone()
  }

  const showVersionPicker = p.versions.length > 1
  return (
    <Modal title={t('plugin.install.title', { name: p.installPkg ?? '' })} open={p.installPkg !== null} okText={t('plugin.install.install')} onOk={() => void doInstall()}
      okButtonProps={{ disabled: installProfile === undefined }} onCancel={() => { p.onClose(); setInstallDsh(undefined); setInstallProfile(undefined) }}
      confirmLoading={installing} destroyOnHidden width={MODAL.narrow}>
      <div style={{ marginBottom: 10, color: 'inherit' }}>
        {t('plugin.install.prompt', { name: p.installPkg ?? '' })}
      </div>
      {showVersionPicker && (
        <div style={{ marginBottom: 8 }}>
          <FieldLabel>{t('plugin.install.version')}</FieldLabel>
          <Select value={version} onChange={setVersion} style={{ width: '100%' }} placeholder={t('plugin.install.versionPlaceholder')}
            options={p.versions.map(v => ({ value: v, label: v }))} />
        </div>
      )}
      <div style={{ marginBottom: 6 }}>
        <FieldLabel>{t('plugin.install.dsh')}</FieldLabel>
        <Select value={installDsh} onChange={v => { setInstallDsh(v); setInstallProfile(undefined) }} style={{ width: '100%' }} placeholder={t('plugin.install.dshPlaceholder')}
          options={installScopes.map(s => ({ value: s.id, label: `${s.name}${s.version !== undefined ? ` (v${s.version})` : ''}` }))} />
      </div>
      <div>
        <FieldLabel>{t('plugin.install.profile')}</FieldLabel>
        <Select value={installProfile} onChange={setInstallProfile} style={{ width: '100%' }} placeholder={t('plugin.install.profilePlaceholder')}
          disabled={installDsh === undefined}
          options={(installScopes.find(s => s.id === installDsh)?.profiles ?? []).map(x => ({ value: x, label: x }))} />
      </div>
    </Modal>
  )
}

