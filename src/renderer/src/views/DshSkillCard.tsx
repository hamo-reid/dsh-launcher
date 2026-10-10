/**
 * One skill as it exists ON ONE dsh — the dsh-side sibling of the library's
 * `SkillCard`. The dsh panel shows a grid of these, so a skill reads as a unit
 * with its own actions instead of a row between two dividers.
 *
 * What a card may offer follows from where the copy lives: only the dsh's writable
 * root is editable (`entry.editable`), and "reinstall" appears only when there IS a
 * verdict from the library saying the copy drifted — an unreadable copy gets that
 * tag with its reason, because reinstalling cannot fix an unreadable file.
 *
 * All colours derive from theme tokens per docs/ui-guidelines.md.
 */
import { useState } from 'react'
import { Button, Tag, Tooltip, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import ConfirmMenu, { type MenuAction } from '../components/ConfirmMenu.tsx'
import { installCellColour, installCellState } from '../lib/skillInstallState.ts'
import { SOURCE_COLOUR, sourceLabelKey } from '../lib/skillSource.ts'
import type { SkillEntry, SkillLibInstall } from '../../../shared/types.ts'

const MONO: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 12,
  wordBreak: 'break-all',
}

interface DshSkillCardProps {
  entry: SkillEntry
  /** The library's verdict for this skill's copy here, or `undefined` when the
   * library has no entry to compare against. */
  cell: SkillLibInstall | undefined
  /** Which of this card's actions is running, for that button's spinner. */
  busy: 'edit' | 'reinstall' | null
  onEdit: () => void
  onReinstall: () => void
  onDelete: () => void
}

export default function DshSkillCard(p: DshSkillCardProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [hovered, setHovered] = useState(false)
  const { entry } = p

  const state = p.cell === undefined ? undefined : installCellState(p.cell)
  const stale = state === 'stale'
  const problem = state === 'problem'

  // Delete is the only destructive entry, so it keeps the kebab's confirm text
  // rather than a bare button (docs/ui-guidelines.md §3.6).
  const actions: MenuAction[] = entry.editable
    ? [{
        key: 'delete',
        label: t('common.delete'),
        danger: true,
        confirmText: t('ext.skills.deleteConfirm', { name: entry.name }),
      }]
    : []

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        padding: token.padding,
        borderRadius: token.borderRadiusLG,
        border: `1px solid ${hovered ? token.colorPrimary : token.colorBorder}`,
        background: token.colorBgContainer,
        minHeight: 150,
        boxShadow: hovered ? token.boxShadowTertiary : 'none',
        transition: 'border-color 0.15s, box-shadow 0.15s',
      }}
    >
      {/* Upper region — opens the editor where this copy may be edited. */}
      <div
        role={entry.editable ? 'button' : undefined}
        tabIndex={entry.editable ? 0 : undefined}
        aria-label={entry.editable ? t('common.edit') : undefined}
        onClick={entry.editable ? p.onEdit : undefined}
        onKeyDown={event => {
          if (!entry.editable) return
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); p.onEdit() }
        }}
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          cursor: entry.editable ? 'pointer' : 'default',
          outline: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span
            title={entry.name}
            style={{ flex: 1, minWidth: 0, fontWeight: 600, color: token.colorText, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {entry.name}
          </span>
          {/* The reason is the whole point of this tag: without it a copy that
              cannot be read looks like one that needs reinstalling. */}
          {problem
            ? (
              <Tooltip title={p.cell?.problem}>
                <Tag color={installCellColour('problem')} style={{ marginInlineEnd: 0 }}>
                  {t('ext.skills.problemTag', { count: 1 })}
                </Tag>
              </Tooltip>
              )
            : stale
              ? <Tag color={installCellColour('stale')} style={{ marginInlineEnd: 0 }}>{t('ext.skills.staleTag')}</Tag>
              : null}
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          <Tag color={SOURCE_COLOUR[entry.source]} style={{ marginInlineEnd: 0 }}>
            {t(sourceLabelKey(entry.source))}
          </Tag>
          {!entry.modelInvocable && <Tag style={{ marginInlineEnd: 0 }}>{t('ext.skills.invocation.modelOff')}</Tag>}
          {!entry.userInvocable && <Tag style={{ marginInlineEnd: 0 }}>{t('ext.skills.invocation.userOff')}</Tag>}
        </div>

        <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          {entry.description}
        </div>

        {entry.whenToUse !== undefined && (
          <div style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {t('ext.skills.whenToUse')}: {entry.whenToUse}
          </div>
        )}

        <Tooltip title={entry.path}>
          <div style={{ ...MONO, color: token.colorTextTertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 'auto' }}>
            {entry.path}
          </div>
        </Tooltip>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: token.paddingSM, paddingTop: token.paddingSM, borderTop: `1px solid ${token.colorSplit}` }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {entry.editable && (
            <Button size="small" loading={p.busy === 'edit'} onClick={p.onEdit}>{t('common.edit')}</Button>
          )}
          {(stale || problem) && (
            <Button size="small" type="primary" onClick={p.onReinstall}>{t('ext.skills.reinstall')}</Button>
          )}
        </span>
        {actions.length > 0 && (
          <ConfirmMenu actions={actions} onAction={key => { if (key === 'delete') p.onDelete() }} />
        )}
      </div>
    </div>
  )
}
