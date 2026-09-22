import { Button, Input, theme } from 'antd'
import { FolderOpenOutlined } from '@ant-design/icons'

/** A single directory field: label + hint + path input + a "Browse…" button.
 *
 * Shared by the onboarding wizard and the settings page. The input lives here
 * rather than inside `ConfigRow` because that one is plain text only — picking a
 * directory needs the native dialog behind `settings:pickDir`. */
export default function DirField(props: {
  title: string
  desc: string
  value: string
  onChange: (v: string) => void
  onBrowse: () => void
  browseLabel: string
}): JSX.Element {
  const { token } = theme.useToken()
  return (
    <div style={{ marginBottom: token.paddingLG }}>
      <div style={{ fontWeight: 600 }}>{props.title}</div>
      <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, margin: '4px 0 8px' }}>
        {props.desc}
      </div>
      <div style={{ display: 'flex', gap: token.paddingSM }}>
        <Input
          value={props.value}
          onChange={e => props.onChange(e.target.value)}
          style={{ flex: 1, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}
        />
        <Button icon={<FolderOpenOutlined />} onClick={props.onBrowse} style={{ flexShrink: 0 }}>
          {props.browseLabel}
        </Button>
      </div>
    </div>
  )
}
