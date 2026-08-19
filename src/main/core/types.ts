/**
 * Shared IPC / domain types re-exported for the main process.
 *
 * The canonical definitions live in `src/shared/types.ts`; this file keeps the
 * established `../core/types.ts` import path working for existing core modules
 * and the preload boundary.
 */
export type {
  PluginRow,
  ClassifiedRow,
  ProfileLayer,
  RowCreateInput,
  PluginUsagePoint,
  InstalledOverviewRow,
  ProfileDetail,
  IpcResult,
  RunEvent,
  DshEntry,
  DshInstallResult,
  DshInstallStep,
  NpmSearchHit,
  ProfileSummary,
  ImportProfileResult,
  ComboPlugin,
  InstalledPlugin,
} from '../../shared/types.ts'