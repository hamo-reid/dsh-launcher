/**
 * Discover/register dsh installs (public facade). The implementation now lives in
 * focused modules under this same directory; this barrel keeps the established
 * `./dsh.ts` import path (core/, ipc/, tests) working unchanged.
 *
 * The four split along what they act on: how a dsh is launched, how one is found,
 * how one is installed and updated, and the local version repository those
 * installs land in.
 */

export type { DshEntry } from '../../../shared/types.ts'

export {
  baseLaunch, defaultHome, readVersionFromPath, resolveDshPackage, resolveLaunchEntry,
} from './launch.ts'
export type { DshResolved, LaunchEntry } from './launch.ts'

export {
  detectExecutables, entryFromPath, existsExecutable, installDir, isDeletableDsh, isManagedInstall,
  probeDshs, resolveInstallAnchor,
} from './probe.ts'

export {
  checkForDshUpdate, installOfficialDsh, installSubName, pickBinCandidate, readInstalledVersion,
  registerInstalledDsh, resolveInstallSpec, updateDsh, versionExists,
} from './install.ts'

export { discoverVersionRepo } from './version-repo.ts'
