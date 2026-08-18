/**
 * ThemeProvider — wires antd ConfigProvider (zh-CN locale + design tokens) to
 * run-time theme state. Exposes light / dark / system modes and persists the
 * choice in localStorage; mirrors a few CSS variables on <html> so non-antd
 * chrome follows the theme.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from 'react'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { cssVars, themes, type ThemeMode } from './theme.ts'

interface ThemeContextValue {
  mode: ThemeMode
  isDark: boolean
  setMode: (mode: ThemeMode) => void
}

const STORAGE_KEY = 'profile-manager.theme'

const ThemeContext = createContext<ThemeContextValue>({
  mode: 'light',
  isDark: false,
  setMode: () => {},
})

function storedMode(): ThemeMode {
  const saved = localStorage.getItem(STORAGE_KEY) as ThemeMode | null
  return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'light'
}

function isSystemDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

export function ThemeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [mode, setModeState] = useState<ThemeMode>(storedMode)
  const [systemDark, setSystemDark] = useState(isSystemDark)

  // Keep tracking the OS preference while in `system` mode.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (event: MediaQueryListEvent): void => setSystemDark(event.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const isDark = mode === 'system' ? systemDark : mode === 'dark'

  // Mirror CSS variables for the non-antd page chrome.
  useEffect(() => {
    const root = document.documentElement
    for (const [key, value] of Object.entries(cssVars(isDark))) root.style.setProperty(key, value)
  }, [isDark])

  const setMode = useCallback((next: ThemeMode): void => {
    setModeState(next)
    localStorage.setItem(STORAGE_KEY, next)
  }, [])

  const value = useMemo(() => ({ mode, isDark, setMode }), [mode, isDark, setMode])
  const config = themes[isDark ? 'dark' : 'light']

  return (
    <ThemeContext.Provider value={value}>
      <ConfigProvider locale={zhCN} theme={config}>
        {children}
      </ConfigProvider>
    </ThemeContext.Provider>
  )
}

/** Read the active theme mode from anywhere under the provider. */
export function useThemeMode(): ThemeContextValue {
  return useContext(ThemeContext)
}