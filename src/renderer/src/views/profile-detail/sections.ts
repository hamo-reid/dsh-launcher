/**
 * The workspace's section vocabulary — the left rail's keys and the section switch.
 *
 * Shared vocabulary rather than one component's private detail, because the
 * diagnostics report navigates by it: a finding jumps to the section that can fix
 * it, so both sides have to agree on the names.
 */
export type SectionKey = 'manifest' | 'deps' | 'bundles' | 'mcp' | 'patch' | 'home' | 'diagnostics'
