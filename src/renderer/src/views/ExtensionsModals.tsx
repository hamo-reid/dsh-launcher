/** Modals for the extensions surface. The implementation now lives in focused
 * modules under `./extensions/modals/`; this barrel keeps the established
 * `./ExtensionsModals.tsx` import path working for the views that consume them.
 * The MCP server form is the module's default export, as it always was. */

export { default } from './extensions/modals/McpServerModal.tsx'
export { McpSecretModal } from './extensions/modals/McpSecretModal.tsx'
export { SecretsManageModal } from './extensions/modals/SecretsManageModal.tsx'
export { SkillNameModal } from './extensions/modals/SkillNameModal.tsx'
export { SkillEditorModal } from './extensions/modals/SkillEditorModal.tsx'
