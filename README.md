# DSH Launcher

**Manage dsh profiles, plugins, and runtimes — all in one desktop app.**

> **English** · [简体中文](./README.zh-CN.md)

DSH Launcher is a Windows desktop manager for the `@deepseek-ai/dsh` CLI
runtime. It gives you a clean, dark-mode-friendly UI to create and switch dsh
**profiles**, install **plugins**, manage dsh **versions**, and run any profile.

Built with Electron, React and Ant Design.

---

## Features

- **Profiles** — Create from official templates (`base` / `web`), clone,
  soft-delete to a recoverable trash, and export/import as portable JSON.
  Every profile is a self-contained dsh instance built from *bundle layers*
  plus your own *patch layer*.
- **Plugin store** — Browse and search plugins on the npm registry, pick a
  version, and install into a profile. Local-folder plugins are supported too.
- **Runtimes** — Auto-discover installed dsh versions and pick one as active.
- **Run & console** — Launch a profile's dsh and watch its output in an
  embedded terminal console; closing the window with a running profile asks
  first instead of silently killing it.
- **Safe trash** — Deleted profiles go to `.trash` (auto-numbered); nothing is
  destroyed until you empty it.
- **Dual theme & bilingual UI** — Light/dark themes (follows system), and
  English / 简体中文.

---

## Tech Stack

Electron 33 · electron-vite 2 · React 18 · Ant Design 6 · TypeScript 5 · sql.js
(SQLite/WASM) · i18next · electron-builder · vitest. Managed with pnpm.

---

## Usage

1. **Install dsh** — the app auto-detects installed dsh runtimes (via
   `~/dsh-launcher`), or you pick one manually.
2. **Create a profile** — choose a template, give it a name. It becomes a
   self-contained dsh instance with its own bundle + patch layers.
3. **Add plugins** — search the npm registry in the Plugins view, pick a version
   and install; local folders work too.
4. **Add bundles** — add official/npm bundle layers to compose what the profile
   runs.
5. **Run it** — hit Run, watch output in the embedded console.
6. **Manage versions** — switch the active dsh version; multiple runtimes can
   coexist.

Your data (profiles, plugins, versions, settings) lives under
`~/dsh-launcher` — delete that folder to reset.

---

## Development

```sh
pnpm install     # install dependencies
pnpm run dev     # start dev server with hot reload
```

```sh
pnpm run build       # compile to out/
pnpm run start       # preview the compiled build
pnpm run typecheck   # strict type checking
pnpm test            # run unit tests
```

**Build distributables** (uses electron-builder):

```sh
pnpm run pack           # unpacked dir + portable .exe  →  release/
pnpm run pack:portable  # single-file portable .exe
pnpm run pack:dir       # unpacked directory only
```

> Packaging requires `asarUnpack: ["**/sql.js/**"]` so the SQLite WASM binary
> stays readable at runtime. No app icon is set yet — drop `build/icon.ico`
> to replace the Electron default.