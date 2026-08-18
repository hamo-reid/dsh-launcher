import { useState, type ReactNode } from 'react'
import { ConfigProvider, Layout, Tabs, theme, Typography } from 'antd'
import {
  AppstoreOutlined, ProfileOutlined, RobotOutlined, SettingOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useAppLang } from './i18n'
import ProfileSection from './views/ProfileSection.tsx'
import PluginsSection from './views/PluginsSection.tsx'
import SettingsSection from './views/SettingsSection.tsx'
import DshSection from './views/DshSection.tsx'

type Tab = 'profile' | 'plugins' | 'settings' | 'dsh'

const { Content } = Layout

export default function App() {
  const { t } = useTranslation()
  const { antdLocale } = useAppLang()
  const [tab, setTab] = useState<Tab>('profile')
  const { token } = theme.useToken()

  const TABS: { key: Tab; label: string; icon: ReactNode }[] = [
    { key: 'dsh', label: t('app.tab.dsh'), icon: <RobotOutlined /> },
    { key: 'profile', label: t('app.tab.profile'), icon: <ProfileOutlined /> },
    { key: 'plugins', label: t('app.tab.plugins'), icon: <AppstoreOutlined /> },
    { key: 'settings', label: t('app.tab.settings'), icon: <SettingOutlined /> },
  ]

  return (
    <ConfigProvider locale={antdLocale}>
    <Layout style={{ height: '100vh', overflow: 'hidden', background: token.colorBgLayout }}>
      {/* App chrome: unified main header (brand + nav tabs), divided from the
          canvas by a clear border so it reads as one block, not floating flat. */}
      <div style={{ background: token.colorBgContainer, borderBottom: `1px solid ${token.colorBorder}`, flexShrink: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 16px',
            height: 52,
          }}
        >
          <Typography.Text strong style={{ fontSize: 15 }}>
            DSH Launcher
          </Typography.Text>
        </div>
        <Tabs
          activeKey={tab}
          onChange={key => setTab(key as Tab)}
          items={TABS.map(entry => ({ key: entry.key, label: entry.label, icon: entry.icon }))}
          tabBarStyle={{ marginBottom: 0, padding: '0 16px', background: token.colorBgContainer }}
        />
      </div>

      <Content style={{ flex: 1, overflow: 'hidden', background: token.colorBgLayout }}>
        {tab === 'profile' && <ProfileSection />}
        {tab === 'plugins' && <PluginsSection />}
        {tab === 'settings' && <SettingsSection />}
        {tab === 'dsh' && <DshSection />}
      </Content>
    </Layout>
    </ConfigProvider>
  )
}