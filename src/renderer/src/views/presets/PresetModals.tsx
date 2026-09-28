/**
 * Dialogs for the presets page — split out so the list stays readable.
 *
 * Both edit only what the launcher owns: a locally authored preset's display
 * text, and the id a copy claims. A composition is never offered here: it is
 * the preset, and the row's own actions open its directory for that.
 */
import { useEffect, useState } from 'react'
import { Button, Input, InputNumber, Modal, Select, Space, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import FieldLabel from '../../components/FieldLabel.tsx'
import { MODAL } from '../../theme.ts'
import { PRESET_ID_RE } from '../../../../shared/preset.ts'
import type { PresetMetaInput, PresetRow } from '../../../../shared/types.ts'

interface PresetMetaModalProps {
  /** The preset being edited, or null when the dialog is closed. */
  preset: PresetRow | null
  saving: boolean
  onCancel: () => void
  onSubmit: (meta: PresetMetaInput) => void
}

/** Edit the three fields the launcher owns: name, description and priority. */
export function PresetMetaModal(props: PresetMetaModalProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [order, setOrder] = useState<number | null>(null)
  const { preset } = props

  // Re-seed whenever another preset is opened: one dialog instance serves them
  // all, and the previous row's text must not survive into the next.
  useEffect(() => {
    setName(preset?.name ?? '')
    setDescription(preset?.description ?? '')
    setOrder(preset?.order ?? null)
  }, [preset])

  const submit = (): void => { props.onSubmit({ name, description, order }) }

  return (
    <Modal
      open={preset !== null}
      title={t('preset.meta.title')}
      width={MODAL.narrow}
      onCancel={props.onCancel}
      footer={(
        <Space>
          <Button onClick={props.onCancel}>{t('common.cancel')}</Button>
          <Button type="primary" loading={props.saving} onClick={submit}>{t('common.save')}</Button>
        </Space>
      )}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <div>
          <FieldLabel>{t('preset.meta.name')}</FieldLabel>
          <Input
            value={name}
            autoFocus
            spellCheck={false}
            placeholder={t('preset.meta.namePlaceholder')}
            onChange={event => setName(event.target.value)}
            onPressEnter={submit}
          />
        </div>
        <div>
          <FieldLabel>{t('preset.meta.description')}</FieldLabel>
          <Input.TextArea
            value={description}
            spellCheck={false}
            autoSize={{ minRows: 2, maxRows: 5 }}
            placeholder={t('preset.meta.descriptionPlaceholder')}
            onChange={event => setDescription(event.target.value)}
          />
        </div>
        <div>
          <FieldLabel>{t('preset.meta.order')}</FieldLabel>
          <InputNumber value={order} onChange={value => setOrder(value)} style={{ width: 140 }} />
          <div style={{ marginTop: 6, color: token.colorTextTertiary, fontSize: token.fontSizeSM }}>
            {t('preset.meta.orderHint')}
          </div>
        </div>
      </Space>
    </Modal>
  )
}

interface PresetCopyModalProps {
  open: boolean
  /** The roster, as the copy's sources. */
  presets: PresetRow[]
  /** The preset the dialog opens on. */
  defaultFrom: string
  busy: boolean
  onCancel: () => void
  onSubmit: (fromId: string, toId: string, name: string) => void
}

/**
 * Create a preset by copying one — the only way to start from a built-in
 * preset, whose directory the launcher never writes to.
 */
export function PresetCopyModal(props: PresetCopyModalProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [fromId, setFromId] = useState(props.defaultFrom)
  const [toId, setToId] = useState('')
  const [name, setName] = useState('')

  // Every opening starts a fresh draft: the dialog is one instance, and a
  // half-typed id from the previous copy must not be resubmitted.
  useEffect(() => {
    if (!props.open) return
    setFromId(props.defaultFrom)
    setToId('')
    setName('')
  }, [props.open, props.defaultFrom])

  const malformed = toId !== '' && !PRESET_ID_RE.test(toId)
  const taken = props.presets.some(preset => preset.id === toId)
  const blocker = malformed
    ? t('preset.copy.badId')
    : taken ? t('preset.copy.taken') : null
  const ready = fromId !== '' && toId !== '' && blocker === null && !props.busy

  return (
    <Modal
      open={props.open}
      title={t('preset.copy.title')}
      width={MODAL.narrow}
      onCancel={props.onCancel}
      footer={(
        <Space>
          <Button onClick={props.onCancel}>{t('common.cancel')}</Button>
          <Button
            type="primary"
            disabled={!ready}
            loading={props.busy}
            onClick={() => props.onSubmit(fromId, toId, name)}
          >
            {t('preset.copy.submit')}
          </Button>
        </Space>
      )}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <div>
          <FieldLabel required>{t('preset.copy.from')}</FieldLabel>
          <Select
            value={fromId === '' ? undefined : fromId}
            style={{ width: '100%' }}
            placeholder={t('preset.copy.fromPlaceholder')}
            onChange={setFromId}
            options={props.presets.map(preset => ({
              value: preset.id,
              label: preset.name === undefined ? preset.id : `${preset.name} (${preset.id})`,
            }))}
          />
        </div>
        <div>
          <FieldLabel required>{t('preset.copy.id')}</FieldLabel>
          <Input
            value={toId}
            autoFocus
            spellCheck={false}
            placeholder={t('preset.copy.idPlaceholder')}
            onChange={event => setToId(event.target.value)}
          />
        </div>
        <div>
          <FieldLabel>{t('preset.copy.name')}</FieldLabel>
          <Input
            value={name}
            spellCheck={false}
            placeholder={t('preset.copy.namePlaceholder')}
            onChange={event => setName(event.target.value)}
          />
        </div>
        {blocker === null ? null : <div style={{ color: token.colorError }} role="alert">{blocker}</div>}
      </Space>
    </Modal>
  )
}
