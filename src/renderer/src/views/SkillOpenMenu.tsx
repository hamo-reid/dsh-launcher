/**
 * The one way out of a skill card.
 *
 * A skill is a directory, not a document: a SKILL.md beside whatever scripts,
 * references and assets it needs. A text box in the launcher can therefore only
 * ever edit a part of one, so the card offers the same choice the presets page
 * offers, from the same kind of control — one button, two destinations, one
 * decision. "Show its folder" is the one that answers "what else is in here".
 *
 * Both skill surfaces render THIS component, so the wording, the icons and the
 * two destinations have one home instead of one copy each (docs/specs/extensions.md).
 */
import { Button, Dropdown } from 'antd'
import { CodeOutlined, DownOutlined, FolderOpenOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'

interface SkillOpenMenuProps {
  /** The skill, for the button's accessible name — a grid of identical "Open"
   * buttons is unusable without one. */
  name: string
  /** An open is in flight, for that button's spinner. */
  busy: boolean
  /** `true` opens the SKILL.md, `false` shows the folder that holds it. */
  onSelect: (editor: boolean) => void
}

export default function SkillOpenMenu(p: SkillOpenMenuProps): JSX.Element {
  const { t } = useTranslation()
  return (
    <Dropdown
      trigger={['click']}
      placement="bottomRight"
      menu={{
        items: [
          { key: 'reveal', label: t('ext.skills.openFolder'), icon: <FolderOpenOutlined /> },
          { key: 'editor', label: t('ext.skills.openEditor'), icon: <CodeOutlined /> },
        ],
        onClick: ({ key }) => p.onSelect(key === 'editor'),
      }}
    >
      <Button size="small" loading={p.busy} aria-label={`${t('ext.skills.open')}: ${p.name}`}>
        {t('ext.skills.open')}
        <DownOutlined style={{ fontSize: 10 }} />
      </Button>
    </Dropdown>
  )
}
