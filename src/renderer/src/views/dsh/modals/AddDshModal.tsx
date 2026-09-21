/**
 * Register a dsh: pick a detected executable or type a path, and it is probed for
 * its version and home before being added to the registry.
 */
import { useEffect, useState } from 'react'
import { Alert, Button, Checkbox, Input, List, Modal, Space, Tag, message, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../../../lib/ipc.ts'
import FieldLabel from '../../../components/FieldLabel.tsx'
import { MODAL } from '../../../theme.ts'

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

