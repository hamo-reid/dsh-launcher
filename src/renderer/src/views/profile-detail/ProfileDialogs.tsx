/**
 * The dialogs that act on a profile itself rather than on its patch rows: rename,
 * and copy/move its patch layer into another profile.
 *
 * Each owns its own input state and its own submit, so the workspace only wires an
 * open flag and a "something changed" callback. Neither needs the composed stack
 * the workspace holds, which is what makes them separable at all.
 */
import { useEffect, useState } from 'react'
import { Button, Input, Modal, Select, Space, theme, message } from 'antd'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../../lib/ipc.ts'
import FieldLabel from '../../components/FieldLabel.tsx'
import { MODAL } from '../../theme.ts'

interface RenameProps {
  dshId: string
  /** The profile's current name; the field starts from it. */
  name: string
  open: boolean
  onClose: () => void
  /** Called with the new name after the rename succeeded. */
  onRenamed: (next: string) => void
}

/** Rename a profile's directory. The owner re-selects the new name on `onRenamed`. */
export function RenameProfileModal({ dshId, name, open, onClose, onRenamed }: RenameProps): JSX.Element {
  const { t } = useTranslation()
  const [value, setValue] = useState(name)
  const [busy, setBusy] = useState(false)

  // Opening pre-fills the field with the current name, so a rename starts from it
  // rather than from whatever was typed and abandoned last time.
  useEffect(() => { if (open) setValue(name) }, [open, name])

  const submit = async (): Promise<void> => {
    const target = value.trim()
    if (target === '' || target === name) { onClose(); return }
    setBusy(true)
    const result = await window.api.rename(dshId, name, target)
    setBusy(false)
    if (!result.ok) { void message.error(apiErrorText(result)); return }
    onClose()
    void message.success(t('profile.workspace.renamed', { name: target }))
    onRenamed(target)
  }

  return (
    <Modal title={t('profile.workspace.renameTitle')} open={open} okText={t('common.save')} onOk={() => void submit()} onCancel={onClose} confirmLoading={busy} width={MODAL.narrow} destroyOnHidden>
      <FieldLabel>{t('profile.workspace.renameLabel')}</FieldLabel>
      <Input value={value} onChange={e => setValue(e.target.value)} onPressEnter={() => void submit()} placeholder={t('profile.create.namePlaceholder')} />
    </Modal>
  )
}

interface TransferProps {
  dshId: string
  /** The source profile; it is excluded from the target list. */
  name: string
  open: boolean
  onClose: () => void
  /** Called after a MOVE — a copy leaves this profile untouched. */
  onMoved: () => void
}

/** Copy or move this profile's patch layer into another profile of the same dsh. */
export function TransferPatchModal({ dshId, name, open, onClose, onMoved }: TransferProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [targets, setTargets] = useState<string[]>([])
  const [target, setTarget] = useState<string>()
  const [busy, setBusy] = useState(false)

  // The candidate list is loaded on open, so it reflects profiles created since the
  // workspace mounted. Reset the fields with it: a stale pick must not survive.
  useEffect(() => {
    if (!open) return undefined
    setTarget(undefined)
    let alive = true
    void window.api.listProfiles(dshId).then((result) => {
      if (alive && result.ok) setTargets(result.value.filter(p => p !== name))
    })
    return () => { alive = false }
  }, [open, dshId, name])

  const transfer = async (move: boolean): Promise<void> => {
    if (target === undefined) return
    setBusy(true)
    const result = await window.api.transferPatch(dshId, name, dshId, target, move)
    setBusy(false)
    if (!result.ok) { void message.error(apiErrorText(result)); return }
    onClose()
    void message.success(move
      ? t('profile.workspace.patchMoved', { name: target })
      : t('profile.workspace.patchCopied', { name: target }))
    if (move) onMoved()
  }

  return (
    <Modal title={t('profile.workspace.transferTitle')} open={open} footer={null} onCancel={onClose} width={MODAL.narrow} destroyOnHidden>
      <Space orientation="vertical" size="small" style={{ width: '100%' }}>
        <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>{t('profile.workspace.transferHint')}</div>
        <Select
          value={target}
          onChange={setTarget}
          placeholder={t('profile.workspace.transferPlaceholder')}
          style={{ width: '100%' }}
          options={targets.map(p => ({ value: p, label: p }))}
        />
        <Space>
          <Button type="primary" disabled={target === undefined} loading={busy} onClick={() => void transfer(false)}>{t('profile.workspace.transferCopy')}</Button>
          <Button danger disabled={target === undefined} loading={busy} onClick={() => void transfer(true)}>{t('profile.workspace.transferMove')}</Button>
        </Space>
      </Space>
    </Modal>
  )
}
