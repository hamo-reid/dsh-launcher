/** Owns the trash view state (`trash:*` IPC) for the Profile page. */

import { useCallback, useEffect, useState } from 'react'
import { message } from 'antd'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../lib/ipc.ts'
import type { TrashItem } from '../../../shared/types.ts'

interface UseTrash {
  items: TrashItem[]
  selected?: string
  setSelected: (name?: string) => void
  load: () => Promise<void>
  /** Restore one item. Returns false (with an error toast) on failure. */
  restore: (name: string) => Promise<boolean>
  /** Permanently delete one item. Returns false on failure. */
  remove: (name: string) => Promise<boolean>
  /** Permanently delete everything. */
  emptyAll: () => Promise<void>
}

export function useTrash(dshId: string | undefined): UseTrash {
  const { t } = useTranslation()
  const [items, setItems] = useState<TrashItem[]>([])
  const [selected, setSelected] = useState<string>()

  const load = useCallback(async (): Promise<void> => {
    if (dshId === undefined) { setItems([]); return }
    const r = await window.api.trash.list(dshId)
    if (r.ok) setItems(r.value)
    else void message.error(apiErrorText(r))
  }, [dshId])

  useEffect(() => { void load() }, [load])

  // Drop a stale selection when the item leaves the list.
  useEffect(() => {
    if (selected !== undefined && !items.some(item => item.name === selected)) setSelected(undefined)
  }, [items, selected])

  const restore = async (name: string): Promise<boolean> => {
    if (dshId === undefined) return false
    const r = await window.api.trash.restore(dshId, name)
    if (!r.ok) { void message.error(apiErrorText(r)); return false }
    setSelected(undefined)
    void message.success(t('trash.restored', { name }))
    await load()
    return true
  }

  const remove = async (name: string): Promise<boolean> => {
    if (dshId === undefined) return false
    const r = await window.api.trash.delete(dshId, name)
    if (!r.ok) { void message.error(apiErrorText(r)); return false }
    setSelected(undefined)
    void message.success(t('trash.deleted', { name }))
    await load()
    return true
  }

  const emptyAll = async (): Promise<void> => {
    if (dshId === undefined) return
    const r = await window.api.trash.empty(dshId)
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    setSelected(undefined)
    if (r.value > 0) void message.success(t('trash.emptied', { count: r.value }))
    await load()
  }

  return { items, selected, setSelected, load, restore, remove, emptyAll }
}