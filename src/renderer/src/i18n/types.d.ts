/** Augment i18next's types so `t('app.tab.profile')` etc. are key-checked. */
import type { ZhResource } from './locales/zh'

declare module 'i18next' {
  interface CustomTypeOptions {
    resources: ZhResource['translation'] extends infer T ? { translation: T } : never
  }
}

export {}