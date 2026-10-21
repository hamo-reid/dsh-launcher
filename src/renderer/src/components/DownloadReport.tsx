/**
 * The download detail view: a real report, not the row repeated in a modal.
 *
 * A failed plugin download has two audiences. The person reading the row needs
 * one sentence ("找不到这个包") and the button that opens this view. The person who
 * opens it is past that — they want the cause, the evidence it was read from,
 * the exact command to reproduce it in a shell, and the whole log rather than
 * the four lines that survived truncation.
 *
 * The split is deliberate: `failure` is what the launcher CONCLUDED (classified
 * in the main process from pnpm's output), `log` is what pnpm SAID, verbatim.
 * Both are shown, in that order, because a conclusion without its evidence is a
 * guess the reader cannot check.
 */
import { useMemo } from 'react'
import { Alert, Button, Modal, Space, Tag, Typography, theme } from 'antd'
import { CheckCircleFilled, CloseCircleFilled, LoadingOutlined, MinusCircleFilled } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useDownloads } from '../hooks/useDownloads.ts'
import { StepIcon } from './StepIcon.tsx'
import { MODAL } from '../theme.ts'
import { fmtDuration } from '../lib/format.ts'
import type { DownloadSessionInfo } from '../../../shared/types.ts'

/** Status → its i18n key, so the union stays checkable at the call site. */
const STATUS_LABEL = {
  running: 'download.status.running',
  done: 'download.status.done',
  failed: 'download.status.failed',
  cancelled: 'download.status.cancelled',
} as const satisfies Record<DownloadSessionInfo['status'], string>

const STATUS_COLOR: Record<DownloadSessionInfo['status'], string> = {
  running: 'processing',
  done: 'success',
  failed: 'error',
  cancelled: 'default',
}

/** The steps a dsh install reports, in the order they happen. */
const STEP_LABEL: Record<string, string> = {
  version: 'dsh.official.step.version',
  install: 'dsh.official.step.install',
  register: 'dsh.official.step.register',
}

/**
 * The advice catalog: advice key → i18n key. Keyed explicitly rather than built
 * by interpolation so a new advice key without its copy fails the typecheck
 * instead of rendering a raw key at a user.
 */
const ADVICE_OF: Record<string, string> = {
  checkName: 'download.advice.checkName',
  checkSpelling: 'download.advice.checkSpelling',
  checkScope: 'download.advice.checkScope',
  login: 'download.advice.login',
  checkSsh: 'download.advice.checkSsh',
  configureGit: 'download.advice.configureGit',
  checkToken: 'download.advice.checkToken',
  checkProxy: 'download.advice.checkProxy',
  checkNetwork: 'download.advice.checkNetwork',
  retryLater: 'download.advice.retryLater',
  checkPackageJson: 'download.advice.checkPackageJson',
  checkPrivate: 'download.advice.checkPrivate',
  checkPath: 'download.advice.checkPath',
  checkRepo: 'download.advice.checkRepo',
  useExactVersion: 'download.advice.useExactVersion',
  checkNodeVersion: 'download.advice.checkNodeVersion',
  freeSpace: 'download.advice.freeSpace',
  checkPermission: 'download.advice.checkPermission',
  closeFiles: 'download.advice.closeFiles',
  checkScript: 'download.advice.checkScript',
  installBuildTools: 'download.advice.installBuildTools',
}

/** Resolve one advice key to its i18n key, or undefined when unknown (a report
 * written by a newer main process must not break the view). */
export function adviceKeyOf(key: string): string | undefined {
  return ADVICE_OF[key]
}

/**
 * Localize a headline that came from the main process.
 *
 * `failure.headlineKey` is a string produced by the classifier, so it cannot be
 * checked against the resource type at compile time — this is the one place the
 * launcher's own vocabulary crosses that boundary, and it is annotated here
 * instead of sprinkling casts at every use. An unknown key renders as the key
 * rather than throwing, so a report from a newer main process degrades to
 * legible instead of blank.
 */
type Translate = (key: string, options?: Record<string, string>) => string

function headlineOf(t: Translate, failure: DownloadSessionInfo['failure']): string | undefined {
  if (failure === undefined) return undefined
  return t(failure.headlineKey, failure.params ?? {})
}

/** Localize a key looked up through a table (advice, step): the lookup value is
 * a plain string by construction, so it crosses the same boundary as a headline. */
function labelOf(t: Translate, key: string | undefined): string | undefined {
  return key === undefined ? undefined : t(key)
}

/** One labelled block, so every section of the report reads the same way. */
function Section({ label, children, extra }: {
  label: string
  children: React.ReactNode
  extra?: React.ReactNode
}): JSX.Element {
  const { token } = theme.useToken()
  return (
    <div style={{ marginTop: token.paddingSM }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <Typography.Text style={{ color: token.colorTextSecondary }}>{label}</Typography.Text>
        {extra}
      </div>
      {children}
    </div>
  )
}

/** A monospace block with its own scroll, for a command or a log. */
function Mono({ text, maxHeight }: { text: string; maxHeight: number }): JSX.Element {
  const { token } = theme.useToken()
  return (
    <pre
      style={{
        margin: 0,
        maxHeight,
        overflow: 'auto',
        background: token.colorFillTertiary,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: token.borderRadius,
        padding: token.paddingSM,
        fontSize: token.fontSizeSM,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: token.colorText,
      }}
    >
      {text}
    </pre>
  )
}

/**
 * The report body. Split out from the modal so it can be rendered (and tested)
 * for a given session without mounting antd's portal.
 */
export function DownloadDetailBody({ session }: { session: DownloadSessionInfo }): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const tr = t as unknown as Translate
  const steps = session.steps ?? []
  const failure = session.failure
  const headline = headlineOf(tr, failure)

  return (
    <Space orientation="vertical" size={0} style={{ width: '100%' }}>
      {/* ── what happened ─────────────────────────────────────────────────── */}
      <Space size={8} wrap>
        <Tag color={STATUS_COLOR[session.status]} style={{ marginInlineEnd: 0 }}>
          {t(STATUS_LABEL[session.status])}
        </Tag>
        {failure?.code !== undefined && (
          <Typography.Text code style={{ fontSize: token.fontSizeSM }}>{failure.code}</Typography.Text>
        )}
        {session.durMs !== undefined && (
          <Typography.Text style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>
            {t('download.detail.took', { dur: fmtDuration(session.durMs) })}
          </Typography.Text>
        )}
        {session.startedAt !== undefined && (
          <Typography.Text style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>
            {t('download.detail.at', { time: session.startedAt.slice(11, 19) })}
          </Typography.Text>
        )}
      </Space>

      {/* A failed or cancelled attempt leads with its cause: that is the answer the
          reader opened this view for. A running/finished one leads with its source. */}
      {headline !== undefined && (
        <div style={{ marginTop: token.paddingSM }}>
          <Alert
            type={session.status === 'cancelled' ? 'warning' : 'error'}
            showIcon
            title={headline}
            description={failure !== undefined && failure.advice.length > 0 ? (
              <ol style={{ margin: '6px 0 0', paddingInlineStart: 18 }}>
                {failure.advice.map((key, index) => (
                  <li key={`${key}-${String(index)}`} style={{ fontSize: token.fontSizeSM, marginTop: 2 }}>
                    {labelOf(tr, ADVICE_OF[key]) ?? key}
                  </li>
                ))}
              </ol>
            ) : undefined}
          />
        </div>
      )}

      {session.source !== '' && (
        <Section label={t('download.detail.source')}>
          <Typography.Text copyable={{ text: session.source }} style={{ wordBreak: 'break-all' }}>
            {session.source}
          </Typography.Text>
        </Section>
      )}

      {/* ── progress steps (dsh only) ─────────────────────────────────────── */}
      {steps.length > 0 && (
        <Section label={t('download.detail.steps')}>
          <div>
            {steps.map(step => (
              <div key={step.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
                <StepIcon status={step.status} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  {labelOf(tr, STEP_LABEL[step.key]) ?? step.key}
                </span>
                {step.meta !== undefined && (
                  <Typography.Text style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>
                    {step.meta}
                  </Typography.Text>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* ── the evidence the verdict was read from ────────────────────────── */}
      {failure !== undefined && failure.evidence.length > 0 && (
        <Section label={t('download.detail.evidence')}>
          <Mono text={failure.evidence.join('\n')} maxHeight={160} />
        </Section>
      )}

      {/* ── the command, so the report can be reproduced outside the launcher ── */}
      {session.command !== undefined && session.command !== '' && (
        <Section
          label={t('download.detail.command')}
          extra={<Typography.Text copyable={{ text: session.command }} style={{ fontSize: token.fontSizeSM }} />}
        >
          <Mono text={session.command} maxHeight={120} />
        </Section>
      )}

      {/* ── the full log ──────────────────────────────────────────────────── */}
      {session.log !== undefined && session.log !== '' && (
        <Section
          label={t('download.detail.log')}
          extra={<Typography.Text copyable={{ text: session.log }} style={{ fontSize: token.fontSizeSM }} />}
        >
          <Mono text={session.log} maxHeight={320} />
        </Section>
      )}

      {/* A success has no failure and no log — say so instead of showing an empty
          report, which reads like the detail is broken. */}
      {session.status === 'done' && session.message !== undefined && session.message !== '' && (
        <Section label={t('download.detail.result')}>
          <Typography.Text>{session.message}</Typography.Text>
        </Section>
      )}

      {session.status === 'failed' && failure === undefined && session.message !== undefined && (
        <Section label={t('download.detail.result')}>
          <Typography.Text style={{ color: token.colorError, whiteSpace: 'pre-wrap' }}>{session.message}</Typography.Text>
        </Section>
      )}
    </Space>
  )
}

/**
 * The detail modal, fed by the live download store so it stays current while a
 * session is still running. `id` (not a snapshot) is the input: a settled session
 * is retained by `useDownloads`, and while running the row keeps updating.
 */
export function DownloadDetailModal({ id, onClose }: { id: string | null; onClose: () => void }): JSX.Element {
  const { t } = useTranslation()
  const { downloads } = useDownloads()
  const session = useMemo(() => downloads.find(d => d.id === id) ?? null, [downloads, id])
  return (
    <Modal
      title={session === null ? t('download.detail.title') : `${t('download.detail.title')} · ${session.name}`}
      open={session !== null}
      onCancel={onClose}
      width={MODAL.wide}
      footer={<Button onClick={onClose}>{t('common.close')}</Button>}
    >
      {session !== null && <DownloadDetailBody session={session} />}
    </Modal>
  )
}

/** One row of the download list: status + name + a readable second line. */
export function DownloadRow({ d, onDetail, onCancel, onDismiss }: {
  d: DownloadSessionInfo
  onDetail: (id: string) => void
  onCancel: (id: string) => void
  onDismiss: (id: string) => void
}): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const headline = headlineOf(t as unknown as Translate, d.failure)
  const icon = d.status === 'running'
    ? <LoadingOutlined spin style={{ fontSize: 18, color: token.colorWarning }} />
    : d.status === 'done'
      ? <CheckCircleFilled style={{ fontSize: 18, color: token.colorSuccess }} />
      : d.status === 'failed'
        ? <CloseCircleFilled style={{ fontSize: 18, color: token.colorError }} />
        : <MinusCircleFilled style={{ fontSize: 18, color: token.colorBorderSecondary }} />

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 4px', borderRadius: 6 }}>
      {icon}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
          <Tag color={STATUS_COLOR[d.status]} style={{ marginInlineEnd: 0, flexShrink: 0, fontSize: token.fontSizeSM }}>
            {t(STATUS_LABEL[d.status])}
          </Tag>
        </div>
        {/* The cause, not the log. The log is one click away, whole. */}
        {headline !== undefined ? (
          <div
            style={{ color: d.status === 'failed' ? token.colorError : token.colorTextSecondary, fontSize: token.fontSizeSM, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title={headline}
          >
            {headline}
          </div>
        ) : (
          <div
            style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title={d.detail ?? d.source}
          >
            {d.detail ?? d.source}
          </div>
        )}
      </div>
      <Space size={4}>
        {d.kind === 'plugin' && d.status === 'running' && (
          <Button size="small" danger type="text" onClick={() => onCancel(d.id)}>{t('download.panel.cancel')}</Button>
        )}
        {d.status !== 'running' && (
          <Button size="small" type="text" onClick={() => onDismiss(d.id)}>{t('download.panel.dismiss')}</Button>
        )}
        <Button size="small" type="text" onClick={() => onDetail(d.id)}>{t('download.detail')}</Button>
      </Space>
    </div>
  )
}
