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
- **Multi-version store & download center** — Every downloaded plugin version is
  archived in its own versioned directory, so one plugin can keep many versions
  at once; an in-app download center tracks running/cancelled installs.
- **Community market** — A curated catalog of dsh plugins with search / category
  / sort, plus one-click GitHub-source and npm-source installs.
- **Runtimes & updates** — Auto-discover installed dsh versions, pick one as
  active, and update an app-managed dsh in place (home auto-backed up;
  cross-major upgrades require confirmation).
- **Version tracks** — Check for both the stable `latest` and prerelease `next`
  releases; the official-install picker tags them so you can tell them apart.
- **Profile migration** — Copy a profile into another installed dsh version and
  rebuild its bundle layers there; the source profile is kept.
- **Data export / migration** — Export a dsh's profiles and home data to a zip,
  restore from an archive, or migrate directly between installed versions.
- **Run, console & tray** — Launch a profile's dsh and watch its output in an
  embedded terminal console; the tray shows live run status and elapsed time.
  Closing the window asks whether to minimize to the tray or quit (with a
  "don't ask again" option) instead of silently killing a running profile.
- **Safe trash** — Deleted profiles go to `.trash` (auto-numbered); nothing is
  destroyed until you empty it.
- **Dual theme & bilingual UI** — Light/dark themes (follows system), and
  English / 简体中文.

---

## Tech Stack

Electron 40 · electron-vite 2 · React 18 · Ant Design 6 · TypeScript 5 · sql.js
(SQLite/WASM) · i18next · semver · electron-builder · vitest. Managed with pnpm.

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
> stays readable at runtime. The app icon ships at `build/icon.ico`.