/**
 * The one way INTO a skill surface.
 *
 * A skill arrives from one of two sources and the action is otherwise identical:
 * an archive someone sent, or a folder already on disk. Two side-by-side buttons
 * would read as two features; one button with two items says what it is — the same
 * shape `SkillOpenMenu` uses for two destinations, and the rule
 * `docs/ui-guidelines.md` §「打开」states for an action with more than one meaning.
 *
 * The folder path is a COPY, like the archive's: what lands in the target root is a
 * snapshot, and the source keeps its own life. Both skill surfaces render THIS
 * component, so the sources and their wording have one home.
 */
import { Button, Dropdown } from 'antd'
import { DownOutlined, FolderOpenOutlined, ImportOutlined, UploadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'

/** Where a skill comes from. */
export type SkillImportSource = 'zip' | 'folder'

interface SkillImportMenuProps {
  /** An import is in flight, for the button's spinner. */
  busy: boolean
  /** The grid's own button is small; the empty state's action is not. */
  size?: 'small' | 'middle'
  onPick: (source: SkillImportSource) => void
}

export default function SkillImportMenu(p: SkillImportMenuProps): JSX.Element {
  const { t } = useTranslation()
  return (
    <Dropdown
      trigger={['click']}
      placement="bottomLeft"
      menu={{
        items: [
          { key: 'zip', label: t('ext.skills.import'), icon: <UploadOutlined /> },
          { key: 'folder', label: t('ext.skills.importFolder'), icon: <FolderOpenOutlined /> },
        ],
        onClick: ({ key }) => p.onPick(key === 'folder' ? 'folder' : 'zip'),
      }}
    >
      <Button size={p.size ?? 'small'} loading={p.busy} icon={<ImportOutlined />}>
        {t('ext.skills.importMenu')}
        <DownOutlined style={{ fontSize: 10 }} />
      </Button>
    </Dropdown>
  )
}
