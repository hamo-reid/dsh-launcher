# 分支与发版基线模型（Branching）

本项目是单人/小团队 + GitHub 单远端仓库，采用轻量分支模型：**一条开发主干、一条发版基线、一条稳定镜像**。核心目标是让**发版基线可预期、三分支始终对齐、tag 语义清晰**——避免出现过"功能都在 dev、main/release 停在旧提交"的情况。

## 分支角色

| 分支 | 角色 | 谁打 tag / 发布 | 说明 |
|---|---|---|---|
| `dev` | 开发集散地 | 否 | 日常所有功能/修复在此合入并推送；也是默认工作分支 |
| `release` | **受保护发版基线** | **是（v* tag 从这里打）** | 只接受发版前置合并，不直接做日常开发 |
| `main` | 稳定 / 生产镜像 | 否 | 发版完成后由 `release` 快进而来；供 README badge、默认分支语义、用户拉稳定版 |

## 日常流（未发版时）

1. 新功能/修复：从 `dev` 切出 `feature/xxx` 或 `fix/xxx` 分支 → 在 `dev` 合入并推送（`git push origin dev`）。
2. 不做发版时，`main` / `release` 可以不追——但**一旦发版，必须一次性对齐三分支**（见下）。

## 发版流（以 0.1.x 为例）

完整命令见 [RELEASE.md](./RELEASE.md)；这里强调分支层面的顺序：

1. 在 `dev` 上完成 `chore(release): bump version to 0.1.x` 与 `docs/releases/v0.1.x.md`。
2. **把发版基线切到 `release`**：`git checkout release && git merge dev`（或 `git pull . dev`）——发版 tag 从 `release` 打，而非 `dev`。
3. 打 annotated tag：`git tag -a v0.1.x -F docs/releases/v0.1.x.md`。
4. 推送触发发布：`git push origin release v0.1.x`。
5. **快进对齐三分支**（最关键，防止再次"main/release 落后"）：
   ```bash
   git push origin dev:main     # dev 主干已是当前
   git push origin release:main # 或直接把 release 推到 main
   ```
6. 发布后核验 Release 正文与资产（见 RELEASE.md 发布后小节）。

> 说明：若历史原因 tag 曾打在 `dev`（如 v0.1.3 首次），本质只是 tag 落点不同，**不影响内容**；但按本文档起，应统一从 `release` 打，让 `release` 成为唯一真实"打了哪些正式版本"的分支印记。

## 硬性约定（防止重蹈覆辙）

- **tag 一定是发版基线上：** 不要从 `dev` 中途打 v*，避免 main/release 与 tag 指向不一致。
- **发版完成 = 三分支对齐：** `main`、`release`、`dev` 最终都要指向同一发版提交（它们互为祖先，可 fast-forward，不产生合并冲突）。
- **`main` 永不落后于最后发版：** 每次发布后同步，确保 clone 默认分支 = 最新稳定。
- **轻量 tag 不用：** 必须 `-a`（annotated）并 `-F` 携带 changelog，tag 页才显示说明。

## 分支操作速查

```bash
# 开发 → dev
git checkout dev && git pull origin dev
git checkout -b feature/xxx && # ... 
git push origin dev

# 发版
git checkout dev && git pull origin dev
# bump + changelog 后:
git checkout release && git merge dev
git tag -a v0.1.x -F docs/releases/v0.1.x.md
git push origin release v0.1.x
# 对齐
git push origin release:main
```

## 待清理

- 历史遗留分支 `test/coverage-gate`、`feature/logging` 已并入但未删；`main`/`release` 已对齐到 v0.1.3。发版后用 `git push origin --delete <branch>` 清理已并入的 feature 分支，保持远程干净。