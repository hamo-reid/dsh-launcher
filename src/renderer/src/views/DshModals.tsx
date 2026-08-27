/** Modal dialogs for the DSH page — each owns its own state, so `DshSection`
 * is left with just list + activation orchestration. */

import { useEffect, useRef, useState } from 'react'
import {
  Alert, Button, Checkbox, Input, List, Modal, Select, Space, Spin, Tag, message, theme,
} from 'antd'
import { CheckCircleFilled, CloseCircleFilled, LoadingOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../lib/ipc.ts'
import FieldLabel from '../components/FieldLabel.tsx'
import { MODAL } from '../theme.ts'
import { majorOfVersion } from '../../../shared/version.ts'
import type {
  DshDataImportResult, DshUpdateInfo, PackageVersionInfo,
} from '../../../shared/types.ts'

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
      <Space orientation="vertical" style={{ width: '100%' }} size="middle">
        <FieldLabel>{t('dsh.add.aliasLabel')}</FieldLabel>
        <Input value={aliasInput} onChange={e => setAliasInput(e.target.value)} placeholder={t('dsh.add.aliasPlaceholder')} />

        <FieldLabel>{t('dsh.add.pathLabel')}</FieldLabel>
        <Space.Compact style={{ width: '100%' }}>
          <Input value={pathInput} onChange={e => setPathInput(e.target.value)} placeholder={t('dsh.add.pathPlaceholder')} onPressEnter={addPathToCandidates} />
          <Button onClick={addPathToCandidates} disabled={!pathInput.trim()}>{t('dsh.add.toCandidates')}</Button>
        </Space.Compact>

        <Button onClick={() => void detectCandidates()} loading={detecting} block>{t('dsh.add.detect')}</Button>

        {addError !== '' && <Alert type="error" showIcon title={addError} />}

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

// ── Update (in-place version upgrade of a managed dsh) ───────────────────────

interface UpdateDshModalProps {
  /** The managed dsh to update; `null` hides the modal. */
  dsh: { id: string; name: string } | null
  onClose: () => void
  onDone: () => void | Promise<void>
}
export function UpdateDshModal(p: UpdateDshModalProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [info, setInfo] = useState<DshUpdateInfo | null>(null)
  const [checking, setChecking] = useState(false)
  const [ackMajor, setAckMajor] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (p.dsh === null) return
    setInfo(null); setChecking(true); setAckMajor(false); setError('')
    let alive = true
    void (async () => {
      const r = await window.api.dsh.checkUpdate(p.dsh!.id)
      if (!alive) return
      setChecking(false)
      if (r.ok) setInfo(r.value)
      else setError(apiErrorText(r))
    })()
    return () => { alive = false }
  }, [p.dsh?.id])

  // Kicks off a **background** dsh download session and closes immediately; the
  // global download center tracks progress and refresh (not this dialog).
  const doUpdate = async (version: string): Promise<void> => {
    if (p.dsh === null) return
    const r = await window.api.dsh.update(p.dsh.id, { version, ackMajorRisk: ackMajor })
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('dsh.update.started'))
    p.onClose()
    await p.onDone()
  }

  // The update tracks offered (oldest → newest): `latest` stable and/or `next`
  // prerelease, each with its own button + major-bump gate.
  const tracks = info === null
    ? []
    : [
        ...(info.latest !== undefined ? [{ key: 'latest' as const, ...info.latest }] : []),
        ...(info.next !== undefined ? [{ key: 'next' as const, ...info.next }] : []),
      ]
  const hasBump = tracks.some(t => t.majorBump)

  const footer = <Button onClick={p.onClose}>{t('common.close')}</Button>

  return (
    <Modal title={t('dsh.update.title', { name: p.dsh?.name ?? '' })} open={p.dsh !== null}
      onCancel={p.onClose} closable mask={{ closable: true }}
      width={MODAL.narrow} footer={footer} destroyOnHidden>
      <Space orientation="vertical" size="small" style={{ width: '100%' }}>
        {checking && <div><Spin size="small" /> {t('dsh.update.checking')}</div>}

        {!checking && error !== '' && <Alert type="error" showIcon title={error} />}
        {!checking && error === '' && info === null && checking === false && (
          <Alert type="success" showIcon title={t('dsh.update.upToDate')} />
        )}

        {!checking && error === '' && info !== null && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: token.colorTextSecondary }}>{t('dsh.update.current')}</span>
              <code>{info.current || t('common.unknown')}</code>
            </div>
            {info.latest === undefined && info.next !== undefined && (
              <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>
                {t('dsh.update.latestCurrent')}
              </div>
            )}
            <Space orientation="vertical" style={{ width: '100%' }}>
              {tracks.map(trk => (
                <div
                  key={trk.key}
                  style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
                    border: `1px solid ${token.colorBorder}`, borderRadius: token.borderRadiusLG, padding: '10px 12px',
                  }}
                >
                  <Space size={6}>
                    <Tag color={trk.key === 'latest' ? 'blue' : 'purple'}>
                      {trk.key === 'latest' ? t('dsh.update.track.latest') : t('dsh.update.track.next')}
                    </Tag>
                    <code>{trk.version}</code>
                    {trk.majorBump && <Tag color="orange">{t('dsh.update.bump')}</Tag>}
                  </Space>
                  <Button
                    size="small" type="primary"
                    disabled={trk.majorBump && !ackMajor}
                    onClick={() => void doUpdate(trk.version)}
                  >
                    {t('dsh.update.go')}
                  </Button>
                </div>
              ))}
            </Space>
            {hasBump && (
              <>
                <Alert type="warning" showIcon title={t('dsh.update.majorWarn')} />
                <Checkbox checked={ackMajor} onChange={e => setAckMajor(e.target.checked)}>
                  {t('dsh.update.ackMajor')}
                </Checkbox>
              </>
            )}
          </>
        )}

        </Space>
    </Modal>
  )
}

// ── Data mirror (migrate a dsh's data to another dsh's home) ────────────────

interface DataMirrorModalProps {
  open: boolean
  /** The source dsh (whose data migrates); `null` hides the modal. */
  source: { id: string; name: string; version: string } | null
  onClose: () => void
  onDone: () => void | Promise<void>
}
export function DataMirrorModal(p: DataMirrorModalProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [targets, setTargets] = useState<{ id: string; name: string; version: string }[]>([])
  const [targetId, setTargetId] = useState<string>()
  const [ackCross, setAckCross] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<DshDataImportResult | null>(null)

  useEffect(() => {
    if (!p.open) return
    setTargets([]); setTargetId(undefined); setAckCross(false); setBusy(false); setError(''); setResult(null)
    void (async () => {
      const r = await window.api.dsh.list()
      if (r.ok) setTargets(r.value.dshes.filter(d => d.id !== p.source?.id))
    })()
  }, [p.open])

  const target = targets.find(d => d.id === targetId)
  const crossMajor = target !== undefined && p.source !== null
    && majorOfVersion(target.version) !== -1 && majorOfVersion(p.source.version) !== -1
    && majorOfVersion(target.version) !== majorOfVersion(p.source.version)

  const doMirror = async (): Promise<void> => {
    if (p.source === null || targetId === undefined) { void message.warning(t('data.mirror.noTarget')); return }
    if (crossMajor && !ackCross) return
    setBusy(true); setError('')
    try {
      const r = await window.api.data.mirror(p.source.id, targetId)
      if (!r.ok) { setError(apiErrorText(r)); return }
      setResult(r.value)
      void message.success(t('data.mirror.done'))
      await p.onDone()
    } finally {
      setBusy(false)
    }
  }

  const footer = busy
    ? <Space><Button loading>{t('data.mirror.running')}</Button></Space>
    : result !== null
      ? <Button type="primary" onClick={p.onClose}>{t('common.close')}</Button>
      : (
        <Space>
          <Button onClick={p.onClose} disabled={busy}>{t('common.cancel')}</Button>
          <Button type="primary" disabled={targetId === undefined || (crossMajor && !ackCross)} onClick={() => void doMirror()}>
            {t('data.mirror.start')}
          </Button>
        </Space>
      )

  return (
    <Modal title={t('data.mirror.title', { name: p.source?.name ?? '' })} open={p.open}
      onCancel={busy ? undefined : p.onClose} closable={!busy} mask={{ closable: !busy }}
      width={MODAL.narrow} footer={footer}>
      <Space orientation="vertical" size="small" style={{ width: '100%' }}>
        {result === null && (
          <>
            <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>
              {t('data.mirror.prompt')}
            </div>
            <Select
              style={{ width: '100%' }} showSearch optionFilterProp="label"
              placeholder={t('data.mirror.targetPlaceholder')}
              value={targetId} onChange={v => { setTargetId(v); setAckCross(false) }}
              options={targets.map(d => ({ value: d.id, label: d.name }))}
            />
            {crossMajor && (
              <>
                <Alert type="warning" showIcon title={t('data.mirror.crossMajor')} />
                <Checkbox checked={ackCross} onChange={e => setAckCross(e.target.checked)}>
                  {t('data.mirror.ack')}
                </Checkbox>
              </>
            )}
          </>
        )}

        {error !== '' && <Alert type="error" showIcon title={error} />}
        {result !== null && (
          <Alert type="success" showIcon title={t('data.mirror.done')} description={result.text} />
        )}
      </Space>
    </Modal>
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
      okText={t('common.save')} onOk={() => void doRename()} onCancel={p.onClose} destroyOnHidden>
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
      closable={!busy} mask={{ closable: !busy }} width={MODAL.narrow}
      footer={(
        <Space>
          <Button onClick={p.onClose} disabled={busy}>{t('common.cancel')}</Button>
          <Button type="primary" danger loading={busy} onClick={() => void doRemove()}>{t('dsh.remove.remove')}</Button>
        </Space>
      )}>
      <Space orientation="vertical" size="small" style={{ width: '100%' }}>
        <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>
          {t('dsh.remove.hint')}
        </div>
      </Space>
    </Modal>
  )
}