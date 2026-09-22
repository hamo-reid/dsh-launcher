import { useEffect, useState, type CSSProperties } from 'react'
import { Alert, Button, Checkbox, Modal, Space, Tag, message, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../lib/ipc.ts'
import { MODAL } from '../theme.ts'
import type {
  DataRootApplyResult, DataRootItemKey, DataRootMoveStatus, DataRootPlan,
} from '../../../shared/types.ts'

interface Props {
  open: boolean
  target: string
  onClose: () => void
  /** Called once the root is switched, so the page can reload. */
  onApplied: () => void
}

/** Confirm-and-run a data relocation.
 *
 * Deliberately has NO timeout: a plugin store can run to gigabytes and a
 * migration legitimately takes minutes. The existing `store:migrate` caller
 * wraps its call in a 5s race, which for a copy would abandon a half-written
 * tree. Here the dialog simply stays busy until the main process answers. */
export default function DataRootMoveModal({ open, target, onClose, onApplied }: Props): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [plan, setPlan] = useState<DataRootPlan>()
  const [picked, setPicked] = useState<DataRootItemKey[]>([])
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<DataRootApplyResult>()

  useEffect(() => {
    if (!open) return
    setPlan(undefined)
    setResult(undefined)
    setRunning(false)
    void (async () => {
      const res = await window.api.settings.previewDataRoot(target)
      if (!res.ok) { void message.error(apiErrorText(res)); onClose(); return }
      setPlan(res.value)
      // Everything with something in it is preselected; an empty source has
      // nothing to copy, so leaving it out keeps the report honest.
      setPicked(res.value.items.filter(i => !i.absent).map(i => i.key))
    })()
  }, [open, target])

  const label = (key: DataRootItemKey): string => t(`dataRoot.move.item.${key}`)

  const statusText = (status: DataRootMoveStatus): string => t(`dataRoot.move.status.${status}`)

  const run = async (): Promise<void> => {
    setRunning(true)
    const res = await window.api.settings.applyDataRoot(target, { migrate: true, items: picked })
    setRunning(false)
    if (!res.ok) { void message.error(apiErrorText(res)); return }
    setResult(res.value)
    if (res.value.applied) onApplied()
  }

  const pathCell: CSSProperties = {
    flex: 1, minWidth: 0, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: token.fontSizeSM, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  }
  const blocked = (plan?.blockers.length ?? 0) > 0

  return (
    <Modal
      title={t('dataRoot.move.title')}
      open={open}
      onCancel={running ? undefined : onClose}
      closable={!running}
      mask={{ closable: !running }}
      width={MODAL.wide}
      footer={running
        ? <Button loading>{t('dataRoot.move.running')}</Button>
        : result !== undefined
          ? <Button type="primary" onClick={onClose}>{t('common.close')}</Button>
          : (
            <Space>
              <Button onClick={onClose}>{t('common.cancel')}</Button>
              <Button
                type="primary"
                disabled={plan === undefined || blocked || picked.length === 0}
                onClick={() => void run()}
              >
                {t('dataRoot.move.start')}
              </Button>
            </Space>
          )}
    >
      <Space orientation="vertical" size="small" style={{ width: '100%' }}>
        <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>
          {t('dataRoot.move.hint')}
        </div>

        {blocked && <Alert type="warning" showIcon title={t('dataRoot.move.blocked')} />}

        {plan?.items.map((item) => {
          const outcome = result?.moved.find(m => m.key === item.key)
          return (
            <div key={item.key} style={{ display: 'flex', gap: token.paddingSM, alignItems: 'center' }}>
              <Checkbox
                checked={picked.includes(item.key)}
                disabled={item.absent || running || result !== undefined}
                onChange={e => setPicked(prev =>
                  e.target.checked ? [...prev, item.key] : prev.filter(k => k !== item.key))}
              />
              <span style={{ width: 88, flexShrink: 0, fontWeight: 600, fontSize: token.fontSizeSM }}>
                {label(item.key)}
              </span>
              <span style={pathCell} title={item.from}>{item.from}</span>
              <span style={{ color: token.colorTextTertiary }}>→</span>
              <span style={pathCell} title={item.to}>{item.to}</span>
              {outcome !== undefined
                ? <Tag color={outcome.status === 'failed' ? 'red' : 'green'}>{statusText(outcome.status)}</Tag>
                : (
                  <Tag>
                    {item.absent ? t('dataRoot.move.absent') : t('dataRoot.move.count', { count: item.entries })}
                  </Tag>
                )}
            </div>
          )
        })}

        {plan?.items.some(i => i.occupied) === true && (
          <Alert type="info" showIcon title={t('dataRoot.move.occupied')} />
        )}
        {result !== undefined && !result.applied && (
          <Alert type="error" showIcon title={t('dataRoot.move.partial')} />
        )}
        {result?.applied === true && (
          <Alert type="success" showIcon title={t('dataRoot.move.kept')} />
        )}
      </Space>
    </Modal>
  )
}
