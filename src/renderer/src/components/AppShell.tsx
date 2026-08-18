import type { ReactNode } from 'react'
import { Layout, theme } from 'antd'
import { LAYOUT } from '../theme.ts'

const { Sider, Content } = Layout

interface AppShellProps {
  /** Left navigation rail content (list, actions, …). */
  sider: ReactNode
  /** Rail width; defaults to the unified LAYOUT.sidebarWidth. */
  siderWidth?: number
  /** When true, the content area has no padding and hands scrolling to the
   * child — for full-bleed panels that own a fixed header + scrolled body. */
  flush?: boolean
  /** Main area; scrolls vertically (unless `flush`). */
  children: ReactNode
}

/** Standard two-pane app shell: a fixed-width left rail + scrollable content. */
export default function AppShell({
  sider, siderWidth = LAYOUT.sidebarWidth, flush = false, children,
}: AppShellProps) {
  const { token } = theme.useToken()
  return (
    <Layout style={{ height: '100%', background: 'transparent' }}>
      <Sider
        width={siderWidth}
        style={{ background: token.colorBgContainer, borderRight: `1px solid ${token.colorSplit}` }}
      >
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>{sider}</div>
      </Sider>
      <Content
        style={{
          padding: flush ? 0 : LAYOUT.pagePaddingLG,
          overflowY: flush ? 'hidden' : 'auto',
          background: token.colorBgLayout,
          minWidth: 0,
          minHeight: 0,
        }}
      >
        {children}
      </Content>
    </Layout>
  )
}