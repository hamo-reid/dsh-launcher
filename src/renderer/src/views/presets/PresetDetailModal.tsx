/**
 * One preset's contents: what it is made of, and what those rows amount to under
 * the profile the page is showing.
 *
 * The rows are the preset — the host starts them in order — so this is the one
 * thing about a preset the roster row cannot say. What it deliberately does NOT
 * show is each row's `config`: that is plugin-private data (docs/presets.md
 * section 4.1), and the launcher reports on a preset, it does not edit one.
 *
 * The body is split out and exported for the same reason as `PresetCreateFields`:
 * an antd `Modal` renders through a portal, so nothing inside it exists in a
 * server render — and the row sections are exactly what has to be asserted.
 */
import { Button, Dropdown, Space, Tag, Tooltip, Typography, theme } from 'antd'
import { CodeOutlined, DownOutlined, FolderOpenOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import ScrollModal from '../../components/ScrollModal.tsx'
import { MODAL } from '../../theme.ts'
import {
  PRESET_SOURCE_KEY, presetGradeColour, presetGradeLabel, presetRowSections,
} from '../../lib/presetRow.ts'
import type {
  PresetCompositionRow, PresetGrade, PresetListItem, PresetRowKind, PresetRowState,
} from '../../../../shared/types.ts'

/** The section each row state reads as. `as const` keeps the values literal so
 * `t()` can typecheck a looked-up key. */
const SECTION_KEY = {
  missing: 'preset.rows.section.missing',
  conditional: 'preset.rows.section.conditional',
  skipped: 'preset.rows.section.skipped',
  found: 'preset.rows.section.found',
} as const satisfies Record<PresetRowState, string>

/** Why that section is what it is, said once per section rather than per row. */
const SECTION_HINT_KEY = {
  missing: 'preset.rows.sectionHint.missing',
  conditional: 'preset.rows.sectionHint.conditional',
  skipped: 'preset.rows.sectionHint.skipped',
  found: 'preset.rows.sectionHint.found',
} as const satisfies Record<PresetRowState, string>

/** The tag naming what one row state amounts to, on the row itself. */
const STATE_KEY = {
  missing: 'preset.row.state.missing',
  conditional: 'preset.row.state.conditional',
  skipped: 'preset.row.state.skipped',
  found: 'preset.row.state.found',
} as const satisfies Record<PresetRowState, string>

/** The tag naming where a row's specifier reaches a module. */
const KIND_KEY = {
  builtin: 'preset.row.kind.builtin',
  preset: 'preset.row.kind.preset',
  file: 'preset.row.kind.file',
  package: 'preset.row.kind.package',
} as const satisfies Record<PresetRowKind, string>

/** State → the Tag colour the row wears. Problems are coloured, a working row is
 * not: a wall of success tags says nothing. */
const STATE_COLOUR: Record<PresetRowState, string | undefined> = {
  missing: 'error',
  conditional: 'gold',
  skipped: 'default',
  found: undefined,
}

const MONO = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' } as const

export interface PresetDetailBodyProps {
  preset: PresetListItem
  /** This preset's grade under the profile the page is showing, when it has one. */
  grade: PresetGrade | undefined
}

/** The contents body, without the dialog around it. */
export function PresetDetailBody({ preset, grade }: PresetDetailBodyProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const label = presetGradeLabel(grade)
  const sections = presetRowSections(grade?.rows ?? [])
  const rows = grade?.rows.length ?? 0

  return (
    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
      {/* ── what it says about itself ─────────────────────────────────────── */}
      <div>
        <Space size={8} wrap>
          <Typography.Text strong style={{ fontSize: token.fontSizeLG }}>{preset.name ?? preset.id}</Typography.Text>
          <Typography.Text code type="secondary">{preset.id}</Typography.Text>
          <Tag>{t(preset.trust === 'user' ? 'preset.sourceUser' : 'preset.sourceSystem')}</Tag>
          {/* Where the definition lives is a tag of its own: two shipped presets
              and a local one can share a name, and only this says which. */}
          <Tooltip title={preset.bundle}>
            <Tag color="blue">{t(PRESET_SOURCE_KEY[preset.source])}</Tag>
          </Tooltip>
          <Typography.Text type="secondary">{t('preset.priority', { value: preset.order ?? '—' })}</Typography.Text>
          <Tag color={presetGradeColour(grade)}>{t(label.key, label.options)}</Tag>
          {preset.broken === undefined
            ? null
            : <Tooltip title={preset.broken}><Tag color="error">{t('preset.broken')}</Tag></Tooltip>}
        </Space>
        <div style={{ marginTop: 6, color: token.colorTextSecondary }}>
          {preset.description ?? t('preset.noDescription')}
        </div>
      </div>

      {/* ── where it lives, and what the host loads ───────────────────────── */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
          <Tooltip title={preset.location}>
            <span
              style={{
                ...MONO,
                flex: '1 1 auto',
                minWidth: 0,
                fontSize: token.fontSizeSM,
                color: token.colorTextSecondary,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {preset.location}
            </span>
          </Tooltip>
          {/* The copy control is a SIBLING of the truncating span: on the same
              element it would be clipped along with the path. */}
          <Typography.Text
            copyable={{ text: preset.location }}
            style={{ flexShrink: 0, fontSize: token.fontSizeSM }}
          />
        </div>
        {preset.rowId !== undefined && (
          <div style={{ ...MONO, fontSize: token.fontSizeSM, color: token.colorTextTertiary }}>
            {t('preset.detail.rowId', { row: preset.rowId })}
          </div>
        )}
        {/* A declaration with no `config.id` borrows the loader row id, so the id
            above is not the preset's own name — say so rather than let it read as
            one. */}
        {preset.idFromRow === true && (
          <div style={{ marginTop: 4, fontSize: token.fontSizeSM, color: token.colorWarning }}>
            {t('preset.detail.idFromRow')}
          </div>
        )}
      </div>

      {/* ── what it is made of ────────────────────────────────────────────── */}
      <div>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>{t('preset.rows.title')}</div>
        {grade === undefined
          ? <div style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM }}>{t('preset.grade.unknownTip')}</div>
          : grade.level === 'unusable'
            ? (
              <div>
                {/* Nothing to list on an unusable grade: the reason is the answer,
                    and the path above is where to go and fix it. */}
                <div style={{ color: token.colorError }}>{grade.reason ?? t('preset.grade.unusable')}</div>
              </div>
            )
            : rows === 0
              ? <div style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM }}>{t('preset.rows.empty')}</div>
              : (
                <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
                  {sections.map(section => (
                    <div key={section.state}>
                      <div style={{ color: token.colorTextSecondary }}>
                        {t(SECTION_KEY[section.state], { count: section.rows.length })}
                      </div>
                      <div style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM, marginBottom: 4 }}>
                        {t(SECTION_HINT_KEY[section.state])}
                      </div>
                      {section.rows.map((row, index) => (
                        <RowLine key={`${String(index)}:${row.label}`} row={row} />
                      ))}
                    </div>
                  ))}
                </Space>
              )}
      </div>
    </Space>
  )
}

/** One row of the composition: what it names, what that means, and how it reads
 * here. The row's `config` is not shown, by design — see the file header. */
function RowLine({ row }: { row: PresetCompositionRow }): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
      <Tag color={STATE_COLOUR[row.state]} style={{ flexShrink: 0, marginInlineEnd: 0 }}>
        {t(STATE_KEY[row.state])}
      </Tag>
      {/* A `!!js` row has no decidable kind, so it wears no kind tag: saying
          "package" there would be a guess about an expression. */}
      {row.kind !== null && (
        <Tag style={{ flexShrink: 0, marginInlineEnd: 0 }}>{t(KIND_KEY[row.kind])}</Tag>
      )}
      <Typography.Text
        code
        copyable={{ text: row.name }}
        style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {row.name}
      </Typography.Text>
      <span style={{ ...MONO, flexShrink: 0, fontSize: token.fontSizeSM, color: token.colorTextTertiary }}>
        {row.label}
      </span>
    </div>
  )
}

export interface PresetDetailModalProps {
  /** The preset being inspected, or null when the dialog is closed. */
  preset: PresetListItem | null
  grade: PresetGrade | undefined
  /** Open the definition: `true` for the editor, `false` for the file manager. */
  onOpen: (editor: boolean) => void
  /** Start a copy of this preset (the page owns the create dialog). */
  onCopy: () => void
  onClose: () => void
}

/** The dialog around {@link PresetDetailBody}. Its footer carries only what makes
 * sense while looking at a preset: where it lives (open), and the one action that
 * starts from it (copy — the documented way to get an editable preset, since the
 * shipped ones have no name or description of their own). Editing or deleting the
 * row stays on the roster's own menu, so a write has one home. */
export default function PresetDetailModal({
  preset, grade, onOpen, onCopy, onClose,
}: PresetDetailModalProps): JSX.Element {
  const { t } = useTranslation()
  return (
    <ScrollModal
      title={preset === null ? '' : t('preset.detail.title', { name: preset.name ?? preset.id })}
      open={preset !== null}
      onCancel={onClose}
      width={MODAL.wide}
      bodyMax="lg"
      footer={preset === null ? null : (
        <Space>
          <Dropdown
            trigger={['click']}
            placement="topRight"
            menu={{
              items: [
                { key: 'reveal', label: t('preset.reveal'), icon: <FolderOpenOutlined /> },
                { key: 'editor', label: t('preset.openEditor'), icon: <CodeOutlined /> },
              ],
              onClick: ({ key }) => onOpen(key === 'editor'),
            }}
          >
            <Button aria-label={`${t('preset.open')}: ${preset.id}`}>
              {t('preset.open')}
              <DownOutlined style={{ fontSize: 10 }} />
            </Button>
          </Dropdown>
          <Button onClick={onCopy}>{t('preset.copy')}</Button>
          <Button type="primary" onClick={onClose}>{t('common.close')}</Button>
        </Space>
      )}
    >
      {preset !== null && <PresetDetailBody preset={preset} grade={grade} />}
    </ScrollModal>
  )
}
