/**
 * Extensions IPC (public facade). The 24 `ext:*` channels used to be one 517-line
 * registrar; they are now an MCP half and a skills half, and this file keeps the
 * established `./extensions.ts` entry point working unchanged.
 */
import { registerMcpExtIpc } from './mcp.ts'
import { registerSkillsExtIpc } from './skills.ts'

export function registerExtensionsIpc(): void {
  registerMcpExtIpc()
  registerSkillsExtIpc()
}
