/** One skill-library card for the repository grid — mirrors PluginCard: the
 * upper region opens the editor; the footer carries the "install to dsh…"
 * action and a kebab with edit / recycle-bin delete. The usage line summarizes
 * where the skill is installed (installed copies are matched by frontmatter
 * `name`). All colours derive from theme tokens per docs/ui-guidelines.md. */
import { useState } from 'react'
import { Button, Tag, Tooltip, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import ConfirmMenu, { type MenuAction } from '../components/ConfirmMenu.tsx'
import type { SkillLibEntry } from '../../../shared/types.ts'

export interface SkillCardProps {
  entry: SkillLibEntry
  /** Per-dsh install states (installed / stale). */
  installs: Array<{ installed: boolean; stale: boolean }>
  /** The edit (read the file) is in flight. */
  editBusy: boolean
  onOpen: () => void
  onInstall: () => void
  onDelete: () => void
}

export default function SkillCard(p: SkillCardProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [hovered, setHovered] = useState(false)
  const { entry } = p

  const actions: MenuAction[] = [
    { key: 'edit', label: t('common.edit') },
    { key: 'delete', label: t('common.delete'), danger: true, confirmText: t('ext.skills.deleteLibConfirm', { name: entry.name }) },
  ]
  const onAction = (key: string): void => {
    if (key === 'edit') p.onOpen()
    else if (key === 'delete') p.onDelete()
  }

  const installedCount = p.installs.filter(install => install.installed).length
  const staleCount = p.installs.filter(install => install.installed && install.stale).length

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
      {/* Upper region — clickable into the editor. */}
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
        <CardBody entry={entry} installedCount={installedCount} staleCount={staleCount} />
      </div>

      {/* Footer — "install to dsh…" is the primary action; kebab carries edit /
          delete. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: token.paddingSM, paddingTop: token.paddingSM, borderTop: `1px solid ${token.colorSplit}` }}>
        <Button size="small" type="primary" onClick={p.onInstall}>
          {t('ext.skills.installTo')}
        </Button>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Tooltip title={t('common.edit')}>
            <Button size="small" loading={p.editBusy} onClick={p.onOpen}>
              {t('common.edit')}
            </Button>
          </Tooltip>
          <ConfirmMenu actions={actions} onAction={onAction} />
        </span>
      </div>
    </div>
  )
}

/** The always-static part of the card: title, tags, description, usage, path. */
function CardBody(props: { entry: SkillLibEntry; installedCount: number; staleCount: number }): JSX.Element {
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
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {!entry.modelInvocable && <Tag color="default">{t('ext.skills.invocation.modelOff')}</Tag>}
        {!entry.userInvocable && <Tag color="default">{t('ext.skills.invocation.userOff')}</Tag>}
        {props.installedCount > 0
          ? <Tag color={props.staleCount > 0 ? 'warning' : 'success'}>{t('ext.skills.installedCount', { count: props.installedCount })}</Tag>
          : <Tag color="default">{t('ext.skills.notInstalled')}</Tag>}
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
