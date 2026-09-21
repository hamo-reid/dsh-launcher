/**
 * The profile's bundle layers: drag to reorder, remove, re-version, relink — plus
 * the picker that activates an installed-but-inactive bundle.
 *
 * The activation pick lives here (it is only ever read by this form) while the
 * writes stay with the workspace, which reloads the composed stack after each.
 */
import { useState } from 'react'
import { Button, Select, Tag, Tooltip, theme } from 'antd'
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useTranslation } from 'react-i18next'
import type { ProfileBundleInfo } from '../../../../shared/types.ts'

/** Tag colour per bundle version source (matches the plugin overview's palette). */
const BUNDLE_SOURCE_COLORS: Record<ProfileBundleInfo['source'], string> = {
  dsh: 'purple',
  store: 'blue',
  npm: 'geekblue',
  local: 'default',
}

interface Props {
  /** Bundle layer names, in application order. */
  bundles: string[]
  /** Version/source per bundle, when the workspace has resolved them. */
  bundleInfo: Record<string, ProfileBundleInfo> | undefined
  /** Installed bundles not yet activated as a layer. */
  candidates: string[]
  /** The activation picker is revealed by the section header's toggle. */
  activateOpen: boolean
  /** A write is in flight (shared with the dependency actions' busy flag). */
  busy: boolean
  onReorder: (event: DragEndEvent) => void
  onRemove: (bundle: string) => void
  onReplace: (bundle: string) => void
  onRelink: (bundle: string) => void
  /** Activate a candidate; `true` means it landed, so the pick clears. */
  onActivate: (pkg: string) => Promise<boolean>
}

export default function BundlesSection({
  bundles, bundleInfo, candidates, activateOpen, busy, onReorder, onRemove, onReplace, onRelink, onActivate,
}: Props): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [pick, setPick] = useState<string>()

  const activate = async (): Promise<void> => {
    if (pick === undefined) return
    if (await onActivate(pick)) setPick(undefined)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: token.paddingSM }}>
      {bundles.length === 0
        ? <div style={{ color: token.colorTextTertiary }}>{t('common.none')}</div>
        : (
          <DndContext collisionDetection={closestCenter} autoScroll={false} onDragEnd={onReorder}>
            <SortableContext items={bundles} strategy={verticalListSortingStrategy}>
              {bundles.map(bundle => (
                <SortableBundle
                  key={bundle}
                  bundle={bundle}
                  info={bundleInfo?.[bundle]}
                  onRemove={onRemove}
                  onReplace={onReplace}
                  onRelink={onRelink}
                />
              ))}
            </SortableContext>
          </DndContext>
        )}
      {candidates.length > 0 && activateOpen && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: token.paddingSM }}>
          <Select
            size="small"
            value={pick}
            onChange={setPick}
            placeholder={t('profile.workspace.bundleActivatePlaceholder')}
            style={{ flex: 1 }}
            options={candidates.map(pkg => ({ value: pkg, label: pkg }))}
          />
          <Button size="small" type="primary" disabled={pick === undefined} loading={busy} onClick={() => void activate()}>{t('profile.workspace.bundleActivate')}</Button>
        </div>
      )}
    </div>
  )
}

/** One sortable bundle row (dnd-kit) — drag via the handle on the left; the version
 * controls on the right stay click-only. Only a store/npm-backed layer can be
 * re-versioned; an in-box (`dsh`) or local layer is read-only, with the reason in a
 * tooltip. */
function SortableBundle({ bundle, info, onRemove, onReplace, onRelink }: {
  bundle: string
  info?: ProfileBundleInfo
  onRemove: (b: string) => void
  onReplace: (b: string) => void
  onRelink: (b: string) => void
}): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: bundle })
  const source = info?.source ?? 'dsh'
  const replaceable = source === 'store' || source === 'npm'
  const readonlyHint = source === 'dsh' ? t('profile.bundle.followInstall') : t('profile.bundle.localPath')
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: transform !== null ? CSS.Transform.toString(transform) : undefined,
        transition,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        background: token.colorBgContainer,
        borderBottom: `1px solid ${token.colorSplit}`,
        opacity: isDragging ? 0.4 : 1,
        zIndex: isDragging ? 1 : undefined,
      }}
    >
      <span
        {...attributes}
        {...listeners}
        style={{ cursor: 'grab', flexShrink: 0, touchAction: 'none', color: token.colorTextTertiary }}
      >
        ⠿
      </span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {bundle}
      </span>
      {info?.version !== undefined && info.version !== '' && (
        <Tag style={{ flexShrink: 0, marginInlineEnd: 0, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>@{info.version}</Tag>
      )}
      <Tooltip title={replaceable ? undefined : readonlyHint}>
        <Tag color={BUNDLE_SOURCE_COLORS[source]} style={{ flexShrink: 0, marginInlineEnd: 0 }}>
          {t(`profile.bundle.source.${source}`)}
        </Tag>
      </Tooltip>
      <Tooltip title={replaceable ? undefined : readonlyHint}>
        <span>
          <Button size="small" disabled={!replaceable} onClick={() => onReplace(bundle)}>{t('profile.bundle.replace')}</Button>
        </span>
      </Tooltip>
      {source === 'local' && (
        <Button size="small" onClick={() => onRelink(bundle)}>{t('profile.bundle.relink')}</Button>
      )}
      <Button size="small" danger onClick={() => onRemove(bundle)}>{t('profile.detail.removeBundle')}</Button>
    </div>
  )
}
