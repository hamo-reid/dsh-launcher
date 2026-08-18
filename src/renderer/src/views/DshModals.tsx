/** Modal dialogs for the DSH page — each owns its own state, so `DshSection`
 * is left with just list + activation orchestration. */

import { useEffect, useState } from 'react'
import { Alert, Button, Checkbox, Input, List, Modal, Select, Space, Spin, Tag, message, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../lib/ipc.ts'
import FieldLabel from '../components/FieldLabel.tsx'
import { MODAL } from '../theme.ts'
import type { PackageVersionInfo } from '../../../shared/types.ts'

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

interface OfficialInstallModalProps {
  open: boolean
  onClose: () => void
  onDone: () => void | Promise<void>
}
export function OfficialInstallModal(p: OfficialInstallModalProps): JSX.Element {
  const { t } = useTranslation()
  const [installing, setInstalling] = useState(false)
  const [officialDone, setOfficialDone] = useState(false)
  const [versionDir, setVersionDir] = useState('')
  const [installName, setInstallName] = useState('official')
  // npm 版本选择（官方包 @deepseek-ai/dsh）。
  const [pkgInfo, setPkgInfo] = useState<PackageVersionInfo | null>(null)
  const [version, setVersion] = useState('')
  const [versionsLoading, setVersionsLoading] = useState(false)

  useEffect(() => {
    if (!p.open) return
    // 重新打开时重置状态，避免残留「已安装」。
    setInstalling(false)
    setOfficialDone(false)
    setPkgInfo(null)
    setVersion('')
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
    setInstalling(true)
    setOfficialDone(false)
    const r = await window.api.dsh.installOfficial({
      versionDir: versionDir.trim(),
      name: installName.trim(),
      version: version.trim() || undefined,
    })
    setInstalling(false)
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    setOfficialDone(true)
    void message.success(t('dsh.official.installedNow'))
    await p.onDone()
  }

  return (
    <Modal title={t('dsh.official.title')} open={p.open}
      okText={officialDone ? t('dsh.official.done') : t('dsh.official.start')}
      okButtonProps={{ loading: installing }}
      onOk={() => { if (officialDone) p.onClose(); else void doInstallOfficial() }}
      onCancel={p.onClose} width={MODAL.narrow}>
      <Space direction="vertical" size="small" style={{ width: '100%' }}>
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
                onChange={setVersion}
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
        {officialDone && <Alert type="success" showIcon message={t('dsh.official.installed')} />}
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
  const [deleteFiles, setDeleteFiles] = useState(false)
  const [busy, setBusy] = useState(false)

  const removeNow = async (df: boolean): Promise<void> => {
    if (p.dsh === null) return
    setBusy(true)
    try {
      const r = await window.api.dsh.remove(p.dsh.id, df ? { deleteFiles: true } : undefined)
      if (!r.ok) { void message.error(apiErrorText(r)); return }
      void message.success(t('dsh.removed'))
      p.onClose()
      await p.onRemoved()
    } finally {
      setBusy(false)
    }
  }

  const doRemove = (): void => {
    // 勾选删除文件时：先弹一次强确认，否则直接仅脱管。
    if (deleteFiles) {
      Modal.confirm({
        title: t('dsh.remove.confirmDeleteTitle'),
        content: t('dsh.remove.confirmDelete', { name: p.dsh?.name ?? '' }),
        okText: t('common.confirm'),
        okButtonProps: { danger: true },
        onOk: () => void removeNow(true),
      })
    } else {
      void removeNow(false)
    }
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
        <Checkbox checked={deleteFiles} onChange={e => setDeleteFiles(e.target.checked)}>
          {t('dsh.remove.deleteFiles')}
        </Checkbox>
      </Space>
    </Modal>
  )
}