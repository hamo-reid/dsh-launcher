/**
 * One composed layer's rows, as a two-pane view: the row list on the left, the
 * selected row's detail on the right.
 *
 * Why the split: a row carries four separate facts (disabled? a config? an insert
 * list? overridden by whom?) plus up to four actions, and laid out side by side in
 * a single line they squeezed the row's own NAME — the one thing that identifies
 * the row — into an ellipsis. The list now answers "which rows are there, and what
 * do they carry" in tags, and the pane answers "what is this one, and what can I do
 * to it".
 *
 * The actions are the LAYER's, not a preference: a row a bundle ships can only be
 * covered into the profile layer (that copy is what makes it editable), the home
 * layer's rows can only be toggled, and only the profile's own rows can be rewritten
 * or dropped. `rowActionsOf` decides that once, so the two panes cannot disagree —
 * and the buttons sit at the TOP of the detail, above what they act on.
 *
 * A row's config text is deliberately NOT in the layer payload: it would have to be
 * carried for every row of every layer, and the payload is already the whole stack.
 * It is fetched per selection instead, and shown under the owners it belongs to: the
 * bundle may ship one and this profile's layer may override it.
 *
 * Editing is PROGRESSIVE, inside this pane: 配置 / 插入 replace the detail view with
 * the editor and a way back, instead of stacking a second dialog on top of this one.
 * The row being edited stays on screen (its card, the layer's other rows) and nothing
 * has to be reopened to check what it was; the draft lives in the editor, so leaving
 * discards it exactly as the old dialog's cancel did.
 */
import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Input, Spin, Tag, message, theme } from 'antd'
import { ArrowLeftOutlined, SearchOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import ActionCard from '../../components/ActionCard.tsx'
import FieldLabel from '../../components/FieldLabel.tsx'
import StatusTag from '../../components/StatusTag.tsx'
import { apiErrorText } from '../../lib/ipc.ts'
import {
  fileNameLabel, layerRowEntries, rowActionsOf, rowMatchesQuery, type LayerLabel, type LayerRowEntry,
} from '../../lib/profileLayers.ts'
import type { ClassifiedRow, ProfileLayer } from '../../../../shared/types.ts'

/** Which editor a row's action opens — the config override or the insert list. */
export type EditKind = 'config' | 'insert'

const MONO = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' } as const

interface Props {
  layer: ProfileLayer
  /** Which layer serves each row id, so a row overridden elsewhere can say so. */
  lastSeen: Map<string, LayerLabel>
  dshId: string
  name: string
  /** Enable/disable the row in THIS layer. */
  onToggle: (id: string, disabled: boolean) => void
  /** Copy a bundle's row into the profile layer as an editable override. */
  onCover: (id: string) => void
  /** Drop the profile layer's override of a row (its bundle default returns). */
  onRemoveCover: (id: string) => void
  /** Add a row to the profile's own layer — only that layer has the entry. */
  onNewRow?: () => void
  /** A row was written — the owner must reload the composed stack. */
  onSaved: () => void
}

export default function LayerDetail({
  layer, lastSeen, dshId, name, onToggle, onCover, onRemoveCover, onNewRow, onSaved,
}: Props): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const actions = rowActionsOf(layer)
  const entries = useMemo(() => layerRowEntries(layer), [layer])

  // Labels travel as i18n keys, so any comparison between two of them happens on
  // their text.
  const labelTextOf = (label: LayerLabel): string => t(label.key, label.options)

  /** The row's own file is not an "override"; any other file serving it is. */
  const overrideOf = (entry: LayerRowEntry): string | undefined => {
    const seen = lastSeen.get(entry.row.id)
    if (seen === undefined) return undefined
    const text = labelTextOf(seen)
    return text !== labelTextOf(fileNameLabel(layer, entry.file)) ? text : undefined
  }

  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  // The list the search box leaves. The selection resolves against the VISIBLE
  // rows, so filtering the selected row away moves the pane to the first row shown
  // rather than leaving a detail for something no longer on screen.
  const visible = useMemo(() => entries.filter(entry => rowMatchesQuery(entry.row, query)), [entries, query])
  // The first row is the selection until the user picks another, so the pane is
  // never blank while rows exist. After a delete the old key resolves to nothing
  // and the neighbour takes over — the highlight follows `selected.key`, not the
  // stale state, so the two panes stay in step.
  const selected = visible.find(entry => entry.key === selectedKey) ?? visible[0]
  const selectedId = selected?.row.id
  const selectedHasConfig = selected?.row.hasConfig ?? false

  const [config, setConfig] = useState<{ default: string; current: string } | null>(null)
  const [configLoading, setConfigLoading] = useState(false)
  // The editor belongs to the row it was opened ON: selecting another row (or
  // filtering this one away) closes it instead of silently retargeting the draft at
  // a different row.
  const [editing, setEditing] = useState<{ key: string; kind: EditKind } | null>(null)
  const [saving, setSaving] = useState(false)
  const editingKind = editing !== null && editing.key === selected?.key ? editing.kind : null
  // The config text is asked for when the row HAS one (the detail view states it)
  // and when the config editor opens on a row that has none yet — adding a config
  // to such a row is exactly what that editor is for.
  const needsConfig = selectedHasConfig || editingKind === 'config'
  useEffect(() => {
    setConfig(null)
    setConfigLoading(false)
    if (!needsConfig || selectedId === undefined) return undefined
    let alive = true
    setConfigLoading(true)
    void window.api.configInfo(dshId, name, selectedId).then((result) => {
      if (!alive) return
      setConfigLoading(false)
      setConfig(result.ok ? result.value : null)
    })
    return () => { alive = false }
  }, [dshId, name, selectedId, needsConfig])

  /** Write the draft the editor handed back. A refuses-empty check mirrors the host:
   * a config override must be a mapping, an insert list must have an item. */
  const saveRow = async (kind: EditKind, draft: string): Promise<void> => {
    if (selected === undefined) return
    const id = selected.row.id
    if (kind === 'config' && draft.trim() === '') { void message.warning(t('profile.detail.configEmpty')); return }
    const items = draft.split('\n').map(line => line.trim()).filter(Boolean)
    if (kind === 'insert' && items.length === 0) { void message.warning(t('profile.detail.insertEmpty')); return }
    setSaving(true)
    const result = kind === 'config'
      ? await window.api.setRowConfig(dshId, name, id, draft)
      : await window.api.addRow(dshId, name, { id, insert: items })
    setSaving(false)
    if (!result.ok) { void message.error(apiErrorText(result)); return }
    setEditing(null)
    void message.success(kind === 'config' ? t('profile.detail.savedConfig') : t('profile.detail.savedInsert'))
    onSaved()
  }

  const many = layer.files.length > 1

  return (
    <div style={{ display: 'flex', gap: token.paddingLG, alignItems: 'stretch' }}>
      {/* ── Left: how many rows, a way to find one, and the rows as cards ───── */}
      <div
        style={{
          flex: '0 0 280px',
          height: 420,
          display: 'flex',
          flexDirection: 'column',
          paddingRight: token.padding,
          borderRight: `1px solid ${token.colorSplit}`,
        }}
      >
        {/* The header stays put while the list scrolls: a search box that scrolls
            out of reach is worse than no search box. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingBottom: 8 }}>
          <div style={{ fontSize: token.fontSizeSM, color: token.colorTextSecondary }}>
            {query.trim() === ''
              ? t('profile.detail.layerMeta', { count: entries.length })
              : t('profile.detail.rowCountFiltered', { shown: visible.length, total: entries.length })}
          </div>
          <Input
            size="small"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={t('profile.detail.searchPlaceholder')}
            aria-label={t('profile.detail.searchPlaceholder')}
            prefix={<SearchOutlined style={{ color: token.colorTextTertiary }} />}
            allowClear
          />
          {layer.source === 'profile' && onNewRow !== undefined && (
            <Button type="dashed" block onClick={onNewRow}>{t('profile.detail.newRow')}</Button>
          )}
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {entries.length === 0
            ? <div style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM }}>{t('profile.detail.layerNoRows')}</div>
            : visible.length === 0
              ? <div style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM }}>{t('profile.detail.noMatch')}</div>
              : visible.map((entry, index) => (
                // A bundle composing several patch files says which file a row came
                // from — the file, not the bundle, is what has to change.
                <div key={entry.key}>
                  {many && (index === 0 || visible[index - 1].file !== entry.file) && (
                    <div style={{ ...MONO, fontSize: token.fontSizeSM, color: token.colorTextTertiary, padding: index === 0 ? '0 0 4px' : '12px 0 4px' }}>
                      {entry.file}
                    </div>
                  )}
                  <RowCard
                    row={entry.row}
                    selected={entry.key === selected?.key}
                    override={overrideOf(entry)}
                    onSelect={() => setSelectedKey(entry.key)}
                  />
                </div>
              ))}
        </div>
      </div>

      {/* ── Right: the selected row — its detail, or the editor it opened ───── */}
      <div style={{ flex: 1, minWidth: 0, height: 420, overflowY: 'auto' }}>
        {selected === undefined
          ? (
            <div style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM }}>
              {entries.length === 0
                ? t('profile.detail.layerNoRows')
                : (visible.length === 0 ? t('profile.detail.noMatch') : t('profile.detail.pickRow'))}
            </div>
          )
          : editingKind !== null
            ? (configLoading
              ? <Spin size="small" />
              : (
                // Keyed by row + kind, so switching rows (or the editor) mounts a
                // fresh draft instead of carrying one over.
                <RowEditor
                  key={`${selected.key}:${editingKind}`}
                  kind={editingKind}
                  row={selected.row}
                  override={overrideOf(selected)}
                  defaultText={config?.default ?? ''}
                  initial={config?.current ?? ''}
                  saving={saving}
                  onBack={() => setEditing(null)}
                  onSave={draft => void saveRow(editingKind, draft)}
                />
              ))
            : (
              <RowDetail
                row={selected.row}
                actions={actions}
                override={overrideOf(selected)}
                config={config}
                configLoading={configLoading}
                onToggle={onToggle}
                onCover={onCover}
                onEdit={kind => setEditing({ key: selected.key, kind })}
                onRemoveCover={onRemoveCover}
              />
            )}
      </div>
    </div>
  )
}

/** What a row carries, as tags. One definition, used by the card and the pane, so
 * the two can never tell different stories about the same row.
 *
 * `short` is the list's form of the override note: the layer that did the
 * overriding is a long bundle-path label, and in a 280px card it pushed the tags
 * it sat next to onto another line. The card says THAT the row is overridden; the
 * pane, which has the room, says by what. */
function RowTags({ row, override, short = false }: { row: ClassifiedRow; override?: string; short?: boolean }): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
      <StatusTag tone={row.disabled ? 'disabled' : 'enabled'}>
        {row.disabled ? t('profile.detail.disabled') : t('profile.detail.enabled')}
      </StatusTag>
      {row.hasConfig && <Tag style={{ marginInlineEnd: 0 }}>config</Tag>}
      {row.hasInsert && <Tag style={{ marginInlineEnd: 0 }}>insert</Tag>}
      {override !== undefined && (
        <Tag style={{ marginInlineEnd: 0, color: token.colorTextTertiary, borderColor: token.colorBorder }}>
          {short ? t('profile.detail.overriddenShort') : t('profile.detail.overridden', { override })}
        </Tag>
      )}
    </span>
  )
}

/** One row in the left list. Exported for the render test: the pane's data arrives
 * through IPC, which a server-rendered test does not run. */
export function RowCard({ row, selected, override, onSelect }: {
  row: ClassifiedRow
  selected: boolean
  override?: string
  onSelect: () => void
}): JSX.Element {
  return (
    <ActionCard
      title={<span style={MONO}>{row.name ?? row.id}</span>}
      meta={<RowTags row={row} override={override} short />}
      selected={selected}
      hoverable
      onClick={onSelect}
    />
  )
}

/** The selected row: what it is, what this layer lets you do to it, and the config
 * it carries. Exported for the render test (see `RowCard`). */
export function RowDetail({
  row, actions, override, config, configLoading, onToggle, onCover, onEdit, onRemoveCover,
}: {
  row: ClassifiedRow
  actions: ReturnType<typeof rowActionsOf>
  override?: string
  /** The fetched config, `null` while unloaded or when the row carries none. */
  config: { default: string; current: string } | null
  configLoading: boolean
  onToggle: (id: string, disabled: boolean) => void
  onCover: (id: string) => void
  /** Open this pane's editor for the row — the pane, not a dialog above it. */
  onEdit: (kind: EditKind) => void
  onRemoveCover: (id: string) => void
}): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const empty = config === null || (config.default === '' && config.current === '')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: token.paddingSM }}>
      <div>
        <div style={{ ...MONO, fontWeight: 600, wordBreak: 'break-all' }}>{row.name ?? row.id}</div>
        {/* With a display name the id is the half a user needs to edit the file. */}
        {row.name !== undefined && (
          <div style={{ ...MONO, fontSize: token.fontSizeSM, color: token.colorTextTertiary }}>{row.id}</div>
        )}
        <div style={{ marginTop: 6 }}><RowTags row={row} override={override} /></div>
      </div>

      {/* The layer's actions, above what they act on. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {actions.canToggle && (
          <Button size="small" onClick={() => onToggle(row.id, !row.disabled)}>
            {row.disabled ? t('profile.detail.row.enable') : t('profile.detail.row.disable')}
          </Button>
        )}
        {actions.canCover && <Button size="small" onClick={() => onCover(row.id)}>{t('profile.detail.row.cover')}</Button>}
        {actions.canEdit && <Button size="small" onClick={() => onEdit('config')}>{t('profile.detail.row.config')}</Button>}
        {actions.canEdit && <Button size="small" onClick={() => onEdit('insert')}>{t('profile.detail.row.insert')}</Button>}
        {actions.canDelete && (
          <Button size="small" danger type="text" onClick={() => onRemoveCover(row.id)}>{t('profile.detail.row.delete')}</Button>
        )}
      </div>

      <div style={{ borderTop: `1px solid ${token.colorSplit}`, paddingTop: token.paddingSM }}>
        <div style={{ fontSize: token.fontSizeSM, color: token.colorTextSecondary, marginBottom: 6 }}>{t('profile.detail.configTitle')}</div>
        {configLoading
          ? <Spin size="small" />
          : empty
            ? <div style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM }}>{t('profile.detail.noConfig')}</div>
            : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: token.paddingSM }}>
                {config.default !== '' && <ConfigBlock label={t('profile.detail.editor.default')} text={config.default} />}
                {config.current !== '' && <ConfigBlock label={t('profile.detail.configCurrent')} text={config.current} />}
              </div>
            )}
        {row.hasInsert && (
          <div style={{ marginTop: token.paddingSM, color: token.colorTextTertiary, fontSize: token.fontSizeSM }}>
            {t('profile.detail.insertHint')}
          </div>
        )}
      </div>
    </div>
  )
}

/** One config text, read-only, under the owner that wrote it. */
function ConfigBlock({ label, text }: { label: string; text: string }): JSX.Element {
  const { token } = theme.useToken()
  return (
    <div>
      <div style={{ fontSize: token.fontSizeSM, color: token.colorTextTertiary, marginBottom: 4 }}>{label}</div>
      <pre style={{
        ...MONO,
        margin: 0,
        padding: token.paddingSM,
        borderRadius: token.borderRadius,
        background: token.colorFillTertiary,
        fontSize: token.fontSizeSM,
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}>
        {text}
      </pre>
    </div>
  )
}

/**
 * The pane's editor for one row: a config override or an insert list.
 *
 * It replaces the detail view rather than opening a dialog above it, so the row
 * list and the row's own card stay visible while the text is written, and leaving
 * (返回) is one click instead of a close. The draft lives HERE: the parent keys this
 * component by row + kind, so switching rows mounts a fresh draft — the same
 * "leaving discards it" the dialog's cancel used to mean, without a dialog.
 *
 * For a config the bundle's default stays on screen above the editor: an override is
 * a FULL replacement, so what is being replaced has to be readable while writing,
 * and the lines it drops are flagged.
 *
 * Exported for the render test (see `RowCard`).
 */
export function RowEditor({
  kind, row, override, defaultText, initial, saving, onBack, onSave,
}: {
  kind: EditKind
  row: ClassifiedRow
  override?: string
  /** The config the bundle ships for this row — what an override replaces. */
  defaultText: string
  /** This profile layer's current text (`''` when it has none). */
  initial: string
  saving: boolean
  onBack: () => void
  onSave: (draft: string) => void
}): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [draft, setDraft] = useState(initial)
  const dropped = (line: string): boolean => !draft.split('\n').includes(line) && draft.trim() !== ''

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: token.paddingSM }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <Button size="small" icon={<ArrowLeftOutlined />} onClick={onBack}>{t('profile.detail.editor.back')}</Button>
        <span style={{ ...MONO, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {kind === 'config'
            ? t('profile.detail.editor.configTitle', { id: row.id })
            : t('profile.detail.editor.insertTitle', { id: row.id })}
        </span>
      </div>

      {override !== undefined && (
        <Alert
          type="warning"
          showIcon
          title={t('profile.detail.editor.overlap', { owner: override })}
          description={t('profile.detail.editor.overlapDesc')}
        />
      )}

      {kind === 'config'
        ? (
          <>
            <div>
              <FieldLabel>{t('profile.detail.editor.default')}</FieldLabel>
              <pre style={{
                ...MONO,
                margin: 0,
                maxHeight: 160,
                overflowY: 'auto',
                padding: token.paddingSM,
                borderRadius: token.borderRadius,
                background: token.colorFillTertiary,
                fontSize: token.fontSizeSM,
                lineHeight: 1.5,
              }}>
                {defaultText === ''
                  ? <span style={{ color: token.colorTextTertiary }}>{t('profile.detail.editor.noDefault')}</span>
                  : defaultText.split('\n').map((line, i) => (
                    <div key={i} style={{ background: dropped(line) ? 'rgba(255,77,79,0.16)' : undefined, whiteSpace: 'pre' }}>{line}</div>
                  ))}
              </pre>
            </div>
            <div>
              <FieldLabel>{t('profile.detail.editor.override')}</FieldLabel>
              {/* An override is a full replacement: keys left out fall back, which is
                  exactly what the flagged lines above show. */}
              <div style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM, marginBottom: 4 }}>
                {t('profile.detail.editor.configReplaces')}
              </div>
              <Input.TextArea
                rows={8}
                value={draft}
                onChange={event => setDraft(event.target.value)}
                placeholder={'key: value\nnested:\n  a: 1'}
              />
            </div>
          </>
        )
        : (
          <>
            {/* The list cannot be read back (see the layer payload), so the editor
                starts empty and saving replaces whatever is there — say so. */}
            <Alert type="warning" showIcon title={t('profile.detail.editor.insertReplaces')} />
            <div>
              <FieldLabel>{t('profile.detail.editor.insertList')}</FieldLabel>
              <Input.TextArea
                rows={6}
                value={draft}
                onChange={event => setDraft(event.target.value)}
                placeholder={t('profile.detail.editor.insertPlaceholder')}
              />
            </div>
          </>
        )}

      <div>
        <Button type="primary" size="small" loading={saving} onClick={() => onSave(draft)}>{t('common.save')}</Button>
      </div>
    </div>
  )
}
