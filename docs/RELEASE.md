# 发版流程（Release）· DSH Launcher

`release.yml` 在**推送 `v*` tag** 时触发：完整检查 → electron-builder 打包 Windows
分发物（portable 单文件 + win-unpacked 目录 zip）→ 创建 GitHub Release 并上传。
tag 版本必须与 `package.json` 的 `version` 一致（workflow 会校验）。

每一次发版都有**一份中英文 changelog**（中文在前），作为**唯一来源**同时喂给：

- **annotated tag 的 message** → GitHub **tag 页面**显示版本说明；
- **GitHub Release 的正文（`body_file`）** → **Release 页面**显示同一份。

所以两处永远一致。改版说明 = `docs/releases/v0.1.3.md`（文件名即 tag 名）。

## 步骤

```bash
# 0) 确保基于最新 dev
git checkout dev && git pull origin dev

# 1) bump 版本（示例发 0.1.3）
#    手动把 package.json 的 version 改为 0.1.3

# 2) 撰写 / 更新本版 changelog（中英、中文在前，按文件顶部模板）
#    docs/releases/v0.1.3.md

# 3) 提交（版本 + changelog）
git add package.json docs/releases/v0.1.3.md
git commit -m "chore(release): bump version to 0.1.3"

# 4) 打 ANNOTATED tag，message 直接读该 changelog（重要：必须 -a，tag 页才显示）
git tag -a v0.1.3 -F docs/releases/v0.1.3.md

# 5) 推送分支 + tag（推送 tag 即触发流水线）
git push origin dev
git push origin v0.1.3
```

## 注意事项

- **必须用 annotated tag（`-a`）**：轻量 tag 在 GitHub 的 tag 页面不显示 message。
  Release 正文由 workflow 读 `docs/releases/<tag>.md`，与 tag message 保持一致。
- 每次发版前确认 `docs/releases/v0.1.x.md` 存在，且 `package.json` 版本、tag、文件名三者一致。
- changelog 至少要覆盖：功能改动、Bug 修复、优化、工程/架构改动。