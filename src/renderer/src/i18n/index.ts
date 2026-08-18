/** i18n bootstrap + a small hook that keeps i18next / dayjs / antd locale in
 * sync with the persisted UI language. */

import i18next from 'i18next'
import { initReactI18next, useTranslation } from 'react-i18next'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import zhCN from 'antd/locale/zh_CN'
import enUS from 'antd/locale/en_US'
import type { Locale } from 'antd/es/locale'
import zh from './locales/zh'
import en from './locales/en'

const DAYJS_LOCALES: Record<string, string> = { zh: 'zh-cn', en: 'en' }
const ANTD_LOCALES: Record<string, Locale> = { zh: zhCN, en: enUS }

let initPromise: Promise<unknown> | null = null

/** Initialize i18next (idempotent). Reads the persisted language from settings. */
export function initI18n(): Promise<unknown> {
  if (initPromise !== null) return initPromise
  initPromise = (async () => {
    let saved: string | undefined
    try {
      const r = await window.api.settings.getUiLanguage()
      if (r.ok && r.value !== null) saved = r.value
    } catch {
      // renderer bootstrap edge — fall back to zh
    }
    await i18next.use(initReactI18next).init({
      resources: { zh, en },
      lng: saved ?? 'zh',
      fallbackLng: 'zh',
      interpolation: { escapeValue: false },
    })
    syncHosts(i18next.resolvedLanguage ?? 'zh')
  })()
  return initPromise
}

/** Keep dayjs locale in step with the app language. */
function syncDayjs(language: string): void {
  dayjs.locale(DAYJS_LOCALES[language] ?? 'zh-cn')
}

function syncHosts(language: string): void {
  syncDayjs(language)
}

/** Current app language + antd locale, and a switcher that persists the choice. */
export function useAppLang(): {
  language: string
  antdLocale: Locale
  setLanguage: (lng: string) => Promise<void>
} {
  const { i18n } = useTranslation()
  const language = i18n.resolvedLanguage ?? 'zh'
  const antdLocale = ANTD_LOCALES[language] ?? zhCN

  const setLanguage = async (lng: string): Promise<void> => {
    await i18n.changeLanguage(lng)
    syncHosts(lng)
    void window.api.settings.setUiLanguage(lng)
  }

  return { language, antdLocale, setLanguage }
}