/** Parameter dialog for one launch target. The dsh + profile are fixed by the
 * tile whose "…" opened this dialog, so it only edits the mode and the launch
 * parameters. Built on ScrollModal so a long advanced section scrolls inside
 * the dialog. */

import { useEffect, useState } from 'react'
import { Button, Collapse, Input, InputNumber, Segmented, Space, Tag, message, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../lib/ipc.ts'
import FieldLabel from '../components/FieldLabel.tsx'
import ScrollModal from '../components/ScrollModal.tsx'
import { MODAL } from '../theme.ts'
import type { LaunchOptions, RunMode } from '../../../shared/types.ts'

interface RunLaunchModalProps {
  open: boolean
  /** Fixed target: the dsh install and profile this dialog configures. */
  dshId: string
  dshName: string
  profile: string
  onClose: () => void
  /** Returns true when the run started (so the dialog can close). */
  onLaunch: (mode: RunMode, options: LaunchOptions) => Promise<boolean>
}

/** Parse a KEY=VALUE-per-line textarea into an env map. Blank lines and `#`
 * comments are skipped; a line without `=` is ignored. */
function parseEnvText(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    env[line.slice(0, eq).trim()] = line.slice(eq + 1)
  }
  return env
}

export default function RunLaunchModal(p: RunLaunchModalProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [mode, setMode] = useState<RunMode>('app')
  const [argsText, setArgsText] = useState('')
  const [patches, setPatches] = useState<string[]>([])
  const [envText, setEnvText] = useState('')
  const [port, setPort] = useState<number | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  // Load the target's saved mode + launch parameters whenever the dialog opens.
  useEffect(() => {
    if (!p.open || p.dshId === '' || p.profile === '') return
    let alive = true
    void window.api.run.getDefaults(p.dshId, p.profile).then(result => {
      if (!alive || !result.ok) return
      setMode(result.value.mode)
      setArgsText((result.value.options.args ?? []).join(' '))
      setPatches(result.value.options.patches ?? [])
      setEnvText(Object.entries(result.value.options.env ?? {}).map(([key, value]) => `${key}=${value}`).join('\n'))
      setPort(result.value.options.port)
    })
    return () => { alive = false }
  }, [p.open, p.dshId, p.profile])

  const buildOptions = (): LaunchOptions => ({
    args: argsText.split(/\s+/).filter(Boolean),
    patches,
    env: parseEnvText(envText),
    ...(port !== undefined && { port }),
  })

  const canLaunch = p.dshId !== '' && p.profile !== ''

  const submit = async (): Promise<void> => {
    if (!canLaunch) return
    setBusy(true)
    const ok = await p.onLaunch(mode, buildOptions())
    setBusy(false)
    if (ok) p.onClose()
  }

  const saveDefaults = async (): Promise<void> => {
    if (!canLaunch) return
    const result = await window.api.run.setDefaults(p.dshId, p.profile, { mode, options: buildOptions() })
    if (!result.ok) { void message.error(apiErrorText(result)); return }
    void message.success(t('run.params.saved'))
  }

  const addPatch = async (): Promise<void> => {
    const result = await window.api.run.pickPatch()
    if (!result.ok) { void message.error(apiErrorText(result)); return }
    if (result.value === '') return
    setPatches(prev => prev.includes(result.value) ? prev : [...prev, result.value])
  }

  return (
    <ScrollModal
      title={t('run.launchTitle')}
      open={p.open}
      onCancel={p.onClose}
      onOk={() => void submit()}
      okText={t('run.start')}
      okDisabled={!canLaunch}
      confirmLoading={busy}
      width={MODAL.narrow}
      destroyOnHidden
      // Cap the body and scroll INSIDE the dialog, so expanding the advanced
      // parameters never grows the dialog past the viewport (or scrolls the mask).
      bodyMax="md"
    >
      <Space orientation="vertical" size="middle" style={{ width: '100%', marginTop: token.paddingSM }}>
        {/* Fixed launch target (the tile this dialog was opened from). */}
        <div style={{
          padding: '10px 12px',
          borderRadius: token.borderRadius,
          background: token.colorFillQuaternary,
        }}>
          <div style={{ fontWeight: 600, color: token.colorText }}>{p.profile}</div>
          <div style={{ fontSize: token.fontSizeSM, color: token.colorTextSecondary, marginTop: 2 }}>
            {p.dshName === '' ? t('run.selectDsh') : p.dshName}
          </div>
        </div>

        <div>
          <FieldLabel>{t('run.mode')}</FieldLabel>
          <Segmented
            block
            value={mode}
            onChange={value => setMode(value as RunMode)}
            options={[
              { value: 'app', label: t('run.modeApp') },
              { value: 'shell', label: t('run.modeShell') },
            ]}
          />
        </div>

        <Collapse
          ghost
          items={[{
            key: 'advanced',
            label: t('run.params.title'),
            children: (
              <Space orientation="vertical" size="small" style={{ width: '100%' }}>
                <div>
                  <FieldLabel>{t('run.params.args')}</FieldLabel>
                  <Input.TextArea
                    value={argsText}
                    onChange={e => setArgsText(e.target.value)}
                    autoSize={{ minRows: 1, maxRows: 3 }}
                    placeholder="--resume abc"
                  />
                </div>
                <div>
                  <FieldLabel>{t('run.params.patches')}</FieldLabel>
                  {patches.length > 0 && (
                    <Space wrap size={4} style={{ marginBottom: 6 }}>
                      {patches.map(x => (
                        <Tag key={x} closable onClose={() => setPatches(prev => prev.filter(y => y !== x))}>{x}</Tag>
                      ))}
                    </Space>
                  )}
                  <Button size="small" block onClick={() => void addPatch()}>{t('run.params.addPatch')}</Button>
                </div>
                <div>
                  <FieldLabel>{t('run.params.port')}</FieldLabel>
                  <InputNumber
                    value={port ?? null}
                    min={0}
                    max={65535}
                    style={{ width: '100%' }}
                    placeholder={t('run.params.portPlaceholder')}
                    onChange={value => setPort(value === null ? undefined : Number(value))}
                  />
                  <div style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM, marginTop: 4 }}>
                    {t('run.params.portHint')}
                  </div>
                </div>
                <div>
                  <FieldLabel>{t('run.params.env')}</FieldLabel>
                  <Input.TextArea
                    value={envText}
                    onChange={e => setEnvText(e.target.value)}
                    autoSize={{ minRows: 2, maxRows: 5 }}
                    placeholder="KEY=VALUE"
                  />
                </div>
                <Button size="small" block onClick={() => void saveDefaults()}>{t('run.params.save')}</Button>
              </Space>
            ),
          }]}
        />
      </Space>
    </ScrollModal>
  )
}
