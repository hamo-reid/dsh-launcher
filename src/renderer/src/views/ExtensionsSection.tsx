/**
 * The extensions surface: dsh capabilities the launcher manages beside plugins.
 *
 * Same shell as the plugins section — a left view menu over full-width
 * repository panels. Two independent tracks live here — MCP servers (per
 * profile, a patch-layer `insert:` row) and Skills (the filesystem roots dsh
 * discovers); each view owns its own target picking, so they ship and evolve
 * on their own.
 */
import { useState } from 'react'
import { Menu } from 'antd'
import { useTranslation } from 'react-i18next'
import AppShell from '../components/AppShell.tsx'
import McpView from './McpView.tsx'
import SkillsView from './SkillsView.tsx'

export default function ExtensionsSection(): JSX.Element {
  const { t } = useTranslation()
  const [tab, setTab] = useState<'mcp' | 'skills'>('mcp')

  return (
    <AppShell
      siderWidth={200}
      sider={(
        <Menu
          selectedKeys={[tab]}
          items={[
            { key: 'mcp', label: t('ext.tab.mcp') },
            { key: 'skills', label: t('ext.tab.skills') },
          ]}
          onClick={({ key }) => setTab(key as 'mcp' | 'skills')}
          style={{ borderInlineEnd: 0, paddingTop: 8 }}
        />
      )}
    >
      {tab === 'mcp' ? <McpView /> : <SkillsView />}
    </AppShell>
  )
}
