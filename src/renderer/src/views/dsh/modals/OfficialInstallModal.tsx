/**
 * Install the official dsh from npm, at a chosen version, watching the install
 * steps stream in.
 */
import { useEffect, useState } from 'react'
import { Alert, Button, Input, Modal, Select, Space, Spin, Tag, message, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../../../lib/ipc.ts'
import FieldLabel from '../../../components/FieldLabel.tsx'
import { MODAL } from '../../../theme.ts'
import type { DshInstallStep, PackageVersionInfo } from '../../../../../shared/types.ts'

// ── Official install ───────────────────────────────────────────────────────

/** One progress row of an official install (per `DshInstallStep`). */
interface InstallRow {
  key: string
  label: string
  status: 'running' | 'ok' | 'error'
  /** Right-aligned version detail (pinned/resolved version once known). */
  meta?: string
  detail?: string
}
interface OfficialInstallModalProps {
  open: boolean
  onClose: () => void
  onDone: () => void | Promise<void>
  /** Repair mode: prefill the install name and force-overwrite a broken install. */
  preset?: { name?: string; force?: boolean }
}
export function OfficialInstallModal(p: OfficialInstallModalProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [error, setError] = useState('')
  const [versionDir, setVersionDir] = useState('')
  const [installName, setInstallName] = useState('official')
  // npm 版本选择（官方包 @deepseek-ai/dsh）。
  const [pkgInfo, setPkgInfo] = useState<PackageVersionInfo | null>(null)
  const [version, setVersion] = useState('')
  const [versionsLoading, setVersionsLoading] = useState(false)

  useEffect(() => {
    if (!p.open) return
    // 重新打开时重置状态，避免残留上一次的进度/结果。
    setError('')
    setVersionDir('')
    setPkgInfo(null)
    setVersion('')
    setInstallName(p.preset?.name ?? 'official')
    setVersionsLoading(true)
    let alive = true
    void (async () => {
      const v = await window.api.dsh.getVersionDir()
      if (v.ok && alive) setVersionDir(v.value.dir)
      const vv = await window.api.dsh.pkgVersions()
      if (!alive) return
      setVersionsLoading(false)
      if (vv.ok) {
        setPkgInfo(vv.value)
        const latest = vv.value.distTags.latest ?? vv.value.versions[0]
        if (latest !== undefined) setVersion(latest)
      }
    })()
    return () => { alive = false }
  }, [p.open])

  const doInstallOfficial = async (): Promise<void> => {
    // Kicks off a **background** dsh download session and closes immediately; the
    // global download center streams the install progress.
    const r = await window.api.dsh.installOfficial({
      versionDir: versionDir.trim(),
      name: installName.trim(),
      // 版本留空 → undefined → 核心层解析 latest（修复「版本留空」BUG）
      version: (version ?? '').trim() || undefined,
      // 修复/重装模式强制覆盖同名安装（主进程先删再装）。
      force: p.preset?.force === true,
    })
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('dsh.official.started'))
    p.onClose()
    await p.onDone()
  }

  return (
    <>
    <Modal title={p.preset?.force === true ? t('dsh.official.repairTitle') : t('dsh.official.title')} open={p.open}
      onCancel={p.onClose} closable mask={{ closable: true }} width={MODAL.wide}
      footer={(
        <Space>
          <Button onClick={p.onClose}>{t('common.cancel')}</Button>
          <Button type="primary" onClick={() => void doInstallOfficial()}>{t('dsh.official.start')}</Button>
        </Space>
      )}>
      <Space orientation="vertical" size="small" style={{ width: '100%' }}>
        <>
            <FieldLabel>{t('dsh.official.dirLabel')}</FieldLabel>
            <Input value={versionDir} onChange={e => setVersionDir(e.target.value)} placeholder={t('dsh.official.dirPlaceholder')} />
            <FieldLabel>{t('dsh.official.nameLabel')}</FieldLabel>
            <Input value={installName} onChange={e => setInstallName(e.target.value)} placeholder="official" />
            <FieldLabel>{t('dsh.official.versionLabel')} <span style={{ fontWeight: 400, color: 'inherit' }}>{t('dsh.official.versionHint')}</span></FieldLabel>
            {versionsLoading
              ? <Spin size="small" />
              : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {pkgInfo !== null && Object.keys(pkgInfo.distTags).length > 0 && (
                    <div>{Object.entries(pkgInfo.distTags).map(([tag, ver]) => (
                      <Tag key={tag} style={{ marginBottom: 4 }}>{tag}={ver}</Tag>
                    ))}</div>
                  )}
                  <Select
                    placeholder={t('dsh.official.versionPlaceholder')}
                    value={version || undefined}
                    onChange={v => setVersion(v ?? '')}
                    showSearch
                    allowClear
                    optionFilterProp="label"
                    options={(pkgInfo?.versions ?? []).map(v => ({ value: v, label: v }))}
                    optionRender={({ label }) => {
                      const tags = pkgInfo?.distTags ?? {}
                      const marks: string[] = []
                      if (tags['latest'] === String(label)) marks.push('latest')
                      if (tags['next'] === String(label)) marks.push('next')
                      return (
                        <Space size={6}>
                          {marks.includes('latest') && <Tag color="blue">{t('dsh.update.track.latest')}</Tag>}
                          {marks.includes('next') && <Tag color="purple">{t('dsh.update.track.next')}</Tag>}
                          {label}
                        </Space>
                      )
                    }}
                  />
                </div>
              )}
            <Alert type="info" showIcon title={t('dsh.official.stepsIntro')} />
            <ol style={{ paddingLeft: 20, margin: 0 }}>
              <li>{t('dsh.official.step1')}</li>
              <li>{t('dsh.official.step2')}</li>
              <li>{t('dsh.official.step3')}</li>
            </ol>
        </>
      </Space>
    </Modal>
    </>
  )
}

