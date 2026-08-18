/**
 * Design tokens — the single source of truth for the UI's look & feel.
 *
 * Everything visual derives from these: shared components and Views read
 * colors/layout through antd `theme` tokens (`theme.useToken()`) or these
 * exported layout constants. Never hard-code raw hex / fixed px in a View.
 * See docs/ui-guidelines.md for the rules and the per-token table.
 */
import { theme as antdTheme } from 'antd'
import type { ThemeConfig } from 'antd'

/** App-level theme mode (system = follow the OS). */
export type ThemeMode = 'light' | 'dark' | 'system'

/** Fixed layout dimensions shared across sections (do not vary with theme). */
export const LAYOUT = {
  /** Unified left navigation rail width across every section. */
  sidebarWidth: 280,
  /** Standard content padding (px). */
  pagePadding: 16,
  pagePaddingLG: 24,
} as const

/** Responsive modal widths: `wide` for list/detail dialogs, `narrow` for small
 * forms. They track the viewport so a wider window gets a wider dialog, while a
 * narrow window keeps it from overflowing. */
export const MODAL = {
  wide: 'min(1040px, 94vw)',
  narrow: 'min(620px, 94vw)',
} as const

/** Brand color ramp — a calm enterprise deep blue for the dsh ecosystem. */
const BRAND = { light: '#2b5cd9', dark: '#4f7bff' } as const

/** Light theme: antd defaults, optimised to a calm enterprise deep-blue. */
const lightToken: NonNullable<ThemeConfig['token']> = {
  colorPrimary: BRAND.light,
  colorInfo: BRAND.light,
  colorLink: BRAND.light,
  // Text ramp — replaces the ad-hoc #777 / #888 / #999 scattered earlier.
  colorText: '#1f2430',
  colorTextSecondary: '#565e74',
  colorTextTertiary: '#8a91a8',
  colorTextQuaternary: '#c9cdd6',
  colorBorder: '#e4e7f0',
  colorBorderSecondary: '#eef0f6',
  colorSplit: '#eef0f6',
  colorBgLayout: '#eaeef6',
  colorBgContainer: '#ffffff',
  colorBgElevated: '#ffffff',
  colorPrimaryBg: '#e6f0ff',
  colorPrimaryBgHover: '#d8e8ff',
  borderRadius: 8,
  borderRadiusLG: 12,
  fontSize: 14,
}

/** Dark theme: antd dark algorithm plus brand-aware text/layer overrides. */
const darkToken: NonNullable<ThemeConfig['token']> = {
  colorPrimary: BRAND.dark,
  colorInfo: BRAND.dark,
  colorLink: BRAND.dark,
  colorText: 'rgba(255,255,255,0.92)',
  colorTextSecondary: 'rgba(255,255,255,0.72)',
  colorTextTertiary: 'rgba(255,255,255,0.56)',
  colorTextQuaternary: 'rgba(255,255,255,0.38)',
  colorBorder: 'rgba(255,255,255,0.16)',
  colorBorderSecondary: 'rgba(255,255,255,0.10)',
  colorSplit: 'rgba(255,255,255,0.10)',
  colorPrimaryBg: 'rgba(79,123,255,0.16)',
  colorPrimaryBgHover: 'rgba(79,123,255,0.24)',
  borderRadius: 8,
  borderRadiusLG: 12,
  fontSize: 14,
}

/** Ready-to-plug ThemeConfig for the two concrete modes. */
export const themes: Record<'light' | 'dark', ThemeConfig> = {
  light: { token: lightToken },
  dark: { algorithm: antdTheme.darkAlgorithm, token: darkToken },
}

/** CSS custom properties mirrored on <html> so non-antd chrome (scrollbars,
 * page background) follows the active theme. Set by ThemeProvider. */
export function cssVars(isDark: boolean): Record<string, string> {
  return {
    '--pm-bg': isDark ? 'rgba(0,0,0,0.28)' : (lightToken.colorBgLayout ?? '#f4f6fb'),
    '--pm-surface-border': isDark
      ? (darkToken.colorBorder ?? 'rgba(255,255,255,0.16)')
      : (lightToken.colorBorder ?? '#e4e7f0'),
    '--pm-scrollbar': isDark ? 'rgba(255,255,255,0.24)' : 'rgba(0,0,0,0.22)',
  }
}