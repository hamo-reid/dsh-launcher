/**
 * The workspace's section vocabulary — the left rail's keys and the section switch.
 *
 * It lives here rather than in the workspace because the inspector navigates by it:
 * an issue row jumps to the section that can fix it, so the keys are shared
 * vocabulary rather than one component's private detail.
 */
export type SectionKey = 'manifest' | 'deps' | 'bundles' | 'mcp' | 'patch' | 'home' | 'diagnostics'
