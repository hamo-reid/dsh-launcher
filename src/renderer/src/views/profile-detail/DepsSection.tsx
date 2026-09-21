/**
 * The manifest's dependency list: inline edit, remove, and the add form.
 *
 * The drafts are section-local — a half-typed spec is nobody else's business — and
 * the writes stay with the workspace, because only it can reload the composed stack
 * afterwards. So the two callbacks report success, and the section clears the draft
 * it sent on `true` rather than guessing.
 */
import { useState } from 'react'
import { Button, Input, theme } from 'antd'
import { useTranslation } from 'react-i18next'

interface Props {
  /** Dependency package names, in manifest order. */
  dependencies: string[]
  /** The installed spec per package. */
  specs: Record<string, string>
  /** A write is in flight (shared with the bundle actions' busy flag). */
  busy: boolean
  /** The add row is revealed by the section header's toggle. */
  addOpen: boolean
  onSave: (pkg: string, spec: string) => Promise<boolean>
  onRemove: (pkg: string) => void
  onAdd: (pkg: string, spec: string) => Promise<boolean>
}

export default function DepsSection({ dependencies, specs, busy, addOpen, onSave, onRemove, onAdd }: Props): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState<string | null>(null)
  const [newPkg, setNewPkg] = useState('')
  const [newSpec, setNewSpec] = useState('')

  const clearDraft = (pkg: string): void => {
    setEdits(prev => { const next = { ...prev }; delete next[pkg]; return next })
  }

  const submitEdit = async (pkg: string): Promise<void> => {
    if (await onSave(pkg, (edits[pkg] ?? specs[pkg] ?? '').trim())) {
      clearDraft(pkg)
      setEditing(null)
    }
  }

  const submitAdd = async (): Promise<void> => {
    if (await onAdd(newPkg.trim(), newSpec.trim())) {
      setNewPkg('')
      setNewSpec('')
    }
  }

  const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: token.fontSizeSM }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: token.paddingSM }}>
      <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>{t('profile.workspace.depsHint')}</div>
      {dependencies.length === 0 && <div style={{ color: token.colorTextTertiary }}>{t('common.none')}</div>}
      {dependencies.map(dep => (
        <div key={dep} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ flex: '0 0 34%', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...mono }}>{dep}</span>
          {editing === dep
            ? (
              <>
                <Input size="small" value={edits[dep] ?? specs[dep] ?? ''} onChange={e => setEdits(prev => ({ ...prev, [dep]: e.target.value }))} style={{ flex: 1 }} onPressEnter={() => void submitEdit(dep)} />
                <Button size="small" type="primary" disabled={busy} onClick={() => void submitEdit(dep)}>{t('common.save')}</Button>
                <Button size="small" onClick={() => { setEditing(null); clearDraft(dep) }}>{t('common.cancel')}</Button>
              </>
            )
            : (
              <>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: token.colorTextSecondary, ...mono }}>{specs[dep] ?? ''}</span>
                <Button size="small" onClick={() => { setEdits(prev => ({ ...prev, [dep]: specs[dep] ?? '' })); setEditing(dep) }}>{t('profile.workspace.depEdit')}</Button>
                <Button size="small" danger type="text" disabled={busy} onClick={() => onRemove(dep)}>{t('profile.detail.remove')}</Button>
              </>
            )}
        </div>
      ))}
      {addOpen && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: token.paddingSM }}>
          <Input size="small" value={newPkg} onChange={e => setNewPkg(e.target.value)} placeholder={t('profile.workspace.depPkg')} style={{ flex: '0 0 34%' }} />
          <Input size="small" value={newSpec} onChange={e => setNewSpec(e.target.value)} placeholder={t('profile.workspace.depSpec')} style={{ flex: 1 }} onPressEnter={() => void submitAdd()} />
          <Button size="small" type="primary" loading={busy} onClick={() => void submitAdd()}>{t('profile.workspace.depAdd')}</Button>
        </div>
      )}
    </div>
  )
}
