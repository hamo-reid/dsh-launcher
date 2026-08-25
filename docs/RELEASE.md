# 发版流程（Release）· DSH Launcher

分支与发版基线模型见 [BRANCHING.md](./BRANCHING.md)；本文档是对应**可执行命令**。核心要点（与 BRANCHING.md 硬性约定一致）：

- **发版 tag 一律从 `release` 分支打**，不在 `dev` 打。
- **发版完成 = `main`/`release`/`dev` 三分支对齐**（`git push origin release:main`）。
- 必须用 **annotated tag（`-a`）** 并 `-F` 携带 changelog，GitHub tag 页才显示说明。

`release.yml` 在**推送 `v*` tag** 时触发：完整检查 → electron-builder 打包 Windows
分发物（portable 单文件 + win-unpacked 目录 zip）→ 创建 GitHub Release 并上传。
tag 版本必须与 `package.json` 的 `version` 一致（workflow 会校验）。

每一次发版都有**一份中英文 changelog**（中文在前），作为**唯一来源**同时喂给：

- **annotated tag 的 message** → GitHub **tag 页面**显示版本说明；
- **GitHub Release 的正文（`body_file`）** → **Release 页面**显示同一份。

所以两处永远一致。改版说明 = `docs/releases/v0.1.x.md`（文件名即 tag 名）。

## 步骤

```bash
# 0) 确保基于最新 dev
git checkout dev && git pull origin dev

# 1) bump 版本（示例发 0.1.5）
#    手动把 package.json 的 version 改为 0.1.5

# 2) 撰写 / 更新本版 changelog（中英、中文在前，按文件顶部模板）
#    docs/releases/v0.1.5.md

# 3) 提交（版本 + changelog）
git add package.json docs/releases/v0.1.5.md
git commit -m "chore(release): bump version to 0.1.5"
git push origin dev

# 4) 把发版基线切到 release —— 发版 tag 从这里打，勿在 dev 打
git checkout release && git merge dev
#    此时放行 fast-forward（release 落后于 dev），不应产生合并冲突

# 5) 打 ANNOTATED tag，message 直接读该 changelog（重要：必须 -a，tag 页才显示）
git tag -a v0.1.5 -F docs/releases/v0.1.5.md

# 6) 推送分支 + tag（推送 tag 即触发流水线）
git push origin release v0.1.5

# 7) 发版完成 = 三分支对齐（最关键，防止 main 再次落后）
git push origin release:main
```

## 注意事项

- **必须用 annotated tag（`-a`）**：轻量 tag 在 GitHub 的 tag 页面不显示 message。
  Release 正文由 workflow 读 `docs/releases/<tag>.md`，与 tag message 保持一致。
- **tag 一律从 `release` 打**，避免 main/release 与 tag 指向不一致。
- **每次发版后必须 `git push origin release:main`**，使 `main` 永不落后于最后发版
  （见 BRANCHING.md「硬性约定」）。
- 每次发版前确认 `docs/releases/v0.1.x.md` 存在，且 `package.json` 版本、tag、文件名三者一致。
- changelog 至少要覆盖：功能改动、Bug 修复、优化、工程/架构改动。

## 发布后

- 到 GitHub Releases 页确认正文与资产齐全；tag 页确认说明正常显示。
- 清理已并入但未删的 feature 分支（`git push origin --delete <branch>`），见 BRANCHING.md「待清理」。