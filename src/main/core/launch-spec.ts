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
 * variable before dsh/pnpm code runs, and also patches `node:child_process` so
 * any child those tools spawn with `process.execPath` (the Electron binary)
 * gets the variable injected back — otherwise an internal `fork`/`spawn` would
 * relaunch the full launcher app instead of a Node process. Keeping the shim as
 * a data URL means there is no file to ship, resolve, or unpack from the asar,
 * and it works identically in dev and packaged builds. System `node` needs
 * neither the variable nor the shim.
 */

import type { LaunchEntry } from './dsh.ts'

/**
 * Body of the cleanup + child-spawn shim {@link ELECTRON_NODE_SHIM} runs in the
 * bundled child (dsh / pnpm) before its own code:
 *
 * 1. drops `ELECTRON_RUN_AS_NODE` from THIS process, so editors and other
 *    grandchildren the harness launches do not inherit Electron-as-node mode
 *    (an inherited variable made VS Code / Cursor boot as Node and exit);
 * 2. patches `node:child_process` so any child spawned with `process.execPath`
 *    (the Electron binary) gets `ELECTRON_RUN_AS_NODE=1` injected back. Only
 *    children that ARE the Electron binary are touched — editors launched by
 *    their own exe stay clean.
 */
const ELECTRON_NODE_SHIM_SOURCE = `
delete process.env.ELECTRON_RUN_AS_NODE;
const cp = typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule('node:child_process') : null;
if (cp && !cp.__dshNodeShim) {
  cp.__dshNodeShim = true;
  const exe = process.execPath;
  const isExe = (p) => typeof p === 'string' && p.toLowerCase() === exe.toLowerCase();
  const flag = (env) => Object.assign({}, env === undefined ? process.env : env, { ELECTRON_RUN_AS_NODE: '1' });
  // Insert/extend an options object carrying the flag at args[optsIndex].
  const addFlag = (args, argsIsArray) => {
    const optsIndex = argsIsArray ? 2 : 1;
    const cur = args[optsIndex];
    const curIsObj = cur !== null && typeof cur === 'object';
    const merged = Object.assign({}, curIsObj ? cur : {}, { env: flag(curIsObj ? cur.env : undefined) });
    if (cur === undefined || curIsObj) args[optsIndex] = merged;
    else args.splice(optsIndex, 0, merged);
  };
  const patch = (name, always) => {
    const orig = cp[name];
    if (typeof orig !== 'function') return;
    cp[name] = function (...args) {
      if (always || isExe(args[0])) addFlag(args, Array.isArray(args[1]));
      return orig.apply(this, args);
    };
  };
  patch('spawn', false);
  patch('spawnSync', false);
  patch('execFile', false);
  patch('execFileSync', false);
  patch('fork', true);
}
`

/** Inline ESM `data:` URL preloading {@link ELECTRON_NODE_SHIM_SOURCE}. Built at
 * module load so it carries no filesystem path (works identically in dev and the
 * packaged asar). */
export const ELECTRON_NODE_SHIM =
  `data:text/javascript,${encodeURIComponent(ELECTRON_NODE_SHIM_SOURCE)}`

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
