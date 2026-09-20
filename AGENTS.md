# AGENTS.md

Guidance for AI coding agents working in this repository.

## Hard safety rules (read first)

These exist because a real incident deleted a user's data directory — see the
post-mortem in [docs/TROUBLESHOOTING.md §7](./docs/TROUBLESHOOTING.md).

1. **Never delete with a bare `Remove-Item -Recurse -Force` / `rm -rf`.**
   Use [`scripts/safe-remove.ps1`](./scripts/safe-remove.ps1)
   (`-Path <target> -Root <allowed-root>`): it refuses any target outside the
   allowed root and supports `-WhatIf`.
2. **Never use PowerShell automatic/read-only variables as your own** —
   `$home`, `$host`, `$profile`, `$args`, `$input`, `$error`, `$matches`,
   `$psitem`, `$null`, `$true`, `$false`, and `$env:*`. Assigning to them fails
   *without stopping the script* under the default `$ErrorActionPreference`, so
   a later destructive command can act on the wrong path. Use domain prefixes
   (`$verifyRoot`, `$dataDir`, `$dshHome`).
3. **Start scripts with `$ErrorActionPreference = 'Stop'`** so a failed
   assignment or command aborts instead of falling through.
4. **Isolated tests must stay inside `$env:TEMP`.** Assert it
   (`StartsWith($env:TEMP, OrdinalIgnoreCase)`) before touching anything. The
   real data dirs — `~/dsh-launcher` and `~/.dsh` — are never test targets.
5. **Show the resolved absolute path (or run with `-WhatIf`) before any
   destructive action.**

## Project conventions

- Conventional Commits, English subjects — see [docs/COMMITTING.md](./docs/COMMITTING.md).
- Gates before committing: `pnpm typecheck`, `pnpm test`, `pnpm run build`.
- Branching / release model: [docs/BRANCHING.md](./docs/BRANCHING.md), [docs/RELEASE.md](./docs/RELEASE.md).
- Local recipes (pnpm, node, isolation, re-attaching dsh): [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md).
