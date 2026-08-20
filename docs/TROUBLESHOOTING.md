# 本地开发 / 故障排查手册（TROUBLESHOOTING）

收录本仓库/本机开发中真实遇到的故障与解法。遇到问题先按症状查这里。

---

## 1. 启动 profile 报 "Cannot find package 'xxx'"（profile link 依赖缺失）

**症状**：`run:start` 后 dsh 退出，日志里 cordis-loader 报：
`failed to import loader entry … : Cannot find package '@linxin666/…'`

**根因**：profile 的 `dependencies` 里有 `link:` 依赖（指向插件库），但该依赖在 profile 的 `node_modules` 里**链接缺失**。pnpm 依赖 `.modules.yaml` 快照判定"已安装"，**惰性不重建缺失链接**——`pnpm install`、`pnpm install --force` 都回 "Already up to date" 却仍缺失。

**修复**（用 app 捆绑 node 跑 pnpm）：
```bash
cd <profile 目录>            # 如 ~/dsh-launcher/dsh/homes/official/profiles/web
rm -rf node_modules
ELECTRON_RUN_AS_NODE=1 "<项目>/node_modules/electron/dist/electron.exe" "<项目>/node_modules/pnpm/bin/pnpm.cjs" install
# 然后用 node 验证链接可解析，别用 ls：
node -e "require.resolve('<pkg>/package.json')"
```

**预防**：启动前若不放心，先在 DSH 页用"重新安装/修复"重建 profile，或对该 plugin 执行"安装到 profile"。

---

## 2. 启动 dsh 报 "does not provide an export named 'createZstdDecompress' / 'stripTypeScriptTypes'"

**根因**：运行 dsh 的 **Node 版本过旧**。dsh 需要 Node **≥22.6**（`node:zlib` zstd、`node:module` type-strip 实验 API，Node 20 没有）。
启动 dsh 的 Node 来源：本 app 用 **用户偏好（可选系统 Node）+ 捆绑 Node 兜底**。捆绑 Node 版本由 **Electron** 决定——
- Electron 33 → Node 20.18 ❌（跑不了 dsh）
- Electron 40 → Node 24.15 ✅（满足）

**修复**：升级/确认 Electron ≥35（内置 Node 22+），当前锁定 Electron 40。若想用系统 Node 启动，在「设置 → 运行环境」开启"优先系统 Node"（会探测系统 `node --version`，>=22.6 才启用）。

**查看捆绑 Node 版本**（无需 GUI）：
```bash
ELECTRON_RUN_AS_NODE=1 pnpm exec electron -e "console.log(process.versions.node)"
```

---

## 3. 启动 dsh 报 "HMR service requires --expose-internals"

**根因**：dsh web profile 的 HMR 服务（`@deepseek-ai/cordis-plugin-hmr`）要求以 Node flag `--expose-internals` 启动。
**修复**：`run.ts` 的启动 argv 已带 `--expose-internals`（对 tsx 与 bin 模式都加）。若未来再弹类似 `--xxx is required`，在该 argv 里补对应 flag。
> 验证 flag 生效：`ELECTRON_RUN_AS_NODE=1 pnpm exec electron --expose-internals -e "require('node:internal/perf/utils')"`。

---

## 4. 用命令行 / 脚本跑 pnpm（调试）

不要依赖全局 pnpm；用项目自带的 pnpm + Electron 捆绑 node：
```bash
ELECTRON_RUN_AS_NODE=1 "<项目>/node_modules/electron/dist/electron.exe" "<项目>/node_modules/pnpm/bin/pnpm.cjs" <子命令> [--flags]
# 例：官方 dsh 网络重试安装预期会带 --fetch-retries=3
```

---

## 5. Windows bash 的 ls/路径失灵（拿不准就用 node）

- **`ls <path>/node_modules` 显示 0 条或报错**：pnpm 的 node_modules 大量是 junction/软链，Git Bash `ls` 常失灵。改用：
  ```bash
  node -e "console.log(require('fs').readdirSync('<abs路径>/node_modules'))"
  node -e "console.log(require('fs').readlinkSync('<链接路径>'))"
  ```
- **路径写法**：给 node 用 `C:/...` 或项目内 `join()`；bash 的 `/c/...` 拼给 node 会变成 `C:\c\...` 读不到。

---

## 6. 发版相关故障

见 [RELEASE.md](./RELEASE.md)。关键点：
- tag 必须 **annotated（`-a` + `-F changelog`）**，tag 页才显示说明。
- Release 正文由 `gh release create --notes-file docs/releases/<tag>.md` 写入（不要用 `softprops` 的 body 机制——其正文在本 runner 上会为空）。
- 发版完成务必 `git push origin dev:main dev:release` 对齐三分支（见 [BRANCHING.md](./BRANCHING.md)）。

---

## 快速索引
| 症状 | 章节 |
|---|---|
| 启动找不到插件包 | §1 |
| Node API 缺失 / 版本不符 | §2 |
| HMR flag 缺失 | §3 |
| 手动跑 pnpm | §4 |
| ls/路径异常 | §5 |
| 发版/Release 空正文 | §6 + RELEASE.md |