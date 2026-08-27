/** Detail panel for one soft-deleted profile in the trash: its bundles, deps,
 * patch rows, deletion info, and the restore / permanent-delete actions.
 * The list rail (and the empty-trash action) live in `ProfileSection`. */

import { Button, Space, theme } from 'antd'
import { RollbackOutlined, DeleteOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import SectionHeading from '../components/SectionHeading.tsx'
import FieldLabel from '../components/FieldLabel.tsx'
import type { TrashItem } from '../../../shared/types.ts'

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

interface TrashPanelProps {
  item: TrashItem
  onRestore: (name: string) => void
  onRemove: (name: string) => void
}

export default function TrashPanel({ item, onRestore, onRemove }: TrashPanelProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const date = item.deletedAt !== '' ? new Date(item.deletedAt).toLocaleString() : t('common.unknown')
  return (
    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
      <SectionHeading title={item.name} description={t('trash.deletedAtAtSize', { date, size: fmtBytes(item.sizeBytes) })} />

      <div>
        <FieldLabel>{t('trash.bundleLayers')}</FieldLabel>
        {item.bundles.length === 0
          ? <div style={{ color: token.colorTextTertiary }}>{t('common.none')}</div>
          : item.bundles.map((b, i) => (
              <div key={b} style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', padding: '2px 0' }}>
                {i + 1}. {b}
              </div>
            ))}
      </div>

      <div>
        <FieldLabel>{t('trash.dependencies', { count: item.deps.length })}</FieldLabel>
        {item.deps.length === 0
          ? <div style={{ color: token.colorTextTertiary }}>{t('common.none')}</div>
          : <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>{item.deps.join('、')}</div>}
      </div>

      <div>
        <FieldLabel>{t('trash.patchRows')}</FieldLabel>
        {item.patchRows === 0 ? <span style={{ color: token.colorTextTertiary }}>{t('common.empty')}</span> : item.patchRows}
      </div>

      <Space style={{ paddingTop: token.padding }}>
        <Button type="primary" icon={<RollbackOutlined />} onClick={() => onRestore(item.name)}>{t('trash.restore')}</Button>
        <Button danger icon={<DeleteOutlined />} onClick={() => onRemove(item.name)}>{t('trash.permanentlyDelete')}</Button>
      </Space>
    </Space>
  )
}