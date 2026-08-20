import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { Alert, Button, ConfigProvider, Layout, Space, Tabs, theme, Typography } from 'antd'
import {
  AppstoreOutlined, CloseOutlined, FullscreenExitOutlined, FullscreenOutlined,
  InfoOutlined, MinusOutlined, ProfileOutlined, RobotOutlined, SettingOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useAppLang } from './i18n'
import OnboardingModal from './components/OnboardingModal.tsx'
import CloseConfirmModal from './components/CloseConfirmModal.tsx'
import ProfileSection from './views/ProfileSection.tsx'
import PluginsSection from './views/PluginsSection.tsx'
import SettingsSection from './views/SettingsSection.tsx'
import DshSection from './views/DshSection.tsx'
import AboutView from './views/AboutView.tsx'
import type { HealthIssue } from '../../shared/types.ts'

type Tab = 'profile' | 'plugins' | 'settings' | 'dsh' | 'about'

const { Content } = Layout

export default function App() {
  const { t } = useTranslation()
  const { antdLocale } = useAppLang()
  const [tab, setTab] = useState<Tab>('profile')
  const [onboarding, setOnboarding] = useState<'loading' | 'open' | 'done'>('loading')
  const [onboardDefaults, setOnboardDefaults] = useState({ pluginDir: '', dshVersionDir: '' })
  const { token } = theme.useToken()
  const [maximized, setMaximized] = useState(false)
  const [issues, setIssues] = useState<HealthIssue[]>([])
  // Shown when the main process asks us to pick minimize-to-tray vs quit on close.
  const [closePrompt, setClosePrompt] = useState<{ running?: string } | null>(null)

  // Decide once whether the first-run wizard is required (fresh install).
  useEffect(() => {
    let alive = true
    void window.api.settings.getOnboardingState().then((r) => {
      if (!alive) return
      if (!r.ok) { setOnboarding('done'); return }
      setOnboardDefaults(r.value.defaults)
      setOnboarding(r.value.required ? 'open' : 'done')
    })
    return () => { alive = false }
  }, [])

  // Mirror the window's maximize state for the custom title-bar icon.
  useEffect(() => {
    void window.api.window.isMaximized().then(r => { if (r.ok) setMaximized(r.value) })
    return window.api.window.onMaximizeState(setMaximized)
  }, [])

  // Show the minimize-vs-quit prompt when the window close is intercepted.
  useEffect(() => window.api.window.onAskClose(info => setClosePrompt(info)), [])

  // Disk-vs-app sync health: stale/missing dsh + store paths. Check on mount,
  // and again when entering the DSH / plugins views so a fix shows up promptly.
  const refreshHealth = async (): Promise<void> => {
    const r = await window.api.settings.checkHealth()
    if (r.ok) setIssues(r.value)
  }

  // Jump to the page that can actually act on the current issues: store/plugin
  // issues land on the plugins page, executable issues on the DSH page.
  const goFix = (): void => {
    const target = issues.find(x => x.kind === 'store-unconfigured' || x.kind === 'store-missing' || x.kind === 'plugin-missing')
    setTab(target !== undefined ? 'plugins' : 'dsh')
  }
  useEffect(() => { void refreshHealth() }, [])
  useEffect(() => {
    if (tab === 'dsh' || tab === 'plugins') void refreshHealth()
  }, [tab])

  const TABS: { key: Tab; label: string; icon: ReactNode }[] = [
    { key: 'dsh', label: t('app.tab.dsh'), icon: <RobotOutlined /> },
    { key: 'profile', label: t('app.tab.profile'), icon: <ProfileOutlined /> },
    { key: 'plugins', label: t('app.tab.plugins'), icon: <AppstoreOutlined /> },
    { key: 'settings', label: t('app.tab.settings'), icon: <SettingOutlined /> },
    { key: 'about', label: t('app.tab.about'), icon: <InfoOutlined /> },
  ]

  return (
    <ConfigProvider locale={antdLocale}>
    <Layout style={{ height: '100vh', overflow: 'hidden', background: token.colorBgLayout }}>
      {/* App chrome: unified main header (brand + nav tabs), divided from the
          canvas below by a clear border + a soft drop shadow so the header reads
          as one distinct block sitting above the content. */}
      <div
        style={{
          background: token.colorBgContainer,
          borderBottom: `1px solid ${token.colorSplit}`,
          flexShrink: 0,
        }}
      >
        {/* Brand row doubles as the frameless drag handle; the window controls
            and the tabs below opt out (no-drag) so they stay clickable. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingLeft: 16,
            height: 52,
            borderBottom: `1px solid ${token.colorBorder}`,
            WebkitAppRegion: 'drag',
          } as CSSProperties}
          onDoubleClick={() => void window.api.window.toggleMaximize()}
        >
          <Typography.Text strong style={{ fontSize: 15 }}>
            DSH Launcher
          </Typography.Text>
          <WindowControls maximized={maximized} />
        </div>
        <Tabs
          activeKey={tab}
          onChange={key => setTab(key as Tab)}
          items={TABS.map(entry => ({ key: entry.key, label: entry.label, icon: entry.icon }))}
          tabBarStyle={{ marginBottom: 0, padding: '0 16px', background: token.colorBgContainer, WebkitAppRegion: 'no-drag' } as CSSProperties}
        />
      </div>

      {/* Disk-vs-app sync banner: non-blocking summary of stale/ missing paths. */}
      {issues.length > 0 && (
        <div style={{ padding: '8px 16px', borderBottom: `1px solid ${token.colorSplit}` }}>
          <Alert type="warning" showIcon closable onClose={() => setIssues([])}
            message={(
              <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                <span>{t('health.summary', { count: issues.length })}</span>
                <Space>
                  <Button size="small" onClick={() => void refreshHealth()}>{t('health.refresh')}</Button>
                  <Button size="small" onClick={() => goFix()}>{t('health.goFix')}</Button>
                </Space>
              </Space>
            )}
            description={(
              <ul style={{ margin: '6px 0 0', paddingInlineStart: 18 }}>
                {issues.map((it, i) => (
                  <li key={i}>
                    {t(`health.kind.${it.kind}`)}：{it.label}
                    {it.path !== undefined ? <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}> — {it.path}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          />
        </div>
      )}

      <Content style={{ flex: 1, overflow: 'hidden', background: token.colorBgLayout }}>
        {tab === 'profile' && <ProfileSection />}
        {tab === 'plugins' && <PluginsSection />}
        {tab === 'settings' && <SettingsSection />}
        {tab === 'dsh' && <DshSection />}
        {tab === 'about' && <AboutView />}
      </Content>
    </Layout>
    {onboarding === 'open' && (
      <OnboardingModal
        defaults={onboardDefaults}
        onComplete={() => setOnboarding('done')}
      />
    )}
    <CloseConfirmModal
      open={closePrompt !== null}
      running={closePrompt?.running}
      onClose={() => setClosePrompt(null)}
      onResolve={(action, remember) => {
        void window.api.window.chooseClose(action, remember)
      }}
    />
    </ConfigProvider>
  )
}

/** One title-bar window-control button (min/max/close). */
function WindowButton(props: {
  label: string
  danger?: boolean
  onClick: () => void
  children: ReactNode
}): JSX.Element {
  const { token } = theme.useToken()
  const [hover, setHover] = useState(false)
  const danger = props.danger === true
  const background = hover ? (danger ? token.colorError : token.colorFillTertiary) : 'transparent'
  const color = danger && hover ? '#fff' : token.colorTextSecondary
  return (
    <button
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: 'none',
        border: 'none',
        cursor: 'default',
        background,
        color,
        width: 46,
        height: 32,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        WebkitAppRegion: 'no-drag',
        fontSize: 13,
      } as CSSProperties}
    >
      {props.children}
    </button>
  )
}

/** Frameless title-bar window controls (minimize / maximize-restore / close). */
function WindowControls({ maximized }: { maximized: boolean }): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', WebkitAppRegion: 'no-drag', height: '100%' } as CSSProperties}>
      <WindowButton label="Minimize" onClick={() => void window.api.window.minimize()}>
        <MinusOutlined />
      </WindowButton>
      <WindowButton label={maximized ? 'Restore' : 'Maximize'} onClick={() => void window.api.window.toggleMaximize()}>
        {maximized ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
      </WindowButton>
      <WindowButton label="Close" danger onClick={() => void window.api.window.close()}>
        <CloseOutlined />
      </WindowButton>
    </div>
  )
}