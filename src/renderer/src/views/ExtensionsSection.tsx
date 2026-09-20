/**
 * The extensions surface: dsh capabilities the launcher manages beside plugins.
 *
 * Two independent tracks live here — MCP servers (per profile, a patch-layer
 * `insert:` row) and Skills (the filesystem roots dsh discovers). They share only
 * this shell's dsh/profile picker, so each ships and evolves on its own.
 */
import { useEffect, useState } from 'react'
import { Empty, Segmented, Select, Space } from 'antd'
import { useTranslation } from 'react-i18next'
import Toolbar from '../components/Toolbar.tsx'
import McpView from './McpView.tsx'
import SkillsView from './SkillsView.tsx'

/** One dsh and the profiles it holds, for the target picker. */
interface DshScope { id: string; name: string; profiles: string[] }

export default function ExtensionsSection(): JSX.Element {
  const { t } = useTranslation()
  const [tab, setTab] = useState<'mcp' | 'skills'>('mcp')
  const [scopes, setScopes] = useState<DshScope[]>([])
  const [dshId, setDshId] = useState<string>()
  const [profile, setProfile] = useState<string>()

  useEffect(() => {
    void (async () => {
      const r = await window.api.plugins.installOptions()
      if (!r.ok) return
      setScopes(r.value)
      setDshId(prev => (prev !== undefined && r.value.some(s => s.id === prev)) ? prev : r.value[0]?.id)
    })()
  }, [])

  // Keep the selected profile valid for the selected dsh (a dsh switch, or a
  // profile deleted elsewhere, must not leave a stale target).
  useEffect(() => {
    const profiles = scopes.find(scope => scope.id === dshId)?.profiles ?? []
    setProfile(prev => (prev !== undefined && profiles.includes(prev)) ? prev : profiles[0])
  }, [scopes, dshId])

  const activeScope = scopes.find(scope => scope.id === dshId)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Toolbar>
        <Segmented
          value={tab}
          onChange={key => setTab(key as 'mcp' | 'skills')}
          options={[
            { value: 'mcp', label: t('ext.tab.mcp') },
            { value: 'skills', label: t('ext.tab.skills') },
          ]}
        />
        <span style={{ flex: 1 }} />
        <Space size={8} wrap>
          <Select
            size="small"
            style={{ minWidth: 180 }}
            value={dshId}
            placeholder={t('ext.target.dsh')}
            onChange={setDshId}
            options={scopes.map(scope => ({ value: scope.id, label: scope.name }))}
          />
          <Select
            size="small"
            style={{ minWidth: 180 }}
            value={profile}
            placeholder={t('ext.target.profile')}
            onChange={setProfile}
            options={(activeScope?.profiles ?? []).map(name => ({ value: name, label: name }))}
          />
        </Space>
      </Toolbar>

      {tab === 'mcp' ? (
        activeScope === undefined ? (
          <Empty style={{ marginTop: 48 }} description={t('ext.target.noDsh')} />
        ) : profile === undefined ? (
          <Empty style={{ marginTop: 48 }} description={t('ext.target.noProfile')} />
        ) : (
          <McpView dshId={dshId} profile={profile} />
        )
      ) : (
        <SkillsView dshId={dshId} />
      )}
    </div>
  )
}
