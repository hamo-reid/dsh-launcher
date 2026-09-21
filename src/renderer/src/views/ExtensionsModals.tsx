/**
 * Modals for the extensions surface.
 *
 * Track A is the MCP server form, with a JSON text mode beside it. The form is
 * the friendly default: dsh fails a row that misses `serverName`/`transport`/
 * an endpoint, and the credential field needs an explicit "reference, not
 * literal" default so a secret never lands in `cordis.patch.yml` (which a
 * profile export would carry away). The JSON mode edits the same
 * `McpServerInput` as text (args as a string array, env/headers as
 * {name, mode, value} arrays) for pasting whole configs at once.
 */
import { lazy, Suspense, useEffect, useState } from 'react'
import { Alert, Button, Checkbox, Collapse, Input, InputNumber, Modal, Popconfirm, Radio, Segmented, Select, Space, Tag, theme, Typography } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import FieldLabel from '../components/FieldLabel.tsx'
import ScrollModal from '../components/ScrollModal.tsx'
import { MODAL } from '../theme.ts'
import {
  argsToText, blankMcpInput, fromServer, jsonToMcpInput, mcpInputToJson,
  normalizeInput, type McpJsonProblem,
} from '../lib/mcpInput.ts'
import { SKILL_NAME_RE } from '../../../shared/skill.ts'
import type { McpKV, McpServer, McpServerInput, McpValueMode } from '../../../shared/types.ts'

const CodeEditor = lazy(() => import('../components/CodeEditor.tsx'))

/** Localized label per JSON problem kind — keyed explicitly so a new
 * McpJsonProblem kind fails the typecheck until it gets a label. */
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

export interface McpServerModalProps {
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
export interface McpSecretModalProps {
  open: boolean
  saving: boolean
  onCancel: () => void
  onSave: (name: string, value: string) => void
}

export function McpSecretModal(props: McpSecretModalProps): JSX.Element {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [value, setValue] = useState('')

  useEffect(() => {
    if (props.open) { setName(''); setValue('') }
  }, [props.open])

  const nameValid = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name.trim())
  const canSave = nameValid && value !== ''
  const submit = (): void => {
    if (!canSave) return
    props.onSave(name.trim(), value)
  }

  return (
    <Modal
      open={props.open}
      title={t('ext.secrets.addTitle')}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      confirmLoading={props.saving}
      onOk={submit}
      onCancel={props.onCancel}
      width={480}
      destroyOnHidden
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <div style={{ color: 'inherit', fontSize: 'inherit' }}>
          {t('ext.secrets.addHint')}
        </div>
        <div>
          <FieldLabel>{t('ext.secrets.fieldName')}</FieldLabel>
          <Input
            value={name}
            placeholder="GITHUB_TOKEN"
            status={name !== '' && !nameValid ? 'error' : undefined}
            onChange={e => setName(e.target.value)}
          />
        </div>
        <div>
          <FieldLabel>{t('ext.secrets.fieldValue')}</FieldLabel>
          <Input.Password
            value={value}
            placeholder={t('ext.secrets.fieldValuePlaceholder')}
            onChange={e => setValue(e.target.value)}
          />
        </div>
      </Space>
    </Modal>
  )
}

/** Browse and manage the launcher's launch secrets: the list, add (opens
 * {@link McpSecretModal} on top), and per-name removal. */
export interface SecretsManageModalProps {
  open: boolean
  /** Stored environment-variable names. */
  names: string[]
  /** The name whose removal is in flight. */
  removing?: string
  onRemove: (name: string) => void
  /** Open the add-secret dialog on top of this one. */
  onAdd: () => void
  onClose: () => void
}

export function SecretsManageModal(props: SecretsManageModalProps): JSX.Element {
  const { t } = useTranslation()
  return (
    <Modal
      open={props.open}
      title={t('ext.secrets.manageTitle')}
      footer={null}
      onCancel={props.onClose}
      width={520}
      destroyOnHidden
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Typography.Text type="secondary">{t('ext.secrets.hint')}</Typography.Text>
        {props.names.length === 0 ? (
          <Typography.Text type="secondary">{t('ext.secrets.empty')}</Typography.Text>
        ) : (
          props.names.map(name => (
            <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Typography.Text code>{name}</Typography.Text>
              <span style={{ flex: 1 }} />
              <Popconfirm
                title={t('ext.secrets.removeConfirm', { name })}
                okText={t('common.delete')}
                cancelText={t('common.cancel')}
                onConfirm={() => props.onRemove(name)}
              >
                <Button size="small" danger icon={<DeleteOutlined />} loading={props.removing === name} />
              </Popconfirm>
            </div>
          ))
        )}
        <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={props.onAdd}>
          {t('ext.secrets.add')}
        </Button>
      </Space>
    </Modal>
  )
}

/** Ask for a new skill's name (the slug everything else derives from). */
export interface SkillNameModalProps {
  open: boolean
  onCancel: () => void
  onSubmit: (name: string) => void
}

export function SkillNameModal(props: SkillNameModalProps): JSX.Element {
  const { t } = useTranslation()
  const [name, setName] = useState('')

  useEffect(() => {
    if (props.open) setName('')
  }, [props.open])

  const valid = SKILL_NAME_RE.test(name)
  const submit = (): void => {
    if (valid) props.onSubmit(name)
  }

  return (
    <Modal
      open={props.open}
      title={t('ext.skills.nameTitle')}
      okText={t('common.ok')}
      cancelText={t('common.cancel')}
      okButtonProps={{ disabled: !valid }}
      onOk={submit}
      onCancel={props.onCancel}
      width={420}
      destroyOnHidden
    >
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <FieldLabel>{t('ext.skills.nameField')}</FieldLabel>
        <Input
          autoFocus
          value={name}
          placeholder="my-skill"
          status={name !== '' && !valid ? 'error' : undefined}
          onChange={e => setName(e.target.value)}
          onPressEnter={submit}
        />
        {name !== '' && !valid && (
          <Typography.Text type="danger" style={{ fontSize: 'inherit' }}>{t('ext.skills.nameInvalid')}</Typography.Text>
        )}
      </Space>
    </Modal>
  )
}

/** Full-file editor for one skill. The frontmatter `name` is authoritative:
 * changing it renames the bundle dir on save (validated main-side). */
export interface SkillEditorModalProps {
  open: boolean
  /** The name being edited, or `null` when creating. */
  previousName: string | null
  text: string
  saving: boolean
  onChange: (text: string) => void
  onCancel: () => void
  onSubmit: () => void
}

/** Best-effort frontmatter header for the live summary; the authoritative
 * validation happens main-side on save. */
function liveHeader(text: string): { name?: string; description?: string } {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return {}
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---')
  if (end < 0) return {}
  const pick = (key: string): string | undefined => {
    const line = lines.slice(1, end).find(l => l.startsWith(`${key}:`))
    const value = line?.slice(key.length + 1).trim() ?? ''
    return value === '' ? undefined : value.replace(/^'(.*)'$/, '$1')
  }
  return { name: pick('name'), description: pick('description') }
}

export function SkillEditorModal(props: SkillEditorModalProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const header = liveHeader(props.text)
  const nameValid = header.name === undefined || SKILL_NAME_RE.test(header.name)

  return (
    <Modal
      open={props.open}
      title={props.previousName === null ? t('ext.skills.editorTitleNew') : t('ext.skills.editorTitle', { name: props.previousName })}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      confirmLoading={props.saving}
      onOk={props.onSubmit}
      onCancel={props.onCancel}
      width={760}
      destroyOnHidden
    >
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {header.name !== undefined ? (
            <>
              <Typography.Text code>{header.name}</Typography.Text>
              {!nameValid && <Tag color="error">{t('ext.skills.nameInvalid')}</Tag>}
              {header.description !== undefined && (
                <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }} ellipsis>
                  {header.description}
                </Typography.Text>
              )}
            </>
          ) : (
            <Typography.Text type="warning" style={{ fontSize: token.fontSizeSM }}>
              {t('ext.skills.liveInvalid')}
            </Typography.Text>
          )}
        </div>
        <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
          {t('ext.skills.editorHint')}
        </Typography.Text>
        <Suspense fallback={<div style={{ height: 360 }} />}>
          <CodeEditor value={props.text} language="plaintext" onChange={props.onChange} height={360} />
        </Suspense>
      </Space>
    </Modal>
  )
}
