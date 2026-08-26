import { useCallback, useEffect, useState } from 'react'
import { Button, Divider, Space, Tag, theme } from 'antd'
import { GithubOutlined, LoadingOutlined, ReloadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import SectionHeading from '../components/SectionHeading.tsx'
import Panel from '../components/Panel.tsx'
import type { AppRelease } from '../../../shared/types.ts'

type UpdateStatus =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'ok'; latest: AppRelease | null }
  | { status: 'error'; message: string }

/** About page: app version + a GitHub link + a manual/automatic update check
 * against the GitHub releases API. Links are plain `<a target=…>` — the main
 * process forwards every http(s) link to the system default browser. */
export default function AboutView() {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [version, setVersion] = useState('')
  const [update, setUpdate] = useState<UpdateStatus>({ status: 'idle' })

  useEffect(() => {
    void window.api.app.version().then(r => { if (r.ok) setVersion(r.value) })
  }, [])

  const check = useCallback((): void => {
    setUpdate({ status: 'checking' })
    window.api.app.checkUpdate().then(r => {
      if (r.ok) setUpdate({ status: 'ok', latest: r.value.latest })
      else setUpdate({ status: 'error', message: r.error ?? '' })
    })
  }, [])

  useEffect(() => { check() }, [check])

  const repo = 'https://github.com/hamo-reid/dsh-launcher'

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: token.paddingLG }}>
      <SectionHeading title={t('app.tab.about')} />
      <Space direction="vertical" size="middle" style={{ width: '100%', maxWidth: 640 }}>
        <Panel title="DSH Launcher">
          <Space direction="vertical" size="small">
            <div>{t('about.about')}</div>
            <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>
              {t('about.version', { version: version || t('common.unknown') })}
            </div>
            <Space size="middle" wrap>
              {update.status === 'idle' || update.status === 'checking'
                ? (
                  <>
                    {update.status === 'checking' && <LoadingOutlined spin />}
                    <span style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>
                      {t('about.update.checking')}
                    </span>
                  </>
                )
                : update.status === 'error'
                  ? (
                    <>
                      <Tag color="error">{t('about.update.failed')}</Tag>
                      <span style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>{update.message}</span>
                    </>
                  )
                  : update.latest
                    ? (
                      <>
                        <Tag color="warning">{t('about.update.available', { version: update.latest.version })}</Tag>
                        <a
                          target="_blank"
                          rel="noreferrer"
                          href={update.latest.url || repo}
                          style={{ color: token.colorPrimary }}
                        >
                          {t('about.update.release')}
                        </a>
                      </>
                    )
                    : <Tag color="success">{t('about.update.upToDate')}</Tag>}
              <Button size="small" type="text" icon={<ReloadOutlined />} onClick={check} disabled={update.status === 'checking'}>
                {t('about.update.check')}
              </Button>
            </Space>
            <Divider style={{ margin: '10px 0 8px' }} />
            <a
              target="_blank"
              rel="noreferrer"
              href={repo}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: token.colorPrimary }}
            >
              <GithubOutlined />
              <span>{t('about.github')}</span>
            </a>
          </Space>
        </Panel>
      </Space>
    </div>
  )
}