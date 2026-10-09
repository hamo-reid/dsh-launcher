/**
 * Every error code the app can return — the single source of truth, and the key
 * the renderer turns into a sentence (`lib/ipc.ts` looks up `errors.<code>`).
 *
 * It lives in `src/shared/` because it crosses the process boundary: the codes are
 * produced in main and read in the renderer, and the i18n test checks the two
 * against each other. `core/shared/errors.ts` re-exports it for the main side,
 * where the throwing helpers (`throwE` / `fail` / `failFromError`) live.
 */
/** Common error codes, for reference / reuse in throwE/fail. The single source
 * of truth — handlers should reference `E.*` instead of typing raw codes. */
export const E = {
  internal: 'internal',
  nameInvalid: 'name.invalid',
  commonCancelled: 'common.cancelled',
  // dsh
  needActiveDsh: 'dsh.needActive',
  dshNotFound: 'dsh.notFound',
  dshNotManaged: 'dsh.notManaged',
  dshUpToDate: 'dsh.upToDate',
  dshMajorRisk: 'dsh.majorRisk',
  dshProtected: 'dsh.protected',
  dshVersionExists: 'dsh.versionExists',
  dshInUse: 'dsh.inUse',
  // profile
  profileExists: 'profile.exists',
  profileNotFound: 'profile.notFound',
  bundleNotFound: 'bundle.notFound',
  bundleNoRow: 'bundle.noRow',
  patchWriteVerify: 'patch.writeVerify',
  patchNothingToRemove: 'patch.nothingToRemove',
  // store / plugins
  storeNotConfigured: 'store.notConfigured',
  storeNotDir: 'store.notDir',
  storeBadManifest: 'store.badManifest',
  storeUnusable: 'store.unusable',
  storeInstallFailed: 'store.installFailed',
  storeOperationFailed: 'store.operationFailed',
  storeVersionInUse: 'store.versionInUse',
  pluginNotInstalled: 'plugin.notInstalled',
  // launcher data root
  dataRootBusy: 'dataRoot.busy',
  dataRootNested: 'dataRoot.nested',
  // market
  marketEntryNotFound: 'market.entryNotFound',
  // registry (the configured npm registry a search / install reads from)
  registryBadUrl: 'registry.badUrl',
  registryBadScheme: 'registry.badScheme',
  // extensions (MCP rows)
  extBadServerName: 'ext.badServerName',
  extBadTransport: 'ext.badTransport',
  extNeedCommand: 'ext.needCommand',
  extNeedUrl: 'ext.needUrl',
  extBadEnvName: 'ext.badEnvName',
  extBadEnvValue: 'ext.badEnvValue',
  // extensions (skills)
  extSkillNotFound: 'ext.skillNotFound',
  extSkillReadOnly: 'ext.skillReadOnly',
  extSkillExists: 'ext.skillExists',
  extBadSkill: 'ext.badSkill',
  extSkillZipNoSkill: 'ext.skillZipNoSkill',
  extSkillZipUnsafe: 'ext.skillZipUnsafe',
  extSkillZipNotZip: 'ext.skillZipNotZip',
  extSkillZipMissing: 'ext.skillZipMissing',
  extSkillZipBad: 'ext.skillZipBad',
  // extensions (MCP library)
  extMcpExists: 'ext.mcpExists',
  extMcpNotInLib: 'ext.mcpNotInLib',
  extMcpIdTaken: 'ext.mcpIdTaken',
  // dsh data import/export
  dataNotSelected: 'data.notSelected',
  // run
  runAlreadyRunning: 'run.alreadyRunning',
  runExecMissing: 'run.execMissing',
  runExecLaunchResolve: 'run.execLaunchResolve',
  runNotRunning: 'run.notRunning',
  runNotFound: 'run.notFound',
  runBadArg: 'run.badArg',
  runBadPatch: 'run.badPatch',
  runBadEnv: 'run.badEnv',
  runReservedEnv: 'run.reservedEnv',
  runBadPort: 'run.badPort',
  runOpenHttpOnly: 'run.openHttpOnly',
  runInsertConflict: 'run.insertConflict',
  // agent presets
  presetNotFound: 'preset.notFound',
  presetReadOnly: 'preset.readOnly',
  presetExists: 'preset.exists',
  presetBadId: 'preset.badId',
  presetNoUserRoot: 'preset.noUserRoot',
  presetNoPlugins: 'preset.noPlugins',
  presetBadComposition: 'preset.badComposition',
  // misc
  npmNotFound: 'npm.notFound',
  yamlInvalid: 'yaml.invalid',
  shellOpenPath: 'shell.openPath',
  trashConflict: 'trash.conflict',
} as const
