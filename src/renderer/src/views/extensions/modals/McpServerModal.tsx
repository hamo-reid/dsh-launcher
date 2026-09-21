/**
 * The MCP server form, with a JSON text mode beside it.
 *
 * The form is the friendly default: dsh fails a row that misses `serverName` /
 * `transport` / an endpoint, and the credential field needs an explicit
 * "reference, not literal" default so a secret never lands in `cordis.patch.yml`
 * (which a profile export would carry away). The JSON mode edits the same
 * `McpServerInput` as text (args as a string array, env/headers as
 * {name, mode, value} arrays) for pasting whole configs at once.
 */
import { lazy, Suspense, useEffect, useState } from 'react'
import { Alert, Button, Checkbox, Collapse, Input, InputNumber, Radio, Segmented, Select, Space, Typography, theme } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import FieldLabel from '../../../components/FieldLabel.tsx'
import ScrollModal from '../../../components/ScrollModal.tsx'
import { MODAL } from '../../../theme.ts'
import {
  argsToText, blankMcpInput, fromServer, jsonToMcpInput, mcpInputToJson,
  normalizeInput, type McpJsonProblem,
} from '../../../lib/mcpInput.ts'
import type { McpKV, McpServer, McpServerInput, McpValueMode } from '../../../../../shared/types.ts'

// The Monaco wrapper pulls the whole editor; keep it out of the first parse.
const CodeEditor = lazy(() => import('../../../components/CodeEditor.tsx'))

function jsonProblemLabel(problem: McpJsonProblem, t: TFunction<'translation'>): string {
  switch (problem.kind) {
    case 'parse': return t('ext.mcp.form.jsonErr.parse', { detail: problem.message })
    case 'notObject': return t('ext.mcp.form.jsonErr.notObject')
    case 'unknown': return t('ext.mcp.form.jsonErr.unknown', { detail: problem.keys.join(', ') })
    case 'field': return t('ext.mcp.form.jsonErr.field', { field: problem.field, expected: problem.expected })
  }
}

/** One `env` / `headers` entry editor. */
function KVEditor(props: {
  label: string
  hint?: string
  entries: McpKV[]
  /** Names stored in the launcher's encrypted secret store; an `env`-mode entry
   * matching one is tagged so the user sees the reference will resolve. */
  storedNames?: string[]
  onChange: (next: McpKV[]) => void
}): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const update = (index: number, patch: Partial<McpKV>): void => {
    props.onChange(props.entries.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)))
  }
  return (
    <div>
      <FieldLabel>{props.label}</FieldLabel>
      {props.hint !== undefined && (
        <div style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM, marginBottom: 4 }}>{props.hint}</div>
      )}
      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        {props.entries.map((entry, i) => {
          const stored = entry.mode === 'env' && (props.storedNames ?? []).includes(entry.name)
          return (
            <Space.Compact key={i} style={{ width: '100%' }}>
              <Input
                style={{ width: '32%' }}
                value={entry.name}
                placeholder={t('ext.mcp.form.kvName')}
                onChange={e => update(i, { name: e.target.value })}
              />
              <Select<McpValueMode>
                style={{ width: '24%' }}
                value={entry.mode}
                onChange={mode => update(i, { mode })}
                options={[
                  { value: 'env', label: t('ext.mcp.form.kvModeEnv') },
                  { value: 'plain', label: t('ext.mcp.form.kvModePlain') },
                  { value: 'js', label: t('ext.mcp.form.kvModeJs') },
                ]}
              />
              <Input
                style={{ flex: 1 }}
                value={entry.mode === 'env' ? '' : (entry.value ?? '')}
                disabled={entry.mode === 'env'}
                placeholder={entry.mode === 'env' ? `process.env.${entry.name || 'NAME'}` : t('ext.mcp.form.kvValue')}
                onChange={e => update(i, { value: e.target.value })}
              />
              {stored && (
                <span
                  style={{
                    color: token.colorSuccess, fontSize: token.fontSizeSM,
                    display: 'inline-flex', alignItems: 'center', padding: `0 ${token.paddingXS}px`,
                    background: token.colorSuccessBg, borderRadius: token.borderRadiusSM,
                  }}
                >
                  {t('ext.secrets.stored')}
                </span>
              )}
              <Button
                icon={<DeleteOutlined />}
                onClick={() => props.onChange(props.entries.filter((_, j) => j !== i))}
              />
            </Space.Compact>
          )
        })}
        <Button
          size="small"
          icon={<PlusOutlined />}
          onClick={() => props.onChange([...props.entries, { name: '', mode: 'env' }])}
        >
          {t('ext.mcp.form.kvAdd')}
        </Button>
      </Space>
    </div>
  )
}

interface McpServerModalProps {
  open: boolean
  /** The row being edited, or `null` when adding. */
  editing: McpServer | null
  layer: 'profile' | 'home'
  onLayerChange: (layer: 'profile' | 'home') => void
  /** Show the profile/home picker when adding (hidden for library entries —
   * they carry no layer; the target is chosen when applying). */
  selectLayer?: boolean
  profileName: string
  /** Names stored in the launcher's encrypted secret store. */
  storedNames: string[]
  saving: boolean
  onCancel: () => void
  onSubmit: (input: McpServerInput) => void
}

export default function McpServerModal(props: McpServerModalProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [input, setInput] = useState<McpServerInput>(blankMcpInput)
  const [argsText, setArgsText] = useState('')
  const [mode, setMode] = useState<'form' | 'json'>('form')
  const [jsonText, setJsonText] = useState('')
  const [jsonError, setJsonError] = useState<McpJsonProblem | null>(null)

  // Re-seed whenever the dialog opens, so a cancelled edit never leaks into the
  // next one. The JSON projection is computed lazily on switch, never here.
  useEffect(() => {
    if (!props.open) return
    const seeded = props.editing === null ? blankMcpInput() : fromServer(props.editing)
    setInput(seeded)
    setArgsText(argsToText(seeded.args))
    setMode('form')
    setJsonText('')
    setJsonError(null)
  }, [props.open, props.editing])

  const set = (patch: Partial<McpServerInput>): void => setInput(prev => ({ ...prev, ...patch }))

  const switchMode = (next: 'form' | 'json'): void => {
    if (next === mode) return
    // Form -> JSON is the only place the text is recomputed; the form input
    // stays the source of truth and the JSON pane only ever fills it with
    // successfully parsed values (so the cursor never jumps mid-typing).
    if (next === 'json') {
      setJsonText(mcpInputToJson(input, argsText))
      setJsonError(null)
    }
    setMode(next)
  }

  const onJsonChange = (text: string): void => {
    setJsonText(text)
    const parsed = jsonToMcpInput(text)
    if ('problem' in parsed) {
      setJsonError(parsed.problem)
    } else {
      setJsonError(null)
      setInput(parsed.input)
      setArgsText(parsed.argsText)
    }
  }

  const submit = (): void => {
    // An unparsable JSON pane holds edits the form never saw — block the save.
    if (mode === 'json' && jsonError !== null) return
    props.onSubmit(normalizeInput(input, argsText))
  }

  const isStdio = input.transport === 'stdio'
  const reconnect = input.reconnect ?? {}
  const setReconnect = (patch: Partial<NonNullable<McpServerInput['reconnect']>>): void =>
    set({ reconnect: { ...reconnect, ...patch } })

  return (
    <ScrollModal
      title={props.editing === null ? t('ext.mcp.form.addTitle') : t('ext.mcp.form.editTitle', { name: props.editing.serverName })}
      open={props.open}
      onCancel={props.onCancel}
      onOk={submit}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      okDisabled={mode === 'json' && jsonError !== null}
      confirmLoading={props.saving}
      width={MODAL.wide}
      destroyOnHidden
      // Cap the body and scroll inside the dialog, so long env lists or the
      // expanded advanced section never grow the dialog past the viewport.
      bodyMax="lg"
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {props.editing?.rawConfig !== undefined && (
          <Alert
            type="warning"
            showIcon
            title={t('ext.mcp.form.rawConfigTitle')}
            description={t('ext.mcp.form.rawConfigBody')}
          />
        )}

        {props.editing === null && props.selectLayer !== false && (
          <div>
            <FieldLabel>{t('ext.mcp.form.layer')}</FieldLabel>
            <Radio.Group
              value={props.layer}
              onChange={e => props.onLayerChange(e.target.value as 'profile' | 'home')}
              options={[
                { value: 'profile', label: t('ext.mcp.form.layerProfile', { profile: props.profileName }) },
                { value: 'home', label: t('ext.mcp.form.layerHome') },
              ]}
            />
            <div style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM, marginTop: 4 }}>
              {props.layer === 'home' ? t('ext.mcp.form.layerHomeHint') : t('ext.mcp.form.layerProfileHint')}
            </div>
          </div>
        )}

        <div>
          <FieldLabel>{t('ext.mcp.form.mode')}</FieldLabel>
          <Segmented
            size="small"
            value={mode}
            onChange={value => switchMode(value as 'form' | 'json')}
            options={[
              { value: 'form', label: t('ext.mcp.form.modeForm') },
              { value: 'json', label: t('ext.mcp.form.modeJson') },
            ]}
          />
        </div>
        {mode === 'form' && jsonError !== null && (
          <Alert type="warning" showIcon title={t('ext.mcp.form.jsonStale')} />
        )}

        {mode === 'form' ? (
          <>
        <div>
          <FieldLabel>{t('ext.mcp.form.serverName')}</FieldLabel>
          <Input
            value={input.serverName}
            placeholder="github"
            onChange={e => set({ serverName: e.target.value })}
          />
          <div style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM, marginTop: 4 }}>
            {t('ext.mcp.form.serverNameHint', { example: `mcp__${input.serverName || 'github'}__create_issue` })}
          </div>
        </div>

        <div>
          <FieldLabel>{t('ext.mcp.form.transport')}</FieldLabel>
          <Radio.Group
            value={input.transport}
            onChange={e => set({ transport: e.target.value as McpServerInput['transport'] })}
            options={[
              { value: 'stdio', label: 'stdio' },
              { value: 'streamable-http', label: 'streamable-http' },
            ]}
          />
        </div>

        {isStdio ? (
          <>
            <div>
              <FieldLabel>{t('ext.mcp.form.command')}</FieldLabel>
              <Input value={input.command ?? ''} placeholder="npx" onChange={e => set({ command: e.target.value })} />
            </div>
            <div>
              <FieldLabel>{t('ext.mcp.form.args')}</FieldLabel>
              <Input.TextArea
                rows={3}
                value={argsText}
                placeholder={'-y\n@modelcontextprotocol/server-github'}
                onChange={e => setArgsText(e.target.value)}
              />
              <div style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM, marginTop: 4 }}>
                {t('ext.mcp.form.argsHint')}
              </div>
            </div>
            <div>
              <FieldLabel>{t('ext.mcp.form.cwd')}</FieldLabel>
              <Input value={input.cwd ?? ''} onChange={e => set({ cwd: e.target.value })} />
            </div>
          </>
        ) : (
          <>
            <div>
              <FieldLabel>{t('ext.mcp.form.url')}</FieldLabel>
              <Input value={input.url ?? ''} placeholder="http://localhost:3000/mcp" onChange={e => set({ url: e.target.value })} />
            </div>
            <KVEditor
              label={t('ext.mcp.form.headers')}
              entries={input.headers ?? []}
              storedNames={props.storedNames}
              onChange={next => set({ headers: next })}
            />
          </>
        )}

        <KVEditor
          label={t('ext.mcp.form.env')}
          hint={t('ext.mcp.form.envHint')}
          entries={input.env ?? []}
          storedNames={props.storedNames}
          onChange={next => set({ env: next })}
        />

        <Collapse
          ghost
          items={[{
            key: 'advanced',
            label: t('ext.mcp.form.advanced'),
            children: (
              <Space direction="vertical" size={10} style={{ width: '100%' }}>
                <div>
                  <FieldLabel>{t('ext.mcp.form.timeout')}</FieldLabel>
                  <InputNumber
                    min={0}
                    style={{ width: 200 }}
                    value={input.toolCallTimeoutMs}
                    placeholder="60000"
                    onChange={value => set({ toolCallTimeoutMs: value ?? undefined })}
                  />
                </div>
                <Checkbox
                  checked={input.failOnStartupError === true}
                  onChange={e => set({ failOnStartupError: e.target.checked })}
                >
                  {t('ext.mcp.form.failOnStartup')}
                </Checkbox>
                <div>
                  <Checkbox
                    checked={reconnect.enabled !== false}
                    onChange={e => setReconnect({ enabled: e.target.checked })}
                  >
                    {t('ext.mcp.form.reconnectEnabled')}
                  </Checkbox>
                </div>
                <Space size={8} wrap>
                  <InputNumber
                    min={0}
                    style={{ width: 170 }}
                    addonBefore={t('ext.mcp.form.reconnectInitial')}
                    value={reconnect.initialDelayMs}
                    placeholder="500"
                    onChange={value => setReconnect({ initialDelayMs: value ?? undefined })}
                  />
                  <InputNumber
                    min={0}
                    style={{ width: 170 }}
                    addonBefore={t('ext.mcp.form.reconnectMax')}
                    value={reconnect.maxDelayMs}
                    placeholder="30000"
                    onChange={value => setReconnect({ maxDelayMs: value ?? undefined })}
                  />
                  <InputNumber
                    min={1}
                    style={{ width: 150 }}
                    addonBefore={t('ext.mcp.form.reconnectAttempts')}
                    value={reconnect.maxAttempts}
                    placeholder="10"
                    onChange={value => setReconnect({ maxAttempts: value ?? undefined })}
                  />
                </Space>
              </Space>
            ),
          }]}
        />
          </>
        ) : (
          <>
            {jsonError !== null && (
              <Alert
                type="error"
                showIcon
                title={t('ext.mcp.form.jsonInvalid')}
                description={(
                  <Typography.Text code style={{ fontSize: token.fontSizeSM }}>
                    {jsonProblemLabel(jsonError, t)}
                  </Typography.Text>
                )}
              />
            )}
            <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              {t('ext.mcp.form.jsonHint')}
            </Typography.Text>
            {props.editing?.rawConfig !== undefined && (
              <Typography.Text type="warning" style={{ fontSize: token.fontSizeSM }}>
                {t('ext.mcp.form.jsonRawBody')}
              </Typography.Text>
            )}
            <Suspense fallback={<div style={{ height: 360 }} />}>
              <CodeEditor value={jsonText} language="json" onChange={onJsonChange} height={360} />
            </Suspense>
          </>
        )}
      </Space>
    </ScrollModal>
  )
}

/** Add / update one launch secret (name + value). The value never leaves the
 * main process; the renderer only sends it here and never reads it back. */
