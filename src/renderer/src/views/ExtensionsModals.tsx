/**
 * Modals for the extensions surface.
 *
 * Track A is the MCP server form. It is deliberately a typed form rather than a
 * raw YAML box: dsh fails a row that misses `serverName`/`transport`/an endpoint,
 * and the credential field needs an explicit "reference, not literal" default so
 * a secret never lands in `cordis.patch.yml` (which a profile export would carry
 * away).
 */
import { useEffect, useState } from 'react'
import { Alert, Button, Checkbox, Collapse, Input, InputNumber, Modal, Radio, Select, Space, theme } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import FieldLabel from '../components/FieldLabel.tsx'
import { MODAL } from '../theme.ts'
import type { McpKV, McpServer, McpServerInput, McpValueMode } from '../../../shared/types.ts'

/** A blank row for a new server. */
function blankInput(): McpServerInput {
  return { id: '', serverName: '', transport: 'stdio', command: '', args: [], env: [], cwd: '' }
}

/** Seed the form from an existing row (its raw config is not editable here). */
function fromServer(server: McpServer): McpServerInput {
  return {
    id: server.id,
    serverName: server.serverName,
    transport: server.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
    command: server.command ?? '',
    args: server.args ?? [],
    env: server.env ?? [],
    cwd: server.cwd ?? '',
    url: server.url ?? '',
    headers: server.headers ?? [],
    ...(server.toolCallTimeoutMs !== undefined ? { toolCallTimeoutMs: server.toolCallTimeoutMs } : {}),
    ...(server.failOnStartupError !== undefined ? { failOnStartupError: server.failOnStartupError } : {}),
    ...(server.reconnect !== undefined ? { reconnect: server.reconnect } : {}),
  }
}

/** One `env` / `headers` entry editor. */
function KVEditor(props: {
  label: string
  hint?: string
  entries: McpKV[]
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
        {props.entries.map((entry, i) => (
          <Space.Compact key={i} style={{ width: '100%' }}>
            <Input
              style={{ width: '32%' }}
              value={entry.name}
              placeholder={t('ext.mcp.form.kvName')}
              onChange={e => update(i, { name: e.target.value })}
            />
            <Select<McpValueMode>
              style={{ width: '28%' }}
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
            <Button
              icon={<DeleteOutlined />}
              onClick={() => props.onChange(props.entries.filter((_, j) => j !== i))}
            />
          </Space.Compact>
        ))}
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
  profileName: string
  saving: boolean
  onCancel: () => void
  onSubmit: (input: McpServerInput) => void
}

export default function McpServerModal(props: McpServerModalProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [input, setInput] = useState<McpServerInput>(blankInput)
  const [argsText, setArgsText] = useState('')

  // Re-seed whenever the dialog opens, so a cancelled edit never leaks into the
  // next one.
  useEffect(() => {
    if (!props.open) return
    const seeded = props.editing === null ? blankInput() : fromServer(props.editing)
    setInput(seeded)
    setArgsText((seeded.args ?? []).join('\n'))
  }, [props.open, props.editing])

  const set = (patch: Partial<McpServerInput>): void => setInput(prev => ({ ...prev, ...patch }))

  const submit = (): void => {
    const args = argsText.split('\n').map(line => line.trim()).filter(line => line !== '')
    props.onSubmit({ ...input, args, env: input.env?.filter(e => e.name !== '') })
  }

  const isStdio = input.transport === 'stdio'
  const reconnect = input.reconnect ?? {}
  const setReconnect = (patch: Partial<NonNullable<McpServerInput['reconnect']>>): void =>
    set({ reconnect: { ...reconnect, ...patch } })

  return (
    <Modal
      open={props.open}
      title={props.editing === null ? t('ext.mcp.form.addTitle') : t('ext.mcp.form.editTitle', { name: props.editing.serverName })}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      confirmLoading={props.saving}
      onOk={submit}
      onCancel={props.onCancel}
      width={MODAL.wide}
      destroyOnHidden
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

        {props.editing === null && (
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
              onChange={next => set({ headers: next })}
            />
          </>
        )}

        <KVEditor
          label={t('ext.mcp.form.env')}
          hint={t('ext.mcp.form.envHint')}
          entries={input.env ?? []}
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
      </Space>
    </Modal>
  )
}
