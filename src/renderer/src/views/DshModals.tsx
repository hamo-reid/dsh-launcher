/** Modal dialogs for the DSH page — each owns its own state, so `DshSection`
 * is left with just list + activation orchestration. */

import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Checkbox, Input, List, Modal, Select, Space, Spin, Tag, message, theme } from 'antd'
import { CheckCircleFilled, CloseCircleFilled, LoadingOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../lib/ipc.ts'
import FieldLabel from '../components/FieldLabel.tsx'
import { MODAL } from '../theme.ts'
import type { DshInstallResult, DshInstallStep, PackageVersionInfo } from '../../../shared/types.ts'

// ── Add DSH ────────────────────────────────────────────────────────────────

interface Candidate {
  key: string
  execPath: string
  name: string
  version: string
  from: 'detect' | 'manual'
  /** True for manually added entries: register without probing/running commands. */
  manual?: boolean
}

interface AddDshModalProps {
  open: boolean
  onClose: () => void
  /** Called after a successful batch add so the owner can refresh its list. */
  onDone: () => void | Promise<void>
}
export function AddDshModal(p: AddDshModalProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [aliasInput, setAliasInput] = useState('')
  const [pathInput, setPathInput] = useState('')
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [checked, setChecked] = useState<string[]>([])
  const [detecting, setDetecting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [addError, setAddError] = useState('')

  useEffect(() => {
    if (p.open) { setCandidates([]); setChecked([]); setAddError('') }
  }, [p.open])

  const mergeCandidates = (entries: { id: string; name: string; execPath: string; version: string }[], from: Candidate['from'], manual = false): void => {
    setCandidates(prev => {
      const seen = new Set(prev.map(c => c.key))
      const fresh = entries
        .filter(e => !seen.has(e.id))
        .map<Candidate>(e => ({
          key: e.id,
          execPath: e.execPath,
          name: e.name,
          version: e.version,
          from,
          ...(manual ? { manual: true } : {}),
        }))
      return [...prev, ...fresh]
    })
  }

  const addPathToCandidates = (): void => {
    const path = pathInput.trim()
    const alias = aliasInput.trim()
    if (path === '') return
    setAddError('')
    const label = alias !== '' ? alias : (path.split(/[\\/]/).pop() ?? path)
    mergeCandidates([{ id: path, name: label, execPath: path, version: '' }], 'manual', true)
    setPathInput('')
    setAliasInput('')
  }

  const detectCandidates = async (): Promise<void> => {
    setAddError('')
    setDetecting(true)
    const r = await window.api.dsh.probe()
    setDetecting(false)
    if (!r.ok) { setAddError(apiErrorText(r)); return }
    if (r.value.length === 0) { void message.info(t('dsh.add.noDetected')); return }
    mergeCandidates(r.value, 'detect')
  }

  const batchAdd = async (): Promise<void> => {
    const selected = candidates.filter(c => checked.includes(c.key))
    if (selected.length === 0) return
    setBusy(true)
    let ok = 0
    for (const c of selected) {
      const r = c.manual ? await window.api.dsh.addManual(c.name, c.execPath) : await window.api.dsh.add(c.key)
      if (r.ok) ok += 1
      else void message.warning(`${c.name}: ${apiErrorText(r)}`)
    }
    setBusy(false)
    if (ok > 0) void message.success(t('dsh.add.added', { count: ok }))
    setCandidates([])
    setChecked([])
    p.onClose()
    void p.onDone()
  }

  const sourceTag = (from: Candidate['from']): string => from === 'detect' ? t('dsh.add.tag.detect') : t('dsh.add.tag.manual')

  return (
    <Modal title={t('dsh.add.title')} open={p.open} footer={null} onCancel={p.onClose} width={MODAL.narrow}>
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <FieldLabel>{t('dsh.add.aliasLabel')}</FieldLabel>
        <Input value={aliasInput} onChange={e => setAliasInput(e.target.value)} placeholder={t('dsh.add.aliasPlaceholder')} />

        <FieldLabel>{t('dsh.add.pathLabel')}</FieldLabel>
        <Space.Compact style={{ width: '100%' }}>
          <Input value={pathInput} onChange={e => setPathInput(e.target.value)} placeholder={t('dsh.add.pathPlaceholder')} onPressEnter={addPathToCandidates} />
          <Button onClick={addPathToCandidates} disabled={!pathInput.trim()}>{t('dsh.add.toCandidates')}</Button>
        </Space.Compact>

        <Button onClick={() => void detectCandidates()} loading={detecting} block>{t('dsh.add.detect')}</Button>

        {addError !== '' && <Alert type="error" showIcon message={addError} />}

        {candidates.length > 0 && (
          <>
            <Checkbox.Group value={checked} onChange={values => setChecked(values)} style={{ width: '100%' }}>
              <List
                dataSource={candidates}
                size="small"
                style={{ maxHeight: 260, overflowY: 'auto', border: `1px solid ${token.colorSplit}`, borderRadius: token.borderRadius }}
                renderItem={c => (
                  <List.Item key={c.key} style={{ padding: '6px 12px' }}>
                    <Checkbox value={c.key}>
                      <span>
                        {c.name} <Tag>{sourceTag(c.from)}</Tag>
                        {c.version !== '' && <span style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}> v{c.version}</span>}
                      </span>
                      <div style={{ fontSize: token.fontSizeSM, color: token.colorTextSecondary }}>{c.execPath}</div>
                    </Checkbox>
                  </List.Item>
                )}
              />
            </Checkbox.Group>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Button onClick={() => { setCandidates([]); setChecked([]) }}>{t('dsh.add.clear')}</Button>
              <Button type="primary" disabled={checked.length === 0} loading={busy} onClick={() => void batchAdd()}>
                {t('dsh.add.batchAdd', { count: checked.length })}
              </Button>
            </div>
          </>
        )}
      </Space>
    </Modal>
  )
}

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
function StepIcon({ status }: { status: InstallRow['status'] }): JSX.Element {
  if (status === 'running') return <LoadingOutlined spin style={{ color: '#faad14' }} />
  if (status === 'ok') return <CheckCircleFilled style={{ color: '#52c41a' }} />
  return <CloseCircleFilled style={{ color: '#ff4d4f' }} />
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
  const [installing, setInstalling] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<DshInstallResult | null>(null)
  const [detailView, setDetailView] = useState<string | null>(null)
  const [versionDir, setVersionDir] = useState('')
  const [installName, setInstallName] = useState('official')
  // npm 版本选择（官方包 @deepseek-ai/dsh）。
  const [pkgInfo, setPkgInfo] = useState<PackageVersionInfo | null>(null)
  const [version, setVersion] = useState('')
  const [versionsLoading, setVersionsLoading] = useState(false)
  const rowsRef = useRef<InstallRow[]>([])
  const [rows, setRows] = useState<InstallRow[]>([])

  const upsert = (row: InstallRow): void => {
    const next = [...rowsRef.current]
    const at = next.findIndex(r => r.key === row.key)
    if (at >= 0) next[at] = row
    else next.push(row)
    rowsRef.current = next
    setRows(next)
  }

  // Stream per-step progress straight into the install rows.
  useEffect(() => window.api.dsh.onInstallEvent((step: DshInstallStep) => {
    upsert({
      key: step.kind,
      label: t(`dsh.official.step.${step.kind}`),
      status: step.state,
      meta: step.version !== undefined && step.version !== '' ? `v${step.version}` : undefined,
      detail: step.detail,
    })
  }), [t])

  useEffect(() => {
    if (!p.open) return
    // 重新打开时重置状态，避免残留上一次的进度/结果。
    setInstalling(false)
    setDone(false)
    setError('')
    setResult(null)
    rowsRef.current = []
    setRows([])
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
    rowsRef.current = []
    setRows([])
    setError('')
    setResult(null)
    setDone(false)
    setInstalling(true)
    try {
      const r = await window.api.dsh.installOfficial({
        versionDir: versionDir.trim(),
        name: installName.trim(),
        // 版本留空 → undefined → 核心层解析 latest（修复「版本留空」BUG）
        // (version ?? '')：allowClear 清除后 Select 的 onChange 会传 undefined，
        // 直接 trim() 会抛 TypeError。
        version: (version ?? '').trim() || undefined,
        // 修复/重装模式强制覆盖同名安装（主进程先删再装）。
        force: p.preset?.force === true,
      })
      if (!r.ok) { setError(apiErrorText(r)); setDone(true); return }
      setResult(r.value)
      setDone(true)
      void message.success(t('dsh.official.installedNow', { version: r.value.version }))
      await p.onDone()
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
      setDone(true)
    } finally {
      // 兜底：任何异常都结束 loading，杜绝「一直显示正在安装」。
      setInstalling(false)
    }
  }

  return (
    <>
    <Modal title={p.preset?.force === true ? t('dsh.official.repairTitle') : t('dsh.official.title')} open={p.open}
      onCancel={installing ? undefined : p.onClose}
      closable={!installing} maskClosable={!installing} width={MODAL.wide}
      footer={installing
        ? <Button loading>{t('dsh.official.installing')}</Button>
        : done
          ? <Button type="primary" onClick={p.onClose}>{t('dsh.official.done')}</Button>
          : (
              <Space>
                <Button onClick={p.onClose}>{t('common.cancel')}</Button>
                <Button type="primary" onClick={() => void doInstallOfficial()}>{t('dsh.official.start')}</Button>
              </Space>
            )}>
      <Space direction="vertical" size="small" style={{ width: '100%' }}>
        {!installing && !done && (
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
                  />
                </div>
              )}
            <Alert type="info" showIcon message={t('dsh.official.stepsIntro')} />
            <ol style={{ paddingLeft: 20, margin: 0 }}>
              <li>{t('dsh.official.step1')}</li>
              <li>{t('dsh.official.step2')}</li>
              <li>{t('dsh.official.step3')}</li>
            </ol>
          </>
        )}

        {/* 逐行进度：转圈 / 绿勾 / 红叉；安装结束仍保留在下面。 */}
        {rows.length > 0 && (
          <div style={{ borderTop: `1px solid ${token.colorSplit}`, paddingTop: token.paddingSM }}>
            {rows.map(row => (
              <div key={row.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
                <StepIcon status={row.status} />
                <span style={{ flex: 1, minWidth: 0 }}>{row.label}</span>
                {row.meta !== undefined && (
                  <span style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>{row.meta}</span>
                )}
                {row.status === 'error' && (
                  <Button type="link" size="small" style={{ padding: 0, color: '#ff4d4f' }} onClick={() => setDetailView(row.detail ?? '')}>{t('dsh.official.errorLabel')}</Button>
                )}
              </div>
            ))}
          </div>
        )}

        {done && error !== '' && (
          <Alert type="error" showIcon message={t('dsh.official.failed')} description={error} />
        )}

        {done && result !== null && (
          <Alert type="success" showIcon
            message={t('dsh.official.installedVersion', { version: result.version })}
            description={`${t('dsh.official.resultPath')} ${result.execPath}\n${t('dsh.official.resultHome')} ${result.home}`} />
        )}
      </Space>
    </Modal>

    {/* 失败详情：点击某行的 Error 弹出完整错误文本。 */}
    <Modal title={t('dsh.official.failDetailTitle')} open={detailView !== null} onOk={() => setDetailView(null)} onCancel={() => setDetailView(null)}
      okText={t('common.close')} width={MODAL.wide}
      footer={(
        <Space>
          <Button onClick={() => { if (detailView !== null) void navigator.clipboard.writeText(detailView) }}>{t('common.copy')}</Button>
          <Button type="primary" onClick={() => setDetailView(null)}>{t('common.close')}</Button>
        </Space>
      )}>
      <pre style={{ margin: 0, maxHeight: 400, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: token.colorFillTertiary, padding: token.paddingSM, borderRadius: token.borderRadius }}>
        {detailView}
      </pre>
    </Modal>
    </>
  )
}

// ── Rename ─────────────────────────────────────────────────────────────────

interface RenameDshModalProps {
  target: { id: string; name: string } | null
  onClose: () => void
  onDone: () => void | Promise<void>
}
export function RenameDshModal(p: RenameDshModalProps): JSX.Element {
  const { t } = useTranslation()
  const [renameName, setRenameName] = useState('')
  useEffect(() => { if (p.target !== null) setRenameName(p.target.name) }, [p.target])

  const doRename = async (): Promise<void> => {
    if (p.target === null) return
    const r = await window.api.dsh.rename(p.target.id, renameName.trim())
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    p.onClose()
    void message.success(t('dsh.rename.done'))
    await p.onDone()
  }

  return (
    <Modal title={`${t('dsh.rename.title')}${p.target !== null ? ` · ${p.target.name}` : ''}`} open={p.target !== null}
      okText={t('common.save')} onOk={() => void doRename()} onCancel={p.onClose} destroyOnClose>
      <FieldLabel>{t('dsh.rename.newAlias')}</FieldLabel>
      <Input value={renameName} onChange={e => setRenameName(e.target.value)} placeholder={t('dsh.rename.newAlias')} onPressEnter={() => void doRename()} />
    </Modal>
  )
}

// ── Remove (optionally deleting files, with a second confirm) ───────────────

interface DshRemoveModalProps {
  dsh: { id: string; name: string } | null
  onClose: () => void
  /** Called once removed, so the owner refreshes the list. */
  onRemoved: () => void | Promise<void>
}
export function DshRemoveModal(p: DshRemoveModalProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [busy, setBusy] = useState(false)

  const removeNow = async (): Promise<void> => {
    if (p.dsh === null) return
    setBusy(true)
    try {
      // 移除即删除安装文件（含官方安装的独立 home）。仅从列表脱管会让版本库自动发现
      // 把它重新收录回来，故不再提供「仅移除」；不可逆保护交给 doRemove 的强确认。
      const r = await window.api.dsh.remove(p.dsh.id, { deleteFiles: true })
      if (!r.ok) { void message.error(apiErrorText(r)); return }
      void message.success(t('dsh.removed'))
      p.onClose()
      await p.onRemoved()
    } finally {
      setBusy(false)
    }
  }

  const doRemove = (): void => {
    // 两步确认：先在弹窗点「移除」，再经强确认后才真正删除文件。
    Modal.confirm({
      title: t('dsh.remove.confirmDeleteTitle'),
      content: t('dsh.remove.confirmDelete', { name: p.dsh?.name ?? '' }),
      okText: t('common.confirm'),
      okButtonProps: { danger: true },
      onOk: () => void removeNow(),
    })
  }

  return (
    <Modal title={t('dsh.remove.title')} open={p.dsh !== null} onCancel={busy ? undefined : p.onClose}
      closable={!busy} maskClosable={!busy} width={MODAL.narrow}
      footer={(
        <Space>
          <Button onClick={p.onClose} disabled={busy}>{t('common.cancel')}</Button>
          <Button type="primary" danger loading={busy} onClick={() => void doRemove()}>{t('dsh.remove.remove')}</Button>
        </Space>
      )}>
      <Space direction="vertical" size="small" style={{ width: '100%' }}>
        <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>
          {t('dsh.remove.hint')}
        </div>
      </Space>
    </Modal>
  )
}