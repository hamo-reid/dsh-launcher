/**
 * Dialogs for the presets page — split out so the list stays readable.
 *
 * Both edit only what the launcher owns: a preset's display text, and the id a
 * new preset claims. The plugin list is never offered here: it is the preset, and
 * the row's own actions open the file that carries it.
 */
import { useEffect, useState } from 'react'
import { Button, Input, InputNumber, Modal, Segmented, Select, Space, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import FieldLabel from '../../components/FieldLabel.tsx'
import { MODAL } from '../../theme.ts'
import { presetCreateBlock, presetCreateReady } from '../../lib/presetCreate.ts'
import type { PresetListItem, PresetMetaInput } from '../../../../shared/types.ts'

interface PresetMetaModalProps {
  /** The preset being edited, or null when the dialog is closed. */
  preset: PresetListItem | null
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
      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
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

/** Where a new preset starts from. */
export type PresetCreateMode = 'minimal' | 'copy'

interface PresetCreateModalProps {
  open: boolean
  /** The mode the dialog opens on; the minimal one falls back to a copy when
   * this dsh ships no such preset. */
  initialMode: PresetCreateMode
  /** The roster, as the copy mode's sources. */
  presets: PresetListItem[]
  /** Every id already in use here — the roster's PLUS the directories the
   * retired root keeps, which the roster does not show but the core still
   * refuses. See {@link presetCreateBlock}. */
  takenIds: ReadonlySet<string>
  /** The built-in minimal preset to start from, or null when this dsh has none. */
  minimalId: string | null
  /** The preset the copy mode opens on. */
  defaultFrom: string
  busy: boolean
  onCancel: () => void
  onSubmit: (mode: PresetCreateMode, fromId: string, toId: string, name: string) => void
}

/** The dialog's body, controlled by its owner.
 *
 * Split out for the same reason as `InstallSkillFields`: an antd `Modal` renders
 * through a portal, so nothing inside it exists in a server render — and this
 * body is where the "already taken" line has to be visible. */
export interface PresetCreateFieldsProps {
  mode: PresetCreateMode
  onMode: (mode: PresetCreateMode) => void
  minimalId: string | null
  presets: PresetListItem[]
  fromId: string
  onFromId: (id: string) => void
  toId: string
  onToId: (id: string) => void
  name: string
  onName: (name: string) => void
  /** What is wrong with the draft, already localized, or null. */
  blocker: string | null
}

/** The fields of the create dialog: where to start from, the new id, its name. */
export function PresetCreateFields(props: PresetCreateFieldsProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  return (
    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
      <Segmented
        block
        value={props.mode}
        onChange={value => props.onMode(value as PresetCreateMode)}
        options={[
          { value: 'minimal', label: t('preset.create.minimal'), disabled: props.minimalId === null },
          { value: 'copy', label: t('preset.create.copy') },
        ]}
      />
      {props.mode === 'copy'
        ? (
          <div>
            <FieldLabel required>{t('preset.create.from')}</FieldLabel>
            <Select
              value={props.fromId === '' ? undefined : props.fromId}
              style={{ width: '100%' }}
              placeholder={t('preset.create.fromPlaceholder')}
              onChange={props.onFromId}
              options={props.presets.map(preset => ({
                value: preset.id,
                label: preset.name === undefined ? preset.id : `${preset.name} (${preset.id})`,
              }))}
            />
          </div>
        )
        : (
          <div style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM }}>
            {props.minimalId === null
              ? t('preset.create.noMinimal')
              : t('preset.create.minimalHint', { id: props.minimalId })}
          </div>
        )}
      <div>
        <FieldLabel required>{t('preset.create.id')}</FieldLabel>
        <Input
          value={props.toId}
          autoFocus
          spellCheck={false}
          placeholder={t('preset.create.idPlaceholder')}
          onChange={event => props.onToId(event.target.value)}
        />
      </div>
      <div>
        <FieldLabel>{t('preset.create.name')}</FieldLabel>
        <Input
          value={props.name}
          spellCheck={false}
          placeholder={t('preset.create.namePlaceholder')}
          onChange={event => props.onName(event.target.value)}
        />
      </div>
      {props.blocker === null ? null : <div style={{ color: token.colorError }} role="alert">{props.blocker}</div>}
    </Space>
  )
}

/**
 * Create a preset: from the deployment's minimal preset, or from a copy of any
 * preset already on the roster. Either way the new preset's plugin list is the
 * source's, copied verbatim, so it is exactly as loadable as what it started
 * from — which is the point of offering the minimal preset, since every other
 * preset is a variation on a big one.
 */
export function PresetCreateModal(props: PresetCreateModalProps): JSX.Element {
  const { t } = useTranslation()
  const [mode, setMode] = useState<PresetCreateMode>(props.initialMode)
  const [fromId, setFromId] = useState(props.defaultFrom)
  const [toId, setToId] = useState('')
  const [name, setName] = useState('')

  // Every opening starts a fresh draft: the dialog is one instance, and a
  // half-typed id from the previous preset must not be resubmitted.
  useEffect(() => {
    if (!props.open) return
    setMode(props.initialMode === 'minimal' && props.minimalId === null ? 'copy' : props.initialMode)
    setFromId(props.defaultFrom)
    setToId('')
    setName('')
  }, [props.open, props.initialMode, props.defaultFrom, props.minimalId])

  const takenIds = props.takenIds
  const block = presetCreateBlock({ toId, takenIds })
  const blocker = block === 'badId'
    ? t('preset.create.badId')
    : block === 'taken' ? t('preset.create.taken') : null
  const source = mode === 'minimal' ? props.minimalId ?? '' : fromId
  const ready = presetCreateReady({ toId, takenIds, source, busy: props.busy })

  return (
    <Modal
      open={props.open}
      title={t('preset.create.title')}
      width={MODAL.narrow}
      onCancel={props.onCancel}
      footer={(
        <Space>
          <Button onClick={props.onCancel}>{t('common.cancel')}</Button>
          <Button
            type="primary"
            disabled={!ready}
            loading={props.busy}
            onClick={() => props.onSubmit(mode, source, toId, name)}
          >
            {t('preset.create.submit')}
          </Button>
        </Space>
      )}
    >
      <PresetCreateFields
        mode={mode}
        onMode={setMode}
        minimalId={props.minimalId}
        presets={props.presets}
        fromId={fromId}
        onFromId={setFromId}
        toId={toId}
        onToId={setToId}
        name={name}
        onName={setName}
        blocker={blocker}
      />
    </Modal>
  )
}
