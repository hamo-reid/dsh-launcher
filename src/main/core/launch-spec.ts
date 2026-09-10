/**
 * Assemble the node child commands the launcher spawns (dsh, pnpm) in one place.
 *
 * The bundled Node is the app's own Electron binary run under
 * `ELECTRON_RUN_AS_NODE=1`. That variable must reach the Electron process itself
 * — it is what makes Electron boot as plain Node — but it must NOT survive into
 * the child's own children: harness code (e.g. the powershell `Invoke-Item` used
 * to open the settings document) spawns with an inherited environment, so any
 * Electron editor it launches would start in Node mode and exit immediately.
 *
 * A bundled child therefore gets an inline `data:` preload that deletes the
 * variable before dsh/pnpm code runs. Keeping the shim as a data URL means there
 * is no file to ship, resolve, or unpack from the asar, and it works identically
 * in dev and packaged builds. System `node` needs neither the variable nor the
 * shim.
 */

import type { LaunchEntry } from './dsh.ts'

/**
 * Preload module that clears `ELECTRON_RUN_AS_NODE` in the process that runs it.
 * Built as an inline ESM `data:` URL so it needs no filesystem path.
 */
export const ELECTRON_NODE_SHIM =
  'data:text/javascript,delete process.env.ELECTRON_RUN_AS_NODE'

/** Node executable chosen for a child: a system `node` or the bundled Electron. */
export interface NodeTarget {
  exe: string
  /** True when `exe` is the app's Electron binary and must run as Node. */
  bundled: boolean
}

/** A ready-to-spawn command: executable, argv, and the child environment. */
export interface LaunchSpec {
  exe: string
  argv: string[]
  env: NodeJS.ProcessEnv
}

/**
 * Build the environment for a node child. Always drops a stale
 * `ELECTRON_RUN_AS_NODE` inherited from the launcher's own process, then — only
 * for the bundled Electron target — sets it so Electron boots as Node.
 */
function childEnv(bundled: boolean, extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  delete env.ELECTRON_RUN_AS_NODE
  if (bundled) env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

/** Node preload flags for the chosen target: the cleanup shim first, bundled only. */
function preloadArgs(bundled: boolean): string[] {
  return bundled ? ['--import', ELECTRON_NODE_SHIM] : []
}

/** Inputs for the dsh launch command. */
export interface DshLaunchInput {
  /** Resolved dsh entry (script + loader mode + cwd). */
  launch: LaunchEntry
  /** dsh home exported to the child as `DSH_HOME`. */
  home: string
  node: NodeTarget
  profile: string
}

/**
 * The exact argv/env to launch dsh: cleanup shim (bundled) → `--expose-internals`
 * (required by the HMR service in web profiles) → the tsx loader for a source
 * checkout → the entry script → the profile selector.
 */
export function buildDshLaunch({ launch, home, node, profile }: DshLaunchInput): LaunchSpec {
  const head = [...preloadArgs(node.bundled), '--expose-internals']
  const argv = launch.tsx
    ? [...head, '--import', 'tsx/esm', launch.script, '--profile', profile]
    : [...head, launch.script, '--profile', profile]
  return { exe: node.exe, argv, env: childEnv(node.bundled, { DSH_HOME: home }) }
}

/** Inputs for launching a node script (pnpm) with the same cleanup contract. */
export interface NodeScriptLaunchInput {
  node: NodeTarget
  script: string
  args: readonly string[]
}

/** Launch a node script (pnpm): preload shim (bundled) → script → args. */
export function buildNodeScriptLaunch({ node, script, args }: NodeScriptLaunchInput): LaunchSpec {
  return {
    exe: node.exe,
    argv: [...preloadArgs(node.bundled), script, ...args],
    env: childEnv(node.bundled, {}),
  }
}
