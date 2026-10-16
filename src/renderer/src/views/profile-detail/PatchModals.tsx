/**
 * The two remaining patch dialogs: the new-row form and the raw source editor.
 *
 * Editing an existing row's config or insert list is NOT here: that editor lives in
 * the layer pane itself (`LayerDetail`), which replaces the row's detail view with
 * it. A dialog on top of the layer dialog hid the row list exactly when the user
 * needed it — to check which row, which file, and who overrides it.
 *
 * Each of these owns its inputs and its submit, so the workspace passes an open flag
 * plus a "a write landed" callback. Neither needs the composed layer stack.
 */
import { lazy, Suspense, useEffect, useState } from 'react'
import { Input, Modal, Select, Space, theme, message } from 'antd'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../../lib/ipc.ts'
import FieldLabel from '../../components/FieldLabel.tsx'
import { MODAL } from '../../theme.ts'
import type { RowCreateInput } from '../../../../shared/types.ts'

// The Monaco wrapper pulls the whole editor; keep it out of the first parse.
const CodeEditor = lazy(() => import('../../components/CodeEditor.tsx'))

/** Props shared by the dialogs: the profile they write to, and what to do after. */
interface DialogProps {
  dshId: string
  name: string
  onClose: () => void
  /** A write landed — the owner must reload the composed stack. */
  onSaved: () => void
}

/** Add a new row to the profile's own patch layer. */
export function NewRowModal({ dshId, name, open, onClose, onSaved }: DialogProps & { open: boolean }): JSX.Element {
  const { t } = useTranslation()
  const [id, setId] = useState('')
  const [disabled, setDisabled] = useState(false)
  const [config, setConfig] = useState('')
  const [insert, setInsert] = useState('')

  const submit = async (): Promise<void> => {
    const rowId = id.trim()
    if (rowId === '') { void message.warning(t('profile.detail.rowIdEmpty')); return }
    const row: RowCreateInput = { id: rowId, disabled }
    const cfg = config.trim()
    const items = insert.split('\n').map(line => line.trim()).filter(Boolean)
    // A row carries an override OR an insert list, never both — the same choice the
    // host's own loader makes.
    if (cfg !== '') row.config = cfg
    else if (items.length > 0) row.insert = items
    const result = await window.api.addRow(dshId, name, row)
    if (!result.ok) { void message.error(apiErrorText(result)); return }
    onClose()
    setId('')
    setDisabled(false)
    setConfig('')
    setInsert('')
    void message.success(t('profile.created'))
    onSaved()
  }

  return (
    <Modal title={t('profile.detail.newRowModalTitle')} open={open} okText={t('profile.create.create')} onOk={() => void submit()} onCancel={onClose} destroyOnHidden width={MODAL.wide}>
      <Space orientation="vertical" style={{ width: '100%' }} size="small">
        <div><FieldLabel>{t('profile.detail.newRow.id')}</FieldLabel><Input value={id} onChange={e => setId(e.target.value)} placeholder="- id: xxx" /></div>
        <div><FieldLabel>{t('profile.detail.newRow.status')}</FieldLabel><Select value={disabled} onChange={setDisabled} style={{ width: '100%' }} options={[{ value: false, label: t('profile.detail.newRow.enabled') }, { value: true, label: t('profile.detail.newRow.disabled') }]} /></div>
        <div><FieldLabel>{t('profile.detail.newRow.config')}</FieldLabel><Input.TextArea rows={4} value={config} onChange={e => setConfig(e.target.value)} placeholder={'key: value\nnested:\n  a: 1'} /></div>
        <div><FieldLabel>{t('profile.detail.newRow.insert')}</FieldLabel><Input.TextArea rows={3} value={insert} onChange={e => setInsert(e.target.value)} placeholder={t('profile.detail.editor.insertPlaceholder')} /></div>
      </Space>
    </Modal>
  )
}

/** Edit the profile's `cordis.patch.yml` itself, as raw YAML. */
export function SourceEditModal({ dshId, name, open, onClose, onSaved }: DialogProps & { open: boolean }): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return undefined
    setLoading(true)
    let alive = true
    void window.api.readFile(dshId, name, 'patch').then((result) => {
      if (!alive) return
      setLoading(false)
      if (result.ok) { setText(result.value.text); return }
      // Nothing to edit — report and get out of the way.
      void message.error(apiErrorText(result))
      onClose()
    })
    return () => { alive = false }
  }, [open, dshId, name, onClose])

  const submit = async (): Promise<void> => {
    setSaving(true)
    const result = await window.api.writeFile(dshId, name, 'patch', text)
    setSaving(false)
    if (!result.ok) { void message.error(apiErrorText(result)); return }
    onClose()
    void message.success(t('profile.detail.sourceSaved'))
    onSaved()
  }

  const waiting = <div style={{ height: 420, display: 'flex', alignItems: 'center', justifyContent: 'center', color: token.colorTextTertiary }}>{t('common.loading')}</div>

  return (
    <Modal title={t('profile.detail.sourceTitle')} open={open} okText={t('common.save')} onOk={() => void submit()} onCancel={onClose} confirmLoading={saving} width={MODAL.wide} destroyOnHidden>
      {loading ? waiting : <Suspense fallback={waiting}><CodeEditor value={text} language="yaml" onChange={setText} height={420} /></Suspense>}
    </Modal>
  )
}
