/** One skill card for the repository grid — mirrors PluginCard: the upper
 * region opens the editor when the entry is editable (only the writable
 * user-dsh root is); the footer carries edit + a kebab with the recycle-bin
 * delete. All colours derive from theme tokens per docs/ui-guidelines.md. */
import { useState } from 'react'
import { Button, Tag, Tooltip, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import ConfirmMenu, { type MenuAction } from '../components/ConfirmMenu.tsx'
import type { SkillEntry } from '../../../shared/types.ts'

/** Tag colour per root origin. */
const SOURCE_COLOUR: Record<SkillEntry['source'], string> = {
  'user-dsh': 'blue',
  'user-agents': 'purple',
  custom: 'orange',
  bundled: 'default',
}

/** Source label key suffix (`ext.skills.source.<suffix>`). */
const SOURCE_KEY: Record<SkillEntry['source'], 'userDsh' | 'userAgents' | 'custom' | 'bundled'> = {
  'user-dsh': 'userDsh',
  'user-agents': 'userAgents',
  custom: 'custom',
  bundled: 'bundled',
}

export interface SkillCardProps {
  entry: SkillEntry
  /** The edit (read the file) is in flight. */
  editBusy: boolean
  onOpen: () => void
  onDelete: () => void
}

export default function SkillCard(p: SkillCardProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [hovered, setHovered] = useState(false)
  const { entry } = p

  const actions: MenuAction[] = entry.editable
    ? [{ key: 'delete', label: t('common.delete'), danger: true, confirmText: t('ext.skills.deleteConfirm', { name: entry.name }) }]
    : []
  const onAction = (key: string): void => {
    if (key === 'delete') p.onDelete()
  }

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
        minHeight: 140,
        boxShadow: hovered ? token.boxShadowTertiary : 'none',
        transition: 'border-color 0.15s, box-shadow 0.15s',
      }}
    >
      {/* Upper region — clickable into the editor when editable. */}
      {entry.editable ? (
        <div
          role="button"
          tabIndex={0}
          aria-label={entry.name}
          onClick={p.onOpen}
          onKeyDown={event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); p.onOpen() }
          }}
          style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8, cursor: 'pointer', outline: 'none' }}
        >
          <CardBody entry={entry} />
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <CardBody entry={entry} />
        </div>
      )}

      {/* Footer — only editable entries have actions. */}
      {entry.editable && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: token.paddingSM, paddingTop: token.paddingSM, borderTop: `1px solid ${token.colorSplit}` }}>
          <Button size="small" type="primary" loading={p.editBusy} onClick={p.onOpen}>
            {t('common.edit')}
          </Button>
          {actions.length > 0 && <ConfirmMenu actions={actions} onAction={onAction} />}
        </div>
      )}
    </div>
  )
}

/** The always-static part of the card: title, tags, description, path. */
function CardBody(props: { entry: SkillEntry }): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { entry } = props
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <span
          title={entry.name}
          style={{ flex: 1, minWidth: 0, fontWeight: 600, color: token.colorText, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {entry.name}
        </span>
        {!entry.editable && <Tag color="warning">{t('ext.skills.readonly')}</Tag>}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        <Tag color={SOURCE_COLOUR[entry.source]}>{t(`ext.skills.source.${SOURCE_KEY[entry.source]}`)}</Tag>
        {entry.shape === 'flat' && <Tag>{t('ext.skills.shape.flat')}</Tag>}
        {!entry.modelInvocable && <Tag color="default">{t('ext.skills.invocation.modelOff')}</Tag>}
        {!entry.userInvocable && <Tag color="default">{t('ext.skills.invocation.userOff')}</Tag>}
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
        <div style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 'auto' }}>
          {entry.path}
        </div>
      </Tooltip>
    </>
  )
}
