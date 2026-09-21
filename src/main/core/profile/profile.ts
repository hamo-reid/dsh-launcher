/**
 * Profile instance management (public facade). The implementation now lives in
 * focused modules under this same directory; this barrel keeps the established
 * `./profile.ts` import path (ipc/, tests, plugin code) working unchanged.
 *
 * `assertCustomProfileName` stays out of it on purpose: it is the name rule the
 * lifecycle and import paths share, not part of this module's public surface.
 */
export type { ImportProfileResult, ProfileSummary } from '../../../shared/types.ts'

export { assertManifestText, profileDirPath, profileFilePath, readProfileFile, writeProfileFile } from './io.ts'
export {
  cloneProfile, createProfile, listProfileSummaries, PROFILE_TEMPLATES, renameProfile, setManifestMeta,
  softDeleteProfile, transferProfilePatch,
} from './lifecycle.ts'
export {
  addBundle, linkDevToProfile, profileBundleInfo, removeBundle, removeDependency, reorderBundle,
  repairDevLink, setDependency,
} from './bundles.ts'
export type { BundleSource, ExportBundle, ProfileExport } from './export.ts'
export { exportProfile, importProfile, listLocalBundles, mirrorProfile } from './export.ts'
