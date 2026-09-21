/**
 * Dev plugins: local source dirs linked (`link:`) into profiles, kept in their
 * own registry and managed separately from the plugin store — never update
 * checked, version-managed or removed with it, and never deleted from disk.
 *
 * This file is the list. The data and every action come from `useDevPlugins`, and
 * the three dialogs that hang off a row are their own components, so what is left
 * here is what the page shows.
 */
import { useState } from 'react'
import { Alert, Button, Dropdown, Empty, Space, Spin, Tag, Tooltip, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import { parseBuildKey, scopeLabel, statusOf } from '../../lib/devPlugins.ts'
import { useDevPlugins } from './useDevPlugins.ts'
import DevDiagnosisModal from './modals/DevDiagnosisModal.tsx'
import DevLinkModal from './modals/DevLinkModal.tsx'
import DevOutputModal from './modals/DevOutputModal.tsx'
import ConfirmMenu, { type MenuAction } from '../../components/ConfirmMenu.tsx'
import Panel from '../../components/Panel.tsx'
import SectionHeading from '../../components/SectionHeading.tsx'
import type { DevPlugin } from '../../../../shared/types.ts'

export default function DevPluginsView(): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const {
    hosts, target, listMeta, profileOptions, retarget,
    plugins, usage, diags, loading, busy, reload,
    detail, closeDetail, diagnose, buildMenuItems,
    add, install, runBuild, shim, unshim, snapshot, unregister,
    output, closeOutput,
  } = useDevPlugins()

  /** The package being attached to a profile, if any. */
  const [linkPkg, setLinkPkg] = useState<DevPlugin | null>(null)

  const status = (name: string): { color: string; label: string } | null => {
    const verdict = statusOf(diags[name])
    if (verdict === null) return null
    if (verdict.kind === 'noEntry') return { color: 'error', label: t('plugin.dev.status.noEntry') }
    return verdict.kind === 'issues'
      ? { color: 'warning', label: t('plugin.dev.status.issues', { count: verdict.count }) }
      : { color: 'success', label: t('plugin.dev.status.ok') }
  }

  const rowActions = (p: DevPlugin): MenuAction[] => [
    { key: 'reveal', label: t('plugin.dev.reveal') },
    ...(p.workspaceRoot !== undefined ? [{ key: 'reveal-ws', label: t('plugin.dev.revealWorkspace') } as MenuAction] : []),
    { key: 'snapshot', label: t('plugin.dev.snapshot'), confirmText: t('plugin.dev.snapshotConfirm', { name: p.name }) },
    { key: 'remove', label: t('plugin.dev.unregister'), danger: true, confirmText: t('plugin.dev.unregisterConfirm', { name: p.name }) },
  ]

  const onRowAction = (p: DevPlugin, key: string): void => {
    if (key === 'reveal') void window.api.plugins.devReveal(p.name)
    else if (key === 'reveal-ws') void window.api.plugins.devRevealWorkspace(p.name)
    else if (key === 'snapshot') void snapshot(p.name)
    else if (key === 'remove') void unregister(p.name)
  }

  const linkedProfiles = (name: string): string[] => (usage[name] ?? []).map(u => u.profile)

  // The badges below belong to the last run, so the chain they were computed
  // against is shown with them.
  const listScope = scopeLabel(listMeta, hosts)

  return (
    <>
      <Space orientation="vertical" style={{ width: '100%' }} size="middle">
        <SectionHeading
          title={t('plugin.dev.title')}
          description={t('plugin.dev.desc')}
          extra={<Button type="primary" onClick={() => void add()}>{t('plugin.dev.add')}</Button>}
        />
        <Alert type="info" showIcon title={t('plugin.dev.hint')} />
        {listScope !== null && (
          <div style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM }}>
            <Tooltip title={t('plugin.dev.detectedHint')}>{t(listScope.key, listScope.params)}</Tooltip>
          </div>
        )}
        <Panel pad={false}>
          {loading ? (
            <div style={{ padding: token.padding, textAlign: 'center' }}><Spin /></div>
          ) : plugins.length === 0 ? (
            <div style={{ padding: token.padding }}>
              <Empty description={t('plugin.dev.emptyDesc')} />
            </div>
          ) : (
            <div>
              {plugins.map(p => {
                const st = status(p.name)
                const used = linkedProfiles(p.name)
                return (
                  <div
                    key={p.name}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: `1px solid ${token.colorSplit}` }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 600 }}>{p.name}</span>
                        {p.version !== undefined && <Tag style={{ fontFamily: 'monospace' }}>@{p.version}</Tag>}
                        <Tag color={p.bundle ? 'geekblue' : 'default'}>
                          {t(p.bundle ? 'plugin.dev.bundle' : 'plugin.dev.dependency')}
                        </Tag>
                        {st !== null && <Tag color={st.color}>{st.label}</Tag>}
                      </div>
                      <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, marginTop: 2, wordBreak: 'break-all' }}>
                        <Tooltip title={p.dir}>{t('plugin.dev.dir')}: {p.dir}</Tooltip>
                        {p.workspaceRoot !== undefined && <span> · {t('plugin.dev.workspace')}: {p.workspaceRoot}</span>}
                        <span> · {used.length > 0 ? t('plugin.dev.usedBy', { profiles: used.join(t('common.listSep')) }) : t('plugin.dev.unused')}</span>
                      </div>
                    </div>
                    <Space size={4} wrap style={{ flexShrink: 0 }}>
                      <Button size="small" loading={busy === `diag:${p.name}`} onClick={() => void diagnose(p.name)}>{t('plugin.dev.diagnose')}</Button>
                      <Button size="small" type="primary" ghost onClick={() => setLinkPkg(p)}>{t('plugin.dev.linkToProfile')}</Button>
                      <Dropdown.Button
                        size="small"
                        loading={busy === `build:${p.name}`}
                        onClick={() => void runBuild(p.name)}
                        menu={{ items: buildMenuItems(p.name), onClick: ({ key }) => void runBuild(p.name, parseBuildKey(key)) }}
                      >
                        {t('plugin.dev.build')}
                      </Dropdown.Button>
                      <ConfirmMenu actions={rowActions(p)} onAction={key => onRowAction(p, key)} />
                    </Space>
                  </div>
                )
              })}
            </div>
          )}
        </Panel>
      </Space>

      <DevDiagnosisModal
        report={detail}
        busy={busy}
        hosts={hosts}
        target={target}
        buildMenuItems={buildMenuItems}
        onRetarget={retarget}
        onDiagnose={diagnose}
        onInstall={install}
        onShim={shim}
        onUnshim={unshim}
        onBuild={runBuild}
        onClose={closeDetail}
      />
      <DevLinkModal pkg={linkPkg} onClose={() => setLinkPkg(null)} onLinked={reload} />
      <DevOutputModal output={output} onClose={closeOutput} />
    </>
  )
}
