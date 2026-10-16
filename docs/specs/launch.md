# 规范 · 启动与运行

> 适用范围：`src/main/core/profile/launch-spec.ts`、`launch-options.ts`、`src/main/core/shared/run-registry.ts`、`src/main/ipc/dsh/run.ts`、`src/renderer/src/views/RunsSection.tsx`
> 定位：**启动命令组装、参数校验、多进程运行契约的唯一规范**。

## 1. 命令组装（顺序即契约）

```
<node> [--import shim] --expose-internals [--import tsx/esm] <entry>
       --profile <name>
       [--patch <file> ...]
       [args...]          # --port <n> 编译在这里的末尾
```

- `--patch` 是 Launcher 选项，**必须排在应用位置参数之前**，否则会被 dsh 当作应用参数吞掉。
- 参数以 **argv 数组**传递，永不经过 shell —— 无注入面。
- 不传任何附加参数时，命令与旧行为逐字节一致。

## 2. dsh 接受的启动参数

| 参数 | 说明 |
|---|---|
| `--profile <name>` | 要启动的 profile，必填，Launcher 拥有 |
| `[args...]` | `--profile` 之后的位置参数，**原样透传**给被启动应用 |
| `--patch <path>` | 额外 patch 覆盖层，**可重复**，叠加在 profile 层与 user 层之后；Launcher 拥有 |
| `--from-default-profile <name>` | 从内置模板初始化新 profile；Launcher 不暴露 |
| `--dump-config` / `--dump-default-config` | 打印配置树后退出（诊断） |

web 应用自身解析 `--host` / `--port` / `--no-open` / `--trusted-host`，其中
`--port 0` 表示由系统分配空闲端口。

**端口不走 patch**：`webserver` 行的 config 会被 patch **整体替换**，只改 port 必须重述
host / compression 等键，跨版本极易失配 —— 端口一律作为应用参数 `--port <n>` 追加。

## 3. 数据模型

```ts
export interface LaunchOptions {
  args?: string[]              // --profile 之后的透传参数
  patches?: string[]           // 可重复的 --patch <file>
  env?: Record<string, string> // 额外子进程环境变量
  port?: number                // 便捷字段，编译为 --port <n>
}
```

- `sanitizeLaunchOptions`（`core/profile/launch-options.ts`）负责归一化与校验。
- `effectiveArgs` = `[...args, '--port', String(port)]` —— 端口放最后，以压过手写的
  `--port`。

## 4. 校验（主进程，IPC 边界）

| 字段 | 规则 | 错误码 |
|---|---|---|
| `args` | 拒绝含 `\0` / `\n` / `\r` 的项；拒绝 Launcher 保留 flag：`--profile`、`--patch`、`--from-default-profile`、`--dump-config`、`--dump-default-config`、`-V/--version`、`-h/--help` | `run.badArg` |
| `patches` | 必须存在且为**文件**（不是目录） | `run.badPatch` |
| `env` | key 匹配 `^[A-Za-z_][A-Za-z0-9_]*$`；值拒绝控制字符 | `run.badEnv` |
| `env` 保留键 | `ELECTRON_RUN_AS_NODE`、`DSH_HOME`、`NODE_OPTIONS`、`NODE_PATH`、`PATH` 不可覆盖（防 shim 失效 / 劫持 Node 解析 / 换 PATH） | `run.reservedEnv` |
| `port` | 整数，`0..65535` | `run.badPort` |

其余运行错误码：`run.alreadyRunning`、`run.notFound`、`run.insertConflict`
（后者见 [profile 规范](./profile.md) §5）。

## 5. 并发模型

- **并发粒度**：不同 `(dshId, profile)` 可并行；**同一对只允许一个实例** —— `run:start`
  先扫注册表，命中即返回 `E.runAlreadyRunning`。这样规避端口冲突与同一 home 的数据竞争；
  同名 profile 在不同 dsh 下互不干扰。
- **不设上限**：完全由用户控制，不做资源保护 / 排队。
- **运行 id**：`nextRunId(profile, ++seq)` —— 单调自增序号而非时间戳，便于稳定排序与测试。
- 纯决策逻辑（id 生成、去重判断、时长格式化）在 `src/main/core/shared/run-registry.ts`，
  **不依赖 Electron 与子进程**，纳入 core 单测。

## 6. 运行快照与事件

```ts
export type RunMode = 'app' | 'shell'

export interface RunInfo {
  id: string          // 稳定运行 id，如 `<profile>#3`
  dshId: string
  dshName: string
  profile: string
  mode: RunMode
  startedAt: number
  command: string
  status: 'running' | 'exited'
  code?: number | null
  signal?: string | null
}

export type RunEvent =
  | { type: 'started'; run: RunInfo }
  | { type: 'output'; id: string; line: string }
  | { type: 'exited'; id: string; profile: string; code: number | null; signal: NodeJS.Signals | null; command: string }
```

- `RunInfo` **不含日志正文**：日志按 id 用 `run:logs` 按需拉取，避免把每份 512KB 缓冲区
  塞进每次列表推送。
- 每个进程一份独立的滚动日志缓冲（cap 512KB）。

## 7. IPC 契约

| 通道 | 签名 | 说明 |
|---|---|---|
| `run:start` | `(profile, mode?, options?, dshId?) → { id }` | 校验 + 持久化默认值 + 启动 |
| `run:stop` | `(id) → boolean` | 中止指定运行 |
| `run:list` | `() → RunInfo[]` | 运行快照列表 |
| `run:logs` | `(id) → string` | 指定运行的日志 |
| `run:input` | `(id, line)` | 向指定运行写 stdin |
| `run:getDefaults` | `(dshId, profile) → { mode, options }` | 默认模式 + 参数 |
| `run:setDefaults` | `(dshId, profile, defaults) → boolean` | 只存不启动 |
| `run:pickPatch` | `() → string` | 选 `.yml/.yaml` 覆盖文件；`''` = 取消 |
| `run:event` | `onEvent(cb)` | 事件携带 `id` |
| `dsh:profiles` | `(id) → string[]` | 指定 dsh 的 profile 名（启动选择用） |

## 8. 生命周期与聚合

```
run:start
  ├─ 解析目标 dsh（显式 dshId，缺省回落到 active）
  ├─ 校验可执行文件
  ├─ 按 (dshId, profile) 去重检查
  ├─ spawn（app: pipe / shell: 终端窗口）
  └─ runs.set(id, …) → notifyRunState() → broadcast started
child close / error
  ├─ stopping ? code=0 : 原码
  └─ runs.delete(id) → notifyRunState() → broadcast exited
```

- **终止**：`stopRun(id)` 先置 `stopping`，再 `taskkill /T /F`（Windows）或 `kill`；
  `stopAllRuns()` 供关窗与退出托盘统一清理。
- **托盘**：0 个 → `空闲`；1 个 → `运行中：a · 3 分 12 秒`；多个 →
  `运行中 3 个：a、b、c`，tooltip 同步。
- **关窗守卫**：`window:askClose` 负载为 `{ running: string[] }`；「不再询问」分支一次性
  终止全部运行项。
- **退出**：托盘退出与 `window:chooseClose('quit')` 都是 `stopAllRuns()` 后 `app.quit()`。

## 9. 持久化

- 键：`<dshId>::<profile>`，存于 `AppSettings.launchOptions` / `runModes`
  （`readLaunchOptions` / `writeLaunchOptions` / `readRunMode` / `writeRunMode`）。
- `run:start` 把解析出的模式与 options **写回**为该 (dsh, profile) 的默认值；省略则读取
  已存默认值。
- 参数与默认模式**只存 Launcher 设置**，不写进 profile（见
  [profile 规范](./profile.md) P4）。

## 10. UI 契约

- 顶部页签顺序 `DSH · 运行 · Profile · 插件 · 设置 · 关于`，默认落在**运行**。
- **Profile 页是纯管理页**：删除启动 / 中止条、内嵌 `RunConsole`、`shell` 勾选框与
  运行态依赖；只保留列表 / 详情 / 克隆 / 新建 / 导入导出 / 迁移 / 回收站。
- 运行页两个 Tab（`Tabs` + `.pm-fill-tabs`，撑满高度、各 pane 自管滚动）：
  - **启动**：左栏是本页局部的 **DSH 卡片列表**（`NavList`，与全局 active dsh 解耦）——
    不是下拉框：一张 install 一张卡（标题 = 名，meta = 版本，无版本显示「未知」，有活跃进程
    时加「运行中」标记），点卡片即切换右侧；右栏是该 dsh 的 profile，以 `LaunchTile` 磁贴
    呈现（名称 + `N bundle · M 依赖`）；**只有图标可点** —— ▶ 按已保存的模式 / 参数启动
    **并直接切到「进程管理」**（启动被拒则留在本页，由 toast 或冲突弹窗作答），⋯ 打开参数
    弹窗。弹窗内固定 DSH / profile，不再提供选择。
  - **进程管理**：`AppShell` 左右分栏 —— 左栏是运行中 + 本次已结束（含「全部中止」），右栏
    是选中进程的控制台；未选中为空态。每张运行卡片两行：标题 = 状态点 + profile 名（**模式
    与时限不在标题行**，否则窄侧栏里名字会被挤掉），meta = `状态 · 模式 · dsh`（状态在前，
    截断时先丢的是 dsh 名而不是退出码）；操作是**图标按钮**（`aria-label` 与 tooltip 带全称）
    —— 运行中给「中止」，已结束给「重新启动」「清除」，同一动作的带字按钮在右栏页头。
    状态点三态：运行中（绿）/ 异常退出（红：非 0 码**或**有信号）/ 已结束（灰）。
- 运行中异常退出（非用户中止、非 0 码）→ `RunFailModal` 展示退出码、EADDRINUSE 端口提示、
  启动命令与完整输出。
- **shell 模式无内嵌输出**：控制台仅对 `app` 模式可用。
- 已结束进程只存在于渲染层，刷新后不恢复历史。

## 11. 明确不做

- **同 profile 多开**：需先解决端口与 home 目录竞争（注入独立 home / PORT），届时运行 id
  与去重键要相应放宽。
- **并发上限 / 排队**。
- 运行历史持久化、日志导出、进程 CPU / 内存占用。
- 跨页签联动（Profile 列表的运行中徽标 + 一键跳转）。