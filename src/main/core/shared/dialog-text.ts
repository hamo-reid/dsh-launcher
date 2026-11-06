/**
 * The words a NATIVE dialog shows.
 *
 * A dialog is an OS window drawn by MAIN, so its title cannot come from the page's
 * i18n bundle. The one dialog whose words the page also needs — the data-root
 * folder picker — takes them through IPC (`settings:pickDir`), but the rest are
 * FIXED dialogs: "import a skill archive" is the same window whichever button opens
 * it, and threading copy through every call site only moved the problem.
 *
 * So their words live here, picked by the language the user has already chosen
 * (`uiLanguage`, written by the renderer when it switches). Without this, an
 * English UI popped Chinese dialogs.
 *
 * Keys name the dialog's JOB, never a sentence, and the title and the file-type
 * filter's own label come from the SAME entry: a dialog cannot end up with half its
 * copy translated.
 */

import { loadSettings } from '../settings/settings.ts'

/** One dialog's copy. `filter` is the label of its file-type filter, when it has
 * one — an "open a folder" dialog has none. */
interface DialogCopy {
  title: string
  filter?: string
}

/** Every fixed dialog the main process shows. */
export type DialogKey =
  | 'exportSettings'
  | 'importSettings'
  | 'patchFile'
  | 'skillFolder'
  | 'skillZip'
  | 'devPluginDir'
  | 'pluginZip'
  | 'exportDshData'
  | 'importDshData'
  | 'profileExportZip'
  | 'profileExportJson'
  | 'importProfile'

/** Chinese first, as the app's own copy is: these strings are the ones the dialogs
 * already showed, kept verbatim so this change moves no words. */
const COPY: Record<DialogKey, { zh: DialogCopy; en: DialogCopy }> = {
  exportSettings: {
    zh: { title: '导出设置', filter: 'JSON' },
    en: { title: 'Export settings', filter: 'JSON' },
  },
  importSettings: {
    zh: { title: '导入设置', filter: 'JSON' },
    en: { title: 'Import settings', filter: 'JSON' },
  },
  patchFile: {
    zh: { title: '选择 patch 文件', filter: 'Cordis patch' },
    en: { title: 'Choose a patch file', filter: 'Cordis patch' },
  },
  skillFolder: {
    zh: { title: '选择 skill 文件夹' },
    en: { title: 'Choose a skill folder' },
  },
  skillZip: {
    zh: { title: '选择要导入的 skill 压缩包', filter: 'Skill 压缩包' },
    en: { title: 'Choose a skill archive', filter: 'Skill archive' },
  },
  devPluginDir: {
    zh: { title: '选择开发插件包目录' },
    en: { title: 'Choose a dev plugin folder' },
  },
  pluginZip: {
    zh: { title: '选择插件 .zip 包', filter: '插件包' },
    en: { title: 'Choose a plugin .zip', filter: 'Plugin package' },
  },
  exportDshData: {
    zh: { title: '导出 DSH 数据', filter: 'DSH 数据' },
    en: { title: 'Export DSH data', filter: 'DSH data' },
  },
  importDshData: {
    zh: { title: '选择要导入的 DSH 数据包', filter: 'DSH 数据' },
    en: { title: 'Choose a DSH data archive', filter: 'DSH data' },
  },
  profileExportZip: {
    zh: { title: '导出 {{name}}', filter: '存档' },
    en: { title: 'Export {{name}}', filter: 'Archive' },
  },
  profileExportJson: {
    zh: { title: '导出 {{name}}', filter: 'JSON' },
    en: { title: 'Export {{name}}', filter: 'JSON' },
  },
  importProfile: {
    zh: { title: '选择要导入的 profile 导出文件', filter: 'Profile 导出' },
    en: { title: 'Choose a profile export', filter: 'Profile export' },
  },
}

/** A file-type filter, structurally what `dialog.showOpenDialog` accepts. */
export interface DialogFilter {
  name: string
  extensions: string[]
}

/** The copy for one dialog, in the UI language the user chose. `zh` is the default
 * the app itself uses when nothing has been chosen yet. */
function copyOf(key: DialogKey): DialogCopy {
  return COPY[key][loadSettings().uiLanguage === 'en' ? 'en' : 'zh']
}

/**
 * One dialog's title, with `{{name}}` filled in when the key carries it (a profile
 * export names the profile).
 * @param key - which dialog.
 * @param params - the values its title interpolates, if any.
 */
export function dialogTitle(key: DialogKey, params: { name?: string } = {}): string {
  return copyOf(key).title.replaceAll('{{name}}', params.name ?? '')
}

/**
 * One dialog's file-type filter, carrying the accepted extensions the CALLER knows
 * (they are the caller's business — this module only owns the words).
 * @param key - which dialog, so the filter is named like its title.
 * @param extensions - the types this dialog accepts.
 */
export function dialogFilter(key: DialogKey, extensions: readonly string[]): DialogFilter {
  return { name: copyOf(key).filter ?? extensions.join(', '), extensions: [...extensions] }
}
