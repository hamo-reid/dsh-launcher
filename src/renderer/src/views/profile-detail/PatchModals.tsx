/**
 * The three patch-row dialogs: the row editor (a config override or an insert
 * list), the new-row form, and the raw source editor.
 *
 * Each owns its inputs and its submit, so the workspace passes an open flag (or the
 * editor's target) plus a "a write landed" callback. None of them needs the composed
 * layer stack — the editor's only input from it is the overlap note, which the
 * workspace resolves before opening.
 */
import { lazy, Suspense, useEffect, useState } from 'react'
import { Alert, Input, Modal, Select, Space, theme, message } from 'antd'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../../lib/ipc.ts'
import FieldLabel from '../../components/FieldLabel.tsx'
import { MODAL } from '../../theme.ts'
import type { RowCreateInput } from '../../../../shared/types.ts'

// The Monaco wrapper pulls the whole editor; keep it out of the first parse.
const CodeEditor = lazy(() => import('../../components/CodeEditor.tsx'))

/** Which editor a row's action opens — the config override or the insert list. */
export type RowEditKind = 'config' | 'insert'

/** The row an open editor is editing, as the workspace resolved it. `overlap` names
 * the other layer serving this row, when there is one. */
export interface EditorTarget {
  id: string
  kind: RowEditKind
  overlap: string | null
}

/** Props shared by the dialogs: the profile they write to, and what to do after. */
interface DialogProps {
  dshId: string
  name: string
  onClose: () => void
  /** A write landed — the owner must reload the composed stack. */
  onSaved: () => void
}

/** Edit one existing row's config override or insert list. */
export function PatchRowEditorModal({ dshId, name, target, onClose, onSaved }: DialogProps & { target: EditorTarget | null }): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [text, setText] = useState('')
  const [defaultText, setDefaultText] = useState('')
  const [saving, setSaving] = useState(false)

  // Load the row's current content (and, for a config row, the bundle default it
  // replaces) when a target arrives. The guard drops a response that belongs to a
  // row the user has since switched away from.
  useEffect(() => {
    setText('')
    setDefaultText('')
    if (target === null || target.kind !== 'config') return undefined
    let alive = true
    void window.api.configInfo(dshId, name, target.id).then((result) => {
      if (!alive || !result.ok) return
      setDefaultText(result.value.default)
      setText(result.value.current)
    })
    return () => { alive = false }
  }, [target, dshId, name])

  const submit = async (): Promise<void> => {
    if (target === null) return
    setSaving(true)
    let result
    if (target.kind === 'config') {
      if (text.trim() === '') { void message.warning(t('profile.detail.configEmpty')); setSaving(false); return }
      result = await window.api.setRowConfig(dshId, name, target.id, text)
    } else {
      const items = text.split('\n').map(line => line.trim()).filter(Boolean)
      if (items.length === 0) { void message.warning(t('profile.detail.insertEmpty')); setSaving(false); return }
      result = await window.api.addRow(dshId, name, { id: target.id, insert: items })
    }
    setSaving(false)
    if (!result.ok) { void message.error(apiErrorText(result)); return }
    onClose()
    void message.success(target.kind === 'config' ? t('profile.detail.savedConfig') : t('profile.detail.savedInsert'))
    onSaved()
  }

  return (
    <Modal title={target !== null ? (target.kind === 'config' ? t('profile.detail.editor.configTitle', { id: target.id }) : t('profile.detail.editor.insertTitle', { id: target.id })) : ''} open={target !== null} okText={t('common.save')} onOk={() => void submit()} onCancel={onClose} confirmLoading={saving} destroyOnHidden width={MODAL.wide}>
      <Space orientation="vertical" style={{ width: '100%' }} size="small">
        {target?.overlap !== null && (
          <Alert type="warning" showIcon title={t('profile.detail.editor.overlap', { owner: target?.overlap })} description={t('profile.detail.editor.overlapDesc')} />
        )}
        {target?.kind === 'config' ? (
          <>
            <FieldLabel>{t('profile.detail.editor.configReplaces')}</FieldLabel>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: token.paddingSM, marginTop: token.paddingSM }}>
              <div>
                <FieldLabel>{t('profile.detail.editor.default')}</FieldLabel>
                <pre style={{ margin: 0, minHeight: 180, maxHeight: 320, overflowY: 'auto', background: token.colorFillTertiary, padding: token.paddingSM, borderRadius: token.borderRadius, fontSize: token.fontSizeSM, lineHeight: '1.5' }}>
                  {defaultText === '' ? <span style={{ color: token.colorTextTertiary }}>{t('profile.detail.editor.noDefault')}</span> : defaultText.split('\n').map((line, i) => {
                    // Highlight the default's lines that the override drops, so the
                    // replacement is readable at a glance.
                    const differs = !text.split('\n').includes(line) && text.trim() !== ''
                    return <div key={i} style={{ background: differs ? 'rgba(255,77,79,0.16)' : undefined, whiteSpace: 'pre' }}>{line}</div>
                  })}
                </pre>
              </div>
              <div>
                <FieldLabel>{t('profile.detail.editor.override')}</FieldLabel>
                <Input.TextArea rows={8} value={text} onChange={e => setText(e.target.value)} placeholder={'key: value\nnested:\n  a: 1'} style={{ maxHeight: 320 }} />
              </div>
            </div>
          </>
        ) : (
          <>
            <FieldLabel>{t('profile.detail.editor.insertList')}</FieldLabel>
            <Input.TextArea rows={6} value={text} onChange={e => setText(e.target.value)} placeholder={t('profile.detail.editor.insertPlaceholder')} />
          </>
        )}
      </Space>
    </Modal>
  )
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
