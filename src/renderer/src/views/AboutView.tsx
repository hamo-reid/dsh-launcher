import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Button, Descriptions, Tooltip, theme } from 'antd'
import {
  BugOutlined, ExportOutlined, GithubOutlined, LoadingOutlined, ReloadOutlined, TagOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import SectionHeading from '../components/SectionHeading.tsx'
import Panel from '../components/Panel.tsx'
import type { AppRelease } from '../../../shared/types.ts'

type UpdateStatus =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'ok'; latest: AppRelease | null }
  | { status: 'error'; message: string }

/** The project's own addresses. One place, so the rows below cannot drift apart. */
const REPO = 'https://github.com/hamo-reid/dsh-launcher'

/** A value in the app's monospace ramp — versions and dates line up when several
 * of them are stacked. */
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

/** ISO timestamp → `YYYY-MM-DD`, or `—`. Deliberately not locale-formatted: a
 * release date has one right reading, and it is the unambiguous one. */
function isoDay(value: string | undefined): string {
  if (value === undefined || value === '') return '—'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toISOString().slice(0, 10)
}

/** One row of the link list: icon, what it is, and what you will find there. */
function LinkRow({ href, icon, title, hint }: {
  href: string
  icon: ReactNode
  title: string
  hint: string
}) {
  return (
    <a className="pm-about-link" href={href} target="_blank" rel="noreferrer">
      <span className="pm-about-link-icon" aria-hidden>{icon}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontWeight: 500 }}>{title}</span>
        <span className="pm-about-link-hint">{hint}</span>
      </span>
      <ExportOutlined aria-hidden style={{ flex: '0 0 auto', opacity: 0.45 }} />
    </a>
  )
}

/**
 * The update panel's body — its own component so the state it renders is the
 * state a test can hand it. The page fetches through an effect, which a server
 * render does not run, so "up to date" would otherwise be untestable.
 *
 * The rule it exists to hold: **a row is only rendered when it has a value.** A
 * newer release is the sole thing that makes "latest" and its date knowable; when
 * there is none, the verdict line says "you are current" and the table would
 * otherwise show two dashes that read as a failed load.
 */
export function UpdateReport({ update, version, checkedAt }: {
  update: UpdateStatus
  version: string
  checkedAt?: string
}) {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const checking = update.status === 'checking' || update.status === 'idle'
  const latest = update.status === 'ok' ? update.latest : null
  const verdict = ((): { color: string; label: string } => {
    if (checking) return { color: token.colorTextTertiary, label: t('about.update.checking') }
    if (update.status === 'error') return { color: token.colorError, label: t('about.update.failed') }
    if (latest !== null) return { color: token.colorWarning, label: t('about.update.available', { version: latest.version }) }
    return { color: token.colorSuccess, label: t('about.update.upToDate') }
  })()

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: token.paddingSM, flexWrap: 'wrap' }}>
        {checking
          ? <LoadingOutlined spin aria-hidden style={{ color: verdict.color }} />
          : <span aria-hidden style={{ width: 6, height: 6, borderRadius: 3, background: verdict.color }} />}
        <span style={{ fontWeight: 500 }}>{verdict.label}</span>
        {update.status === 'ok' && checkedAt !== undefined && (
          <span style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM }}>
            {t('about.update.checkedAt', { time: checkedAt })}
          </span>
        )}
        {update.status === 'error' && (
          // The transport detail belongs to whoever is filing a bug, not to
          // everyone who opens this page — hence the tooltip.
          <Tooltip title={update.message}>
            <span style={{
              color: token.colorTextTertiary,
              fontSize: token.fontSizeSM,
              borderBottom: `1px dashed ${token.colorBorder}`,
            }}>
              {t('about.update.errorHint')}
            </span>
          </Tooltip>
        )}
      </div>
      <Descriptions column={1} size="small" colon={false}>
        <Descriptions.Item label={t('about.label.current')}>
          <span style={{ fontFamily: MONO }}>{version === '' ? '—' : version}</span>
        </Descriptions.Item>
        {latest !== null && (
          <Descriptions.Item label={t('about.label.latest')}>
            <span style={{ fontFamily: MONO }}>{latest.version}</span>
          </Descriptions.Item>
        )}
        {latest !== null && (
          <Descriptions.Item label={t('about.label.published')}>
            <span style={{ fontFamily: MONO }}>{isoDay(latest.publishedAt)}</span>
          </Descriptions.Item>
        )}
      </Descriptions>
      {latest !== null && (
        <div style={{ marginTop: token.paddingSM }}>
          <Button type="primary" href={latest.url || REPO} target="_blank" rel="noreferrer">
            {t('about.update.release')}
          </Button>
        </div>
      )}
    </>
  )
}

/** About page: what this app is, which build is installed, whether a newer one
 * exists, and where the project lives.
 *
 * Links are plain `<a target=…>` — the main process forwards every http(s) link
 * to the system default browser. */
export default function AboutView() {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [version, setVersion] = useState('')
  const [update, setUpdate] = useState<UpdateStatus>({ status: 'idle' })
  /** When the last *successful* check came back — the one fact that separates
   * "up to date" from "you have not looked yet". */
  const [checkedAt, setCheckedAt] = useState<string>()

  useEffect(() => {
    void window.api.app.version().then(r => { if (r.ok) setVersion(r.value) })
  }, [])

  const check = useCallback((): void => {
    setUpdate({ status: 'checking' })
    window.api.app.checkUpdate().then(r => {
      if (r.ok) {
        setUpdate({ status: 'ok', latest: r.value.latest })
        setCheckedAt(new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }))
      } else {
        setUpdate({ status: 'error', message: r.error ?? '' })
        setCheckedAt(undefined)
      }
    })
  }, [])

  useEffect(() => { check() }, [check])

  const checking = update.status === 'checking' || update.status === 'idle'

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: token.paddingLG }}>
      <div style={{ maxWidth: 960, margin: '0 auto' }}>
        <SectionHeading title={t('app.tab.about')} />

        {/* Product identity. The tinittest possible version of a hero: a mark, the
            two facts that identify the build, and the one action this page owns. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: token.paddingLG,
            flexWrap: 'wrap',
            padding: `${token.paddingLG}px`,
            borderRadius: token.borderRadiusLG,
            border: `1px solid ${token.colorBorder}`,
            background: `linear-gradient(135deg, ${token.colorPrimaryBg} 0%, ${token.colorBgContainer} 62%)`,
          }}
        >
          <div
            aria-hidden
            style={{
              width: 56,
              height: 56,
              flex: '0 0 auto',
              borderRadius: 16,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              fontSize: 24,
              fontWeight: 700,
              letterSpacing: 0.5,
              background: `linear-gradient(140deg, ${token.colorPrimary} 0%, ${token.colorPrimaryActive} 100%)`,
              boxShadow: `inset 0 1px 0 rgba(255,255,255,0.35), 0 6px 16px ${token.colorPrimaryBgHover}`,
            }}
          >
            D
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 20, fontWeight: 600, lineHeight: 1.4 }}>DSH Launcher</span>
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: token.fontSizeSM,
                  padding: '1px 8px',
                  borderRadius: 6,
                  color: token.colorTextSecondary,
                  background: token.colorBgLayout,
                  border: `1px solid ${token.colorBorderSecondary}`,
                }}
              >
                {version === '' ? '—' : version}
              </span>
            </div>
            <div style={{ color: token.colorTextSecondary, marginTop: 6 }}>{t('about.about')}</div>
          </div>
          <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 12 }}>
            <Button icon={<ReloadOutlined />} loading={checking} onClick={check}>
              {t('about.update.check')}
            </Button>
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
            gap: token.paddingLG,
            marginTop: token.paddingLG,
            alignItems: 'start',
          }}
        >
          <Panel title={t('about.section.update')}>
            <UpdateReport update={update} version={version} checkedAt={checkedAt} />
          </Panel>

          <Panel title={t('about.section.links')}>
            <div className="pm-about-links">
              <LinkRow
                href={REPO}
                icon={<GithubOutlined />}
                title={t('about.link.repo')}
                hint={t('about.link.repoHint')}
              />
              <LinkRow
                href={`${REPO}/releases`}
                icon={<TagOutlined />}
                title={t('about.link.releases')}
                hint={t('about.link.releasesHint')}
              />
              <LinkRow
                href={`${REPO}/issues`}
                icon={<BugOutlined />}
                title={t('about.link.issues')}
                hint={t('about.link.issuesHint')}
              />
            </div>
          </Panel>
        </div>

        <div
          style={{
            marginTop: token.paddingLG,
            paddingTop: token.padding,
            borderTop: `1px solid ${token.colorSplit}`,
            color: token.colorTextTertiary,
            fontSize: token.fontSizeSM,
            textAlign: 'center',
          }}
        >
          {t('about.footer')}
        </div>
      </div>
    </div>
  )
}
