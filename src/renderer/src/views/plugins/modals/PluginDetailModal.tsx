/**
 * The plugin detail dialog: usage, README, versions, and every action that can be
 * taken on one installed plugin.
 *
 * It is the largest of the plugins-page dialogs because it is the hub — uninstall,
 * single-version removal, store cleanup, reveal, migrate-to-replacement and both
 * download entry points start here.
 */
import { useEffect, useState } from 'react'
import { Button, Modal, Popconfirm, Space, Tabs, Tag, Tooltip, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import { fmtBytes } from '../../../lib/format.ts'
import FieldLabel from '../../../components/FieldLabel.tsx'
import PluginReadme from '../PluginReadme.tsx'
import { MODAL } from '../../../theme.ts'
import type { InstalledOverviewRow, PluginUpdateInfo } from '../../../../../shared/types.ts'

const SOURCE_COLORS: Record<string, string> = {
  github: 'green',
  npm: 'blue',
  local: 'cyan',
  dsh: 'purple',
  store: 'default',
}

// ── Plugin detail: usage + README ──────────────────────────────────────────

interface PluginDetailModalProps {
  target: InstalledOverviewRow | null
  busy: boolean
  /** Update-check result for this plugin, when a check has run. */
  update?: PluginUpdateInfo
  /** Archived versions of the plugin in the store — the ones a single-version
   * delete operates on. */
  storeVersions: string[]
  /** Real on-disk size from the overview's manual size calc, when computed. */
  sizeBytes?: number
  onClose: () => void
  /** Open the version picker to download another version into the store. */
  onDownloadVersion: (name: string) => void
  /** One-click download of the newest release into the store. */
  onUpdate: (name: string) => void
  onUninstall: (name: string) => void
  onUninstallVersion: (name: string, version: string) => void
  onReveal: (name: string) => void
  onInstallToProfile: (name: string) => void
  /** Remove the plugin's unused archived versions (keep newest + in-use). */
  onCleanupVersions: (name: string) => void
  /** Catalog replacement name when this plugin is deprecated. */
  replacement?: string
  /** Migrate the deprecated plugin to `replacement` across using profiles. */
  onMigrate: (name: string, replacement: string) => void
}
export function PluginDetailModal(p: PluginDetailModalProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [tab, setTab] = useState<'usage' | 'readme'>('usage')
  const [readmeText, setReadmeText] = useState('')
  const [readmeDir, setReadmeDir] = useState('')

  useEffect(() => {
    if (p.target === null) { setReadmeText(''); setReadmeDir(''); setTab('usage'); return }
    let alive = true
    void window.api.plugins.readme(p.target.name).then(result => {
      if (result.ok && alive) { setReadmeText(result.value.content); setReadmeDir(result.value.dir) }
    })
    return () => { alive = false }
  }, [p.target])

  const target = p.target
  const usedVersions = new Set((target?.usage ?? []).map(u => u.version).filter((v): v is string => v !== undefined && v !== ''))
  const latestStoreVersion = p.storeVersions.length > 0 ? p.storeVersions[p.storeVersions.length - 1] : undefined
  const unusedVersions = p.storeVersions.filter(v => v !== latestStoreVersion && !usedVersions.has(v))
  return (
    <Modal title={target?.name ?? ''} open={target !== null} onCancel={p.onClose} width={MODAL.wide}
      footer={target !== null ? (
        <Space>
          <Button onClick={() => void p.onReveal(target.name)}>{t('plugin.detail.reveal')}</Button>
          <Button onClick={() => p.onDownloadVersion(target.name)}>{t('plugin.detail.downloadVersion')}</Button>
          {p.update?.updateAvailable === true && p.update.latest !== undefined && (
            <Button type="primary" ghost onClick={() => p.onUpdate(target.name)}>
              {t('plugin.overview.updateTo', { version: p.update.latest })}
            </Button>
          )}
          {target.inStore === true && (
            <>
              <Button danger type="primary" ghost loading={p.busy}
                onClick={() => {
                  const using = (target?.usage ?? []).map(u => `DSH「${u.dsh}」· profile「${u.profile}」`)
                  // Cascade: the plugin is in use, so the user must know the
                  // profiles will lose their reference along with the store removal.
                  Modal.confirm({
                    title: using.length > 0
                      ? t('plugin.detail.removeAllCascade', { name: target.name })
                      : t('plugin.detail.removeAllVersionsConfirm', { name: target.name }),
                    content: using.length > 0
                      ? t('plugin.detail.removeAllCascadeList', { profiles: using.join(t('common.listSep')) })
                      : undefined,
                    okText: t('common.confirm'),
                    okButtonProps: { danger: true },
                    onOk: () => { void p.onUninstall(target.name) },
                  })
                }}>
                {t('plugin.detail.removeAllVersions')}
              </Button>
              <Button type="primary" onClick={() => { void p.onInstallToProfile(target.name) }}>{t('plugin.detail.installToProfile')}</Button>
            </>
          )}
          {p.replacement !== undefined && p.replacement !== '' && (
            <Button
              type="primary"
              onClick={() => {
                const replacement = p.replacement as string
                Modal.confirm({
                  title: t('plugin.detail.migrateConfirmTitle', { name: target.name, target: replacement }),
                  content: t('plugin.detail.migrateConfirmBody'),
                  okText: t('common.confirm'),
                  onOk: () => { p.onMigrate(target.name, replacement) },
                })
              }}
            >
              {t('plugin.detail.migrateTo', { target: p.replacement })}
            </Button>
          )}
        </Space>
      ) : null}>
      <Tabs activeKey={tab} onChange={key => setTab(key as 'usage' | 'readme')} items={[
        {
          key: 'usage',
          label: t('plugin.detail.usageTab'),
          children: (
            <Space orientation="vertical" style={{ width: '100%' }} size="middle">
              <Space wrap>
                {(target?.sources ?? []).map(s => (
                  <Tag key={s} color={SOURCE_COLORS[s] ?? 'default'}>{t(`plugin.source.${s}`)}</Tag>
                ))}
                {(target?.sources.length ?? 0) === 0 && <span style={{ color: token.colorTextTertiary }}>-</span>}
                <Tag>{t('plugin.detail.usageCount', { count: target?.usage.length ?? 0 })}</Tag>
                {p.sizeBytes !== undefined && <Tag>{t('plugin.detail.size')}: {fmtBytes(p.sizeBytes)}</Tag>}
              </Space>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <FieldLabel>{t('plugin.detail.versionsLabel')}</FieldLabel>
                  {unusedVersions.length > 0 && (
                    <Popconfirm
                      title={t('plugin.detail.cleanupConfirm', { count: unusedVersions.length })}
                      okText={t('common.confirm')}
                      okButtonProps={{ danger: true }}
                      onConfirm={() => { if (target !== null) p.onCleanupVersions(target.name) }}
                    >
                      <Button size="small" loading={p.busy}>{t('plugin.detail.cleanupVersions', { count: unusedVersions.length })}</Button>
                    </Popconfirm>
                  )}
                </div>
                {target !== null && p.storeVersions.length === 0 && (target.versions.length === 0)
                  ? <span style={{ color: token.colorTextSecondary }}>{t('plugin.detail.noVersions')}</span>
                  : (
                    <div>
                      {/* 本地存储归档版本 —— 逐个可管理：未使用可单删，使用中标记并禁用 */}
                      {p.storeVersions.length > 0 && p.storeVersions.map(v => {
                        const users = (target?.usage ?? []).filter(u => u.version === v).map(u => u.profile)
                        const inUse = users.length > 0
                        return (
                          <div key={v} style={{ display: 'flex', alignItems: 'center', padding: '4px 0', borderBottom: `1px solid ${token.colorSplit}` }}>
                            <Tag color="blue" style={{ flexShrink: 0 }}>{t('plugin.detail.storeTag')}</Tag>
                            <span style={{ fontFamily: 'monospace', marginInline: 6, color: token.colorText }}>{v}</span>
                            {inUse
                              ? (
                                <Tooltip title={t('plugin.detail.inUseBy', { profiles: users.join(t('common.listSep')) })}>
                                  <Tag color="green" style={{ marginInlineStart: 'auto' }}>{t('plugin.detail.versionInUse')}</Tag>
                                </Tooltip>
                              )
                              : (
                                <span style={{ marginInlineStart: 'auto' }}>
                                  <Popconfirm title={t('plugin.detail.removeVersionConfirm', { version: v })}
                                    okText={t('common.confirm')} okButtonProps={{ danger: true }}
                                    onConfirm={() => { if (target !== null) void p.onUninstallVersion(target.name, v) }}>
                                    <Button size="small" danger type="text" loading={p.busy}>{t('plugin.detail.removeVersion')}</Button>
                                  </Popconfirm>
                                </span>
                              )}
                          </div>
                        )
                      })}
                      {/* 非 store 的已解析版本（内置 bundle / 本地 link）—— 只读展示 */}
                      {(target?.versions ?? []).filter(v => !p.storeVersions.includes(v)).map(v => (
                        <div key={v} style={{ display: 'flex', alignItems: 'center', padding: '4px 0', borderBottom: `1px solid ${token.colorSplit}` }}>
                          <Tag color="purple" style={{ flexShrink: 0 }}>{t('plugin.detail.notInStore')}</Tag>
                          <span style={{ fontFamily: 'monospace', marginInline: 6, color: token.colorText }}>{v}</span>
                        </div>
                      ))}
                    </div>
                  )}
              </div>
              <div>
                <FieldLabel>{t('plugin.detail.usageTab')}</FieldLabel>
                {target !== null && target.usage.length === 0
                  ? <span style={{ color: token.colorTextSecondary }}>{t('plugin.detail.noUsage')}</span>
                  : (target?.usage ?? []).map((u, i) => (
                      <div key={i} style={{ padding: '6px 0', fontSize: token.fontSize, lineHeight: 1.6, borderBottom: i < (target?.usage.length ?? 0) - 1 ? `1px solid ${token.colorSplit}` : 0 }}>
                        <span>DSH「{u.dsh}」</span>
                        {u.dshVersion !== undefined && <Tag style={{ marginInline: 4 }}>v{u.dshVersion}</Tag>}
                        <span>· profile「{u.profile}」</span>
                        {u.version !== undefined && <Tag style={{ marginInline: 4, fontFamily: 'monospace' }}>@{u.version}</Tag>}
                      </div>
                    ))}
              </div>
            </Space>
          ),
        },
        {
          key: 'readme',
          label: t('plugin.detail.readmeTab'),
          children: readmeText === '' ? (
            <div style={{ color: token.colorTextSecondary }}>{t('plugin.detail.noReadme')}</div>
          ) : (
            <PluginReadme text={readmeText} dir={readmeDir} />
          ),
        },
      ]} />
    </Modal>
  )
}

