/**
 * The step rows a profile import / dsh mirror streams while it runs.
 *
 * Both flows subscribe to the same `onImportEvent` channel and differ only in how a
 * bundle row reads, so the subscription and the row list live here once. Each dialog
 * keeps its own open/reset lifecycle — it calls `clear()` — because what else has to
 * be reset differs between them.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { bundleStepRow, upsertRow, type StepRow } from '../../lib/stepRows.ts'
import type { ImportStep } from '../../../../shared/types.ts'

interface Options {
  /** How a bundle step is labelled; the import flow prefixes its resolved source. */
  bundleLabel: (step: Extract<ImportStep, { kind: 'bundle' }>) => string
  /** Track the final install wait step. The mirror flow has no install phase. */
  trackInstall?: boolean
}

export function useImportSteps({ bundleLabel, trackInstall = false }: Options): { rows: StepRow[]; clear: () => void } {
  const { t } = useTranslation()
  const [rows, setRows] = useState<StepRow[]>([])
  // The stream writes through the ref: steps for one bundle arrive in bursts, and
  // state lags by a render, so reading `rows` here would drop all but the last.
  const rowsRef = useRef<StepRow[]>([])
  // Read at step time, so a language switch mid-import labels the steps that follow
  // it without re-subscribing.
  const label = useRef(bundleLabel)
  label.current = bundleLabel

  const upsert = useCallback((row: StepRow): void => {
    const next = upsertRow(rowsRef.current, row)
    rowsRef.current = next
    setRows(next)
  }, [])

  const clear = useCallback((): void => {
    rowsRef.current = []
    setRows([])
  }, [])

  useEffect(() => window.api.onImportEvent((step: ImportStep) => {
    if (step.kind === 'bundle') {
      upsert(bundleStepRow(step, label.current(step)))
    } else if (step.kind === 'install' && trackInstall) {
      upsert({ key: 'install', section: 'install', label: t('profile.import.installStep'), status: step.state })
    }
  }), [upsert, trackInstall, t])

  return { rows, clear }
}
