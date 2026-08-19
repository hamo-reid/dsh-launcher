import { useEffect, useState } from 'react'
import { Divider, Space, theme } from 'antd'
import { GithubOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import SectionHeading from '../components/SectionHeading.tsx'
import Panel from '../components/Panel.tsx'

/** About page: app version + a GitHub link. The link is a plain `<a target=…>`
 * — the main process forwards every http(s) link to the system default browser. */
export default function AboutView() {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [version, setVersion] = useState('')

  useEffect(() => {
    void window.api.app.version().then(r => { if (r.ok) setVersion(r.value) })
  }, [])

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