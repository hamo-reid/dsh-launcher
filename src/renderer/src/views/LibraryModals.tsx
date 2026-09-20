/**
 * Modals for moving between the launcher-global libraries and their targets:
 * applying a library MCP entry to a profile layer or the home layer, picking
 * an entry to add from a profile/dsh side, and installing a library skill
 * into a dsh's writable root.
 */
import { useEffect, useState } from 'react'
import { Alert, Checkbox, Modal, Radio, Select, Space, Tag, theme, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import FieldLabel from '../components/FieldLabel.tsx'
import EmptyState from '../components/EmptyState.tsx'
import type {
  McpApplyTarget, McpLibEntry, SkillLibEntry, SkillLibInstall, SkillLibOverviewRow,
} from '../../../shared/types.ts'

/** One dsh and the profiles it holds (from `plugins.installOptions`). */
export interface DshScope { id: string; name: string; profiles: string[] }

/** Pick dsh + target layer for applying a library MCP entry. */
export function ApplyMcpModal(props: {
  open: boolean
  entry: McpLibEntry | null
  scopes: DshScope[]
  onCancel: () => void
  onApply: (target: McpApplyTarget) => void
}): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [dshId, setDshId] = useState<string>()
  const [layer, setLayer] = useState<'profile' | 'home'>('profile')
  const [profile, setProfile] = useState<string>()

  // Reset to the first valid target whenever the dialog opens.
  useEffect(() => {
    if (!props.open) return
    setDshId(prev => (prev !== undefined && props.scopes.some(s => s.id === prev)) ? prev : props.scopes[0]?.id)
    setLayer('profile')
    setProfile(undefined)
  }, [props.open, props.scopes])

  useEffect(() => {
    const profiles = props.scopes.find(scope => scope.id === dshId)?.profiles ?? []
    setProfile(prev => (prev !== undefined && profiles.includes(prev)) ? prev : profiles[0])
  }, [props.scopes, dshId])

  const submit = (): void => {
    if (dshId === undefined) return
    if (layer === 'profile' && profile === undefined) return
    props.onApply({ dshId, layer, ...(layer === 'profile' ? { profile } : {}) })
  }

  return (
    <Modal
      open={props.open}
      title={t('ext.mcp.applyTitle', { name: props.entry?.serverName ?? '' })}
      okText={t('ext.mcp.apply')}
      cancelText={t('common.cancel')}
      onOk={submit}
      onCancel={props.onCancel}
      okButtonProps={{ disabled: dshId === undefined || (layer === 'profile' && profile === undefined) }}
      destroyOnHidden
    >
      {props.scopes.length === 0 ? (
        <EmptyState title={t('ext.target.noDsh')} />
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div>
            <FieldLabel>{t('ext.target.dsh')}</FieldLabel>
            <Select
              style={{ width: '100%' }}
              showSearch
              optionFilterProp="label"
              value={dshId}
              onChange={setDshId}
              options={props.scopes.map(scope => ({ value: scope.id, label: scope.name }))}
            />
          </div>
          <div>
            <FieldLabel>{t('ext.mcp.form.layer')}</FieldLabel>
            <Radio.Group
              value={layer}
              onChange={e => setLayer(e.target.value as 'profile' | 'home')}
              options={[
                { value: 'profile', label: t('ext.mcp.form.layerProfile', { profile: profile ?? '' }) },
                { value: 'home', label: t('ext.mcp.form.layerHome') },
              ]}
            />
            <div style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM, marginTop: 4 }}>
              {layer === 'home' ? t('ext.mcp.form.layerHomeHint') : t('ext.mcp.form.layerProfileHint')}
            </div>
          </div>
          {layer === 'profile' && (
            <div>
              <FieldLabel>{t('ext.target.profile')}</FieldLabel>
              <Select
                style={{ width: '100%' }}
                showSearch
                optionFilterProp="label"
                value={profile}
                disabled={dshId === undefined}
                onChange={setProfile}
                options={(props.scopes.find(scope => scope.id === dshId)?.profiles ?? [])
                  .map(name => ({ value: name, label: name }))}
              />
            </div>
          )}
          <Alert type="info" showIcon title={t('ext.mcp.applyHint')} />
        </Space>
      )}
    </Modal>
  )
}

/** Pick a library MCP entry to add to a profile layer / the home layer. */
export function PickLibMcpModal(props: {
  open: boolean
  entries: McpLibEntry[]
  /** serverNames already present in the target layer — those rows are disabled. */
  appliedNames: string[]
  busy: string | null
  onCancel: () => void
  onPick: (entry: McpLibEntry) => void
}): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  return (
    <Modal
      open={props.open}
      title={t('ext.mcp.pickFromLib')}
      footer={null}
      onCancel={props.onCancel}
      width={520}
      destroyOnHidden
    >
      {props.entries.length === 0 ? (
        <EmptyState title={t('ext.mcp.libEmpty')} description={t('ext.mcp.libEmptyDesc')} />
      ) : (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {props.entries.map(entry => {
            const applied = props.appliedNames.includes(entry.serverName)
            return (
              <div
                key={entry.serverName}
                role="button"
                tabIndex={applied ? -1 : 0}
                aria-disabled={applied}
                onClick={() => { if (!applied && props.busy === null) props.onPick(entry) }}
                onKeyDown={event => {
                  if ((event.key === 'Enter' || event.key === ' ') && !applied) { event.preventDefault(); props.onPick(entry) }
                }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
                  borderRadius: token.borderRadius, border: `1px solid ${token.colorBorder}`,
                  cursor: applied ? 'not-allowed' : 'pointer', opacity: applied ? 0.5 : 1,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {entry.serverName}
                  </div>
                  <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, wordBreak: 'break-all' }}>
                    {entry.input.transport === 'streamable-http'
                      ? entry.input.url ?? ''
                      : [entry.input.command, ...(entry.input.args ?? [])].filter(Boolean).join(' ')}
                  </div>
                </div>
                <Tag>{entry.input.transport}</Tag>
                {applied && <Tag color="default">{t('ext.mcp.alreadyApplied')}</Tag>}
              </div>
            )
          })}
        </Space>
      )}
    </Modal>
  )
}

/**
 * Pick a library skill to install on one fixed dsh. Rows show the entry's
 * state on that dsh: not installed (install), stale (reinstall), or
 * up-to-date (blocked — drop the copy first).
 */
export function PickLibSkillModal(props: {
  open: boolean
  rows: SkillLibOverviewRow[]
  dshId: string
  busy: string | null
  onCancel: () => void
  onPick: (entry: SkillLibEntry, overwrite: boolean) => void
}): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  return (
    <Modal
      open={props.open}
      title={t('ext.skills.pickFromLib')}
      footer={null}
      onCancel={props.onCancel}
      width={520}
      destroyOnHidden
    >
      {props.rows.length === 0 ? (
        <EmptyState title={t('ext.skills.libEmpty')} description={t('ext.skills.libEmptyDesc')} />
      ) : (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {props.rows.map(row => {
            const current = row.installs.find(install => install.dshId === props.dshId)
            const installed = current?.installed === true
            const stale = current?.stale === true
            const blocked = installed && !stale
            return (
              <div
                key={row.entry.name}
                role="button"
                tabIndex={blocked ? -1 : 0}
                aria-disabled={blocked}
                onClick={() => { if (!blocked && props.busy === null) props.onPick(row.entry, installed) }}
                onKeyDown={event => {
                  if ((event.key === 'Enter' || event.key === ' ') && !blocked) { event.preventDefault(); props.onPick(row.entry, installed) }
                }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
                  borderRadius: token.borderRadius, border: `1px solid ${token.colorBorder}`,
                  cursor: blocked ? 'not-allowed' : 'pointer', opacity: blocked ? 0.5 : 1,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {row.entry.name}
                  </div>
                  <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {row.entry.description}
                  </div>
                </div>
                {blocked && <Tag color="success">{t('ext.skills.upToDateTag')}</Tag>}
                {stale && <Tag color="warning">{t('ext.skills.staleTag')}</Tag>}
              </div>
            )
          })}
        </Space>
      )}
    </Modal>
  )
}

/** Pick a dsh and install a library skill into its writable root. */
export function InstallSkillModal(props: {
  open: boolean
  entry: SkillLibEntry | null
  installs: SkillLibInstall[]
  scopes: DshScope[]
  busy: boolean
  onCancel: () => void
  onInstall: (dshId: string, overwrite: boolean) => void
}): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [dshId, setDshId] = useState<string>()
  const [overwrite, setOverwrite] = useState(false)

  useEffect(() => {
    if (!props.open) return
    setDshId(prev => (prev !== undefined && props.scopes.some(s => s.id === prev)) ? prev : props.scopes[0]?.id)
    setOverwrite(false)
  }, [props.open, props.scopes])

  // The install state of the selected entry on the selected dsh decides
  // whether the copy is a plain install or needs an explicit overwrite.
  const current = props.installs.find(install => install.dshId === dshId)
  const installed = current?.installed === true
  const stale = current?.stale === true
  // An up-to-date copy is only replaced after the explicit overwrite consent;
  // a stale one (or an absent one) installs straight away.
  const okDisabled = dshId === undefined || (installed && !stale && !overwrite)
  const hint = current === undefined
    ? t('ext.skills.installHint')
    : !installed
      ? t('ext.skills.installHint')
      : stale
        ? t('ext.skills.installStaleHint')
        : t('ext.skills.installUpToDateHint')

  return (
    <Modal
      open={props.open}
      title={t('ext.skills.installTitle', { name: props.entry?.name ?? '' })}
      okText={t('ext.skills.install')}
      cancelText={t('common.cancel')}
      confirmLoading={props.busy}
      onOk={() => { if (dshId !== undefined) props.onInstall(dshId, installed) }}
      onCancel={props.onCancel}
      okButtonProps={{ disabled: okDisabled }}
      destroyOnHidden
    >
      {props.scopes.length === 0 ? (
        <EmptyState title={t('ext.target.noDsh')} />
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div>
            <FieldLabel>{t('ext.target.dsh')}</FieldLabel>
            <Select
              style={{ width: '100%' }}
              showSearch
              optionFilterProp="label"
              value={dshId}
              onChange={setDshId}
              options={props.scopes.map(scope => ({ value: scope.id, label: scope.name }))}
            />
          </div>
          {installed && (
            <Checkbox checked={overwrite} onChange={e => setOverwrite(e.target.checked)}>
              {t('ext.skills.overwrite')}
            </Checkbox>
          )}
          <div style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM }}>{hint}</div>
          <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            {t('ext.skills.installTargetHint')}
          </Typography.Text>
        </Space>
      )}
    </Modal>
  )
}
