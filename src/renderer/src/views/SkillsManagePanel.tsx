/**
 * Skills installed on ONE dsh — the dsh side of the extensions model. dsh
 * discovers skills from filesystem roots, so this panel lists what the dsh
 * holds (rank order, read-only roots tagged), drops entries into the recycle
 * bin, and installs from the launcher-global library. A copy that drifted
 * from its library entry is flagged for reinstall.
 */
import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Empty, Space, Tag, theme, message } from 'antd'
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../lib/ipc.ts'
import Panel from '../components/Panel.tsx'
import ConfirmMenu, { type MenuAction } from '../components/ConfirmMenu.tsx'
import { PickLibSkillModal } from './LibraryModals.tsx'
import type {
  SkillEntry, SkillLibOverviewRow, SkillListing,
} from '../../../shared/types.ts'

/** Tag colour per root origin (mirrors the dsh-side listing). */
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

export default function SkillsManagePanel(p: { dshId: string }): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [listing, setListing] = useState<SkillListing | null>(null)
  const [overview, setOverview] = useState<SkillLibOverviewRow[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [installOpen, setInstallOpen] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    const [list, lib] = await Promise.all([
      window.api.ext.skillList(p.dshId),
      window.api.ext.libSkillOverview(),
    ])
    setLoading(false)
    if (!list.ok) { void message.error(apiErrorText(list)); return }
    setListing(list.value)
    if (lib.ok) setOverview(lib.value)
  }, [p.dshId])

  useEffect(() => { void load() }, [load])

  const staleFor = (name: string): boolean =>
    overview.find(row => row.entry.name === name)?.installs
      .find(install => install.dshId === p.dshId)?.stale === true

  const remove = async (entry: SkillEntry): Promise<void> => {
    setBusy(`remove:${entry.name}`)
    const r = await window.api.ext.skillDelete(p.dshId, entry.name)
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('ext.skills.deleted', { name: entry.name }))
    await load()
  }

  const reinstall = async (entry: SkillEntry): Promise<void> => {
    setBusy(`reinstall:${entry.name}`)
    const r = await window.api.ext.libSkillInstall(entry.name, p.dshId, true)
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('ext.skills.installed', { name: entry.name }))
    await load()
  }

  const install = async (name: string, overwrite: boolean): Promise<void> => {
    setInstallOpen(false)
    setBusy('install')
    const r = await window.api.ext.libSkillInstall(name, p.dshId, overwrite)
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('ext.skills.installed', { name }))
    await load()
  }
  const skills = listing?.skills ?? []
  const issues = listing?.issues ?? []
  const actionRow = (
    <Space size={8} wrap>
      <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setInstallOpen(true)}>
        {t('ext.skills.installFromLib')}
      </Button>
      <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
        {t('common.refresh')}
      </Button>
    </Space>
  )

  return (
    <>
      <Panel title={t('dsh.skills')} extra={actionRow}>
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {issues.map((issue, i) => (
            <Alert
              key={i}
              type="warning"
              showIcon
              title={t('ext.skills.issueTitle')}
              description={(
                <div>
                  <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: token.fontSizeSM }}>{issue.path}</span>
                  <div style={{ marginTop: 2 }}>{issue.reason}</div>
                </div>
              )}
            />
          ))}
          {skills.length === 0 && !loading && (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('dsh.skillsEmpty')} />
          )}
          {skills.map(entry => {
            const stale = staleFor(entry.name)
            const actions: MenuAction[] = [
              ...(stale ? [{ key: 'reinstall', label: t('ext.skills.reinstall') } as MenuAction] : []),
              ...(entry.editable
                ? [{ key: 'delete', label: t('common.delete'), danger: true, confirmText: t('ext.skills.deleteConfirm', { name: entry.name }) } as MenuAction]
                : []),
            ]
            return (
              <div key={`${entry.source}:${entry.path}`} style={{ borderBottom: `1px solid ${token.colorSplit}`, paddingBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span title={entry.name} style={{ flex: 1, minWidth: 0, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {entry.name}
                  </span>
                  <Tag color={SOURCE_COLOUR[entry.source]}>{t(`ext.skills.source.${SOURCE_KEY[entry.source]}`)}</Tag>
                  {stale && <Tag color="warning">{t('ext.skills.staleTag')}</Tag>}
                  {actions.length > 0 && (
                    <ConfirmMenu
                      actions={actions}
                      onAction={key => {
                        if (key === 'delete') void remove(entry)
                        else if (key === 'reinstall') void reinstall(entry)
                      }}
                    />
                  )}
                </div>
                <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                  {entry.description}
                </div>
              </div>
            )
          })}
        </Space>
      </Panel>
      <PickLibSkillModal
        open={installOpen}
        rows={overview}
        dshId={p.dshId}
        busy={busy === 'install' ? 'install' : null}
        onCancel={() => setInstallOpen(false)}
        onPick={(entry, overwrite) => void install(entry.name, overwrite)}
      />
    </>
  )
}
