/** Modal dialogs for the Profile page — pulled out of `ProfileSection` so the
 * page body stays about list + orchestration, not modal markup. */

import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Checkbox, Input, Modal, Select, Space, message, theme } from 'antd'
import { CheckCircleFilled, CloseCircleFilled, LoadingOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../lib/ipc.ts'
import { ErrorDetailModal } from '../components/ErrorDetailModal.tsx'
import { StepIcon } from '../components/StepIcon.tsx'
import { MODAL } from '../theme.ts'
import { majorOfVersion } from '../../../shared/version.ts'
import type { ImportBundleSource, ImportProfileResult, ImportStep } from '../../../shared/types.ts'
import type { RunFailInfo } from './useRunRuntime.tsx'

interface CreateProfileModalProps {
  open: boolean
  name: string
  setName: (v: string) => void
  template: string
  setTemplate: (v: string) => void
  sources: { label: string; options: { value: string; label: string }[] }[]
  onOk: () => void | Promise<void>
  onCancel: () => void
}
export function CreateProfileModal(p: CreateProfileModalProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  return (
    <Modal title={t('profile.create.title')} open={p.open} okText={t('profile.create.create')} onOk={() => void p.onOk()}
      okButtonProps={{ disabled: p.name.trim() === '' }} onCancel={p.onCancel} width={MODAL.narrow}>
      <Space orientation="vertical" style={{ width: '100%' }}>
        <Input value={p.name} onChange={e => p.setName(e.target.value)} placeholder={t('profile.create.namePlaceholder')} onPressEnter={() => void p.onOk()} />
        <div>
          <div style={{ marginBottom: 6, color: token.colorTextSecondary }}>{t('profile.create.basedOn')}</div>
          <Select value={p.template} onChange={p.setTemplate} style={{ width: '100%' }} options={p.sources} />
        </div>
      </Space>
    </Modal>
  )
}

interface CloneProfileModalProps {
  target: string | null
  name: string
  setName: (v: string) => void
  onOk: () => void | Promise<void>
  onCancel: () => void
}
export function CloneProfileModal(p: CloneProfileModalProps): JSX.Element {
  const { t } = useTranslation()
  return (
    <Modal title={t('profile.clone.title', { name: p.target ?? '' })} open={p.target !== null} okText={t('profile.clone.clone')}
      onOk={() => void p.onOk()} onCancel={p.onCancel} destroyOnHidden width={MODAL.narrow}>
      <Input value={p.name} onChange={e => p.setName(e.target.value)} placeholder={t('profile.clone.namePlaceholder')} onPressEnter={() => void p.onOk()} />
    </Modal>
  )
}

interface ExportProfileModalProps {
  text: string | null
  name: string
  onClose: () => void
  onSave: (name: string) => void | Promise<void>
}
export function ExportProfileModal(p: ExportProfileModalProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  return (
    <Modal title={t('profile.export.title')} open={p.text !== null} onCancel={p.onClose} width={MODAL.wide}
      footer={(
        <Space>
          <Button onClick={p.onClose}>{t('common.close')}</Button>
          <Button type="primary" onClick={() => void p.onSave(p.name)} disabled={!p.name}>{t('profile.export.saveAs')}</Button>
        </Space>
      )}>
      <pre style={{ background: token.colorFillTertiary, padding: token.paddingSM, borderRadius: token.borderRadius, maxHeight: 400, overflowY: 'auto' }}>{p.text}</pre>
    </Modal>
  )
}

interface ImportProfileModalProps {
  open: boolean
  json: string
  defaultName: string
  unpackDir: string
  importDshVersion: string
  activeDshVersion: string
  onClose: () => void
  /** Called once the profile has been created; the parent refreshes + selects it. */
  onImported: (name: string) => void
}

/** Owns the import run (via `window.api.importProfile` + the `import:event`
 * stream) and renders one row per step with a status icon — spinner while
 * running, green check on success, red cross on failure. The final status stays
 * visible in the dialog; there is no separate success / missing-token popup. */

interface ImportRow {
  key: string
  section: 'bundle' | 'install'
  label: string
  status: 'running' | 'ok' | 'error'
  /** Right-aligned version detail (resolved store version once installed). */
  meta?: string
  detail?: string
}

export function ImportProfileModal(p: ImportProfileModalProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [name, setName] = useState(p.defaultName)
  const [forceImport, setForceImport] = useState(false)
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<ImportProfileResult | null>(null)
  const [detailView, setDetailView] = useState<string | null>(null)
  const rowsRef = useRef<ImportRow[]>([])
  const [rows, setRows] = useState<ImportRow[]>([])

  const upsert = (row: ImportRow): void => {
    const next = [...rowsRef.current]
    const at = next.findIndex(r => r.key === row.key)
    if (at >= 0) next[at] = row
    else next.push(row)
    rowsRef.current = next
    setRows(next)
  }

  const srcLabel = (s: ImportBundleSource): string =>
    s === 'local' ? t('profile.import.src.local')
      : s === 'reuse' ? t('profile.import.src.reuse')
      : t('profile.import.src.npm')

  // Stream per-step progress straight into the row list. The transient "create"
  // step is omitted (merged into the dialog header); each bundle row carries its
  // origin + resolved version, `install` is the final wait step.
  useEffect(() => window.api.onImportEvent((step: ImportStep) => {
    if (step.kind === 'bundle') {
      upsert({
        key: `bundle:${step.name}`,
        section: 'bundle',
        label: `${srcLabel(step.source)} · ${step.name}`,
        status: step.state,
        meta: step.version !== undefined ? `v${step.version}` : undefined,
        detail: step.detail,
      })
    } else if (step.kind === 'install') {
      upsert({ key: 'install', section: 'install', label: t('profile.import.installStep'), status: step.state })
    }
  }), [t])

  // Reset when reopened over a fresh file selection.
  useEffect(() => {
    if (!p.open) return
    setName(p.defaultName)
    setForceImport(false)
    setRunning(false)
    setDone(false)
    setError('')
    setResult(null)
    rowsRef.current = []
    setRows([])
  }, [p.open, p.defaultName])

  const mismatch = p.importDshVersion !== '' && majorOfVersion(p.importDshVersion) !== majorOfVersion(p.activeDshVersion)

  const doImport = async (): Promise<void> => {
    const target = name.trim()
    if (target === '') { void message.warning(t('profile.import.needName')); return }
    setError('')
    setResult(null)
    rowsRef.current = []
    setRows([])
    setRunning(true)
    setDone(false)
    const res = await window.api.importProfile(p.json, target, forceImport, p.unpackDir)
    setRunning(false)
    if (!res.ok) { setError(apiErrorText(res)); setDone(true); return }
    setResult(res.value)
    setDone(true)
    const r = res.value
    if (r.ok && !r.dshMismatch) p.onImported(target)
  }

  const missing = result?.missing ?? []
  return (
    <>
    <Modal title={t('profile.import.title')} open={p.open} onCancel={running ? undefined : p.onClose}
      closable={!running} mask={{ closable: !running }} width={MODAL.wide}
      footer={running
        ? <Button loading>{t('profile.import.importing')}</Button>
        : done
          ? <Button type="primary" onClick={p.onClose}>{t('profile.import.done')}</Button>
          : (
              <Space>
                <Button onClick={p.onClose}>{t('common.cancel')}</Button>
                <Button type="primary" onClick={() => void doImport()}>{t('profile.import.import')}</Button>
              </Space>
            )}
    >
      <Space orientation="vertical" style={{ width: '100%' }} size="small">
        <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>
          {t('profile.import.hint')}
        </div>

        {!running && !done && mismatch && (
          <Alert type="warning" showIcon
            title={t('profile.import.dshMismatch', { from: p.importDshVersion, cur: p.activeDshVersion || t('common.unknown') })}
            description={t('profile.import.dshMismatchDesc')} />
        )}

        {!running && !done && (
          <>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder={t('profile.import.namePlaceholder')} onPressEnter={() => void doImport()} disabled={running} />
            {mismatch && (
              <Checkbox checked={forceImport} onChange={e => setForceImport(e.target.checked)}>
                {t('profile.import.force')}
              </Checkbox>
            )}
          </>
        )}

        {/* 逐行进度：转圈 / 绿勾 / 红叉，按来源标注并分组；结束后保留在下面。 */}
        {rows.length > 0 && (() => {
          let prevSection: ImportRow['section'] | undefined
          return (
            <div style={{ borderTop: `1px solid ${token.colorSplit}`, paddingTop: token.paddingSM }}>
              {rows.map(row => {
                const isNewSection = row.section !== prevSection
                prevSection = row.section
                return (
                  <div key={row.key}>
                    {isNewSection && (
                      <div style={{ margin: '6px 0 2px', color: token.colorTextSecondary, fontSize: token.fontSizeSM, fontWeight: 600 }}>
                        {row.section === 'bundle' ? t('profile.import.sectionBundles') : t('profile.import.sectionInstall')}
                      </div>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
                      <StepIcon status={row.status} />
                      <span style={{ flex: 1, minWidth: 0 }}>{row.label}</span>
                      {row.meta !== undefined && (
                        <span style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>{row.meta}</span>
                      )}
                      {row.status === 'error' && (
                        <Button type="link" size="small" style={{ padding: 0, color: token.colorError }} onClick={() => setDetailView(row.detail ?? '')}>{t('profile.import.errorLabel')}</Button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )
        })()}

        {done && error !== '' && (
          <Alert type="error" showIcon title={t('profile.import.failed')} description={error} />
        )}

        {done && result !== null && result.ok && !result.dshMismatch && (
          <Alert type="success" showIcon title={result.text} />
        )}

        {done && missing.length > 0 && (
          <Alert type="warning" showIcon
            title={t('profile.import.missingTitle')}
            description={`${missing.join('、')}　${t('profile.import.missingDesc')}`}
          />
        )}
      </Space>
    </Modal>

    <ErrorDetailModal open={detailView !== null} detail={detailView}
      onClose={() => setDetailView(null)} title={t('profile.import.failDetailTitle')} />
    </>
  )
}

interface MirrorProfileModalProps {
  open: boolean
  /** The owning (source) dsh id — excluded from the target picker. */
  sourceDshId: string
  profileName: string
  onClose: () => void
  /** Called once the profile is present in the target dsh; parent refreshes. */
  onMirrored: () => void | Promise<void>
}
/** Copy a profile from the active dsh to another dsh (cross-version migration;
 * source stays intact). Streams the same `import:event` step rows the import
 * dialog renders. */
export function MirrorProfileModal(p: MirrorProfileModalProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [targetId, setTargetId] = useState<string>()
  const [targets, setTargets] = useState<{ id: string; name: string }[]>([])
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<ImportProfileResult | null>(null)
  const rowsRef = useRef<ImportRow[]>([])
  const [rows, setRows] = useState<ImportRow[]>([])

  const upsert = (row: ImportRow): void => {
    const next = [...rowsRef.current]
    const at = next.findIndex(r => r.key === row.key)
    if (at >= 0) next[at] = row
    else next.push(row)
    rowsRef.current = next
    setRows(next)
  }

  useEffect(() => window.api.onImportEvent((step: ImportStep) => {
    if (step.kind === 'bundle') {
      upsert({
        key: `bundle:${step.name}`,
        section: 'bundle',
        label: `${step.name}`,
        status: step.state,
        meta: step.version !== undefined && step.version !== '' ? `v${step.version}` : undefined,
        detail: step.detail,
      })
    }
  }), [])

  useEffect(() => {
    if (!p.open) return
    setTargets([]); setTargetId(undefined); setRunning(false); setDone(false); setError(''); setResult(null)
    rowsRef.current = []; setRows([])
    void (async () => {
      const r = await window.api.dsh.list()
      if (r.ok) {
        setTargets(r.value.dshes.filter(d => d.id !== p.sourceDshId))
      }
    })()
  }, [p.open])

  const doMirror = async (): Promise<void> => {
    if (targetId === undefined) { void message.warning(t('profile.migrate.noTarget')); return }
    setRunning(true); setError('')
    try {
      const r = await window.api.mirrorProfile(p.sourceDshId, targetId, p.profileName)
      if (!r.ok) { setError(apiErrorText(r)); setDone(true); return }
      setResult(r.value)
      setDone(true)
      await p.onMirrored()
    } finally {
      setRunning(false)
    }
  }

  const footer = running
    ? <Button loading>{t('profile.migrate.running')}</Button>
    : done
      ? <Button type="primary" onClick={p.onClose}>{t('common.close')}</Button>
      : (
        <Space>
          <Button onClick={p.onClose}>{t('common.cancel')}</Button>
          <Button type="primary" disabled={targetId === undefined} onClick={() => void doMirror()}>{t('profile.migrate.start')}</Button>
        </Space>
      )

  return (
    <Modal title={t('profile.migrate.title', { name: p.profileName })} open={p.open}
      onCancel={running ? undefined : p.onClose} closable={!running} mask={{ closable: !running }}
      width={MODAL.wide} footer={footer}>
      <Space orientation="vertical" size="small" style={{ width: '100%' }}>
        {!running && !done && (
          <>
            <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>
              {t('profile.migrate.prompt')}
            </div>
            <Select
              style={{ width: '100%' }}
              placeholder={t('profile.migrate.targetPlaceholder')}
              value={targetId}
              onChange={v => setTargetId(v)}
              showSearch optionFilterProp="label"
              options={targets.map(d => ({ value: d.id, label: d.name }))}
            />
          </>
        )}

        {rows.length > 0 && (
          <div style={{ borderTop: `1px solid ${token.colorSplit}`, paddingTop: token.paddingSM }}>
            {rows.map(row => (
              <div key={row.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
                <StepIcon status={row.status} />
                <span style={{ flex: 1, minWidth: 0 }}>{row.label}</span>
                {row.meta !== undefined && (
                  <span style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>{row.meta}</span>
                )}
              </div>
            ))}
          </div>
        )}

        {done && error !== '' && <Alert type="error" showIcon title={error} />}
        {done && result !== null && (
          <Alert type={result.missing.length > 0 ? 'warning' : 'success'} showIcon
            title={t('profile.migrate.done')}
            description={result.missing.length > 0
              ? t('profile.migrate.missing', { missing: result.missing.join('、') })
              : undefined} />
        )}
      </Space>
    </Modal>
  )
}

interface MissingPluginsModalProps {
  list: string[]
  onClose: () => void
}
export function MissingPluginsModal(p: MissingPluginsModalProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  return (
    <Modal title={t('profile.import.missingModalTitle')} open onOk={p.onClose} onCancel={p.onClose} okText={t('profile.import.gotIt')} width={MODAL.narrow}>
      <Alert type="warning" showIcon style={{ marginBottom: 10 }} title={t('profile.import.missingModalHint')} />
      {p.list.map(m => <div key={m} style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', padding: '2px 0' }}>• {m}</div>)}
      <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, marginTop: 8 }}>
        {t('profile.import.missingDesc')}
      </div>
    </Modal>
  )
}

interface RunFailModalProps {
  failInfo: RunFailInfo | null
  logs: string
  eaddrinuse: RegExpExecArray | null
  onClose: () => void
}
export function RunFailModal(p: RunFailModalProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const signalSuffix = p.failInfo?.signal != null ? `, ${p.failInfo.signal}` : ''
  return (
    <Modal title={t('run.failTitle')} open={p.failInfo !== null} okText={t('common.ok')} onOk={p.onClose} onCancel={p.onClose} width={MODAL.wide}>
      <Space orientation="vertical" style={{ width: '100%' }} size="middle">
        <Alert type="error" showIcon title={t('run.exited', { code: p.failInfo?.code ?? '?', signalSuffix })} />
        {p.eaddrinuse !== null && (
          <Alert type="warning" showIcon
            title={t('run.portInUse', { port: p.eaddrinuse[2], addr: p.eaddrinuse[1] })}
            description={t('run.portInUseDesc')} />
        )}
        {p.failInfo?.command !== undefined && (
          <div>
            <div style={{ marginBottom: 6, fontSize: token.fontSizeSM, color: token.colorTextSecondary }}>{t('run.commandLabel')}</div>
            <pre style={{ margin: 0, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: token.fontSizeSM, color: token.colorText, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: token.colorFillTertiary, padding: token.paddingSM, borderRadius: token.borderRadius }}>
              {p.failInfo.command}
            </pre>
          </div>
        )}
        <pre style={{ maxHeight: 360, overflowY: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: token.fontSizeSM, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>
          {p.logs || t('run.noOutput')}
        </pre>
      </Space>
    </Modal>
  )
}