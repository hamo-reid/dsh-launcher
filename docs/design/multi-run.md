# 多进程运行管理设计（Multi-Run）

> 状态：设计中 → 第一期实现中
> 分支：`feat/multi-run`
> 相关文件：`src/main/ipc/dsh/run.ts`、`src/main/core/shared/run-registry.ts`、`src/renderer/src/views/RunsSection.tsx`

## 1. 背景与目标

当前应用是**严格的单进程模型**：`src/main/ipc/dsh/run.ts` 用模块级单例
`let running: RuntimeState | null` 持有唯一运行中的 dsh；托盘、关窗守卫、
`useRunRuntime` 全部假设「最多一个进程」。启动第二个 profile 会直接失败
（`run.alreadyRunning`）。

目标：

- 允许**同时运行多个 profile 的 dsh**，互不干扰。
- 新增顶部**「运行」页签**，作为多进程的统一入口：启动、切换、查看/交互控制台、中止。
- **Profile 页转为纯管理页**（列表 / 详情 / 克隆 / 导入导出 / 迁移 / 回收站），
  不再承载启动与运行控制台。
- 运行中的进程在托盘、关窗守卫、异常退出提示上都要被正确聚合。

## 2. 已确认的需求决策

| 决策点 | 结论 |
|---|---|
| 并发粒度 | **不同 (dsh, profile) 可并行；同一对只允许一个实例**（按 dsh id + profile 名去重）。规避端口冲突与同一 home 的数据竞争；同名 profile 在不同 dsh 下互不干扰。 |
| UI 主入口 | 顶部新增**「运行」页签**，启动功能迁移至此；Profile 页转为管理页。 |
| DSH 选择 | **已移除全局 active dsh**：DSH 页只做安装管理（本页查看选中），Profile 页与运行页各自选择 dsh；所有 profile/插件/回收站操作按显式 `dshId` 传参。 |
| 并发上限 | **不限制**，完全由用户控制（不做资源保护/排队）。 |
| 运行模式 | 保留 `app`（内嵌控制台）与 `shell`（系统终端）两种模式，均纳入多进程清单。 |

## 3. 架构设计

### 3.1 数据模型

主进程新增可序列化的运行快照，供列表/托盘/关窗守卫共用：

```ts
// src/shared/types.ts
export type RunMode = 'app' | 'shell'

export interface RunInfo {
  id: string                 // 稳定运行 id，如 `<profile>#3`
  dshId: string              // 所属 dsh（启动时选定）
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

> `RunInfo` 不含日志正文：日志按 id 用 `run:logs` 按需拉取，避免把每份
> 512KB 的缓冲区塞进每次列表推送。

### 3.2 主进程注册表

`run.ts` 的模块状态由单例改为注册表：

```ts
interface RuntimeState {
  id: string
  profile: string
  mode: RunMode
  child: ChildProcess
  startedAt: number
  command: string
  log: string            // 每进程独立滚动缓冲（cap 512KB）
  stopping?: boolean     // 用户主动中止标记（该次退出不算失败）
}
const runs = new Map<string, RuntimeState>()   // key = id
```

- **单实例约束**：`run:start` 先扫描 `runs`，若已有同 `(dshId, profile)` 的运行则
  返回 `E.runAlreadyRunning { profile }`。
- **目标 dsh**：`run:start` 接收可选 `dshId`；缺省回落到全局 active dsh
  （兼容旧调用）。这样运行页可在启动时选 dsh，而不改变 Profile 页的 active。
- **id 生成**：单调自增序号 `nextRunId(profile, ++seq)`；序号而非时间戳，
  便于稳定排序与测试。
- **状态订阅**：`subscribeRunState(listener: (runs: RunInfo[]) => void)`，
  启动/退出时推送；托盘消费。
- **终止**：`stopRun(id)`（置 `stopping` 后 `taskkill /T /F` 或 `kill`）、
  `stopAllRuns()`（关窗/退出托盘时统一清理）。

纯决策逻辑（id、去重判断、时长格式化）抽到
`src/main/core/shared/run-registry.ts`，不依赖 Electron/子进程，纳入 core 单测。

### 3.3 IPC 契约变更

`window.api.run` 从「单例布尔」升级为「按 id 操作」：

| 旧 | 新 | 说明 |
|---|---|---|
| `start(profile, mode?) -> boolean` | `start(profile, mode?, options?, dshId?) -> { id }` | 指定运行 id + 目标 dsh + 参数 |
| `stop() -> boolean` | `stop(id) -> boolean` | 指定运行 |
| `state() -> { running, profile? }` | `list() -> RunInfo[]` | 运行快照列表（含 dshId/dshName） |
| `logs() -> string` | `logs(id) -> string` | 指定运行日志 |
| `input(line)` | `input(id, line)` | 指定运行 stdin |
| `command() -> string` | （并入 `RunInfo.command`） | 删除 |
| — | `getDefaults(dshId, profile) -> { mode, options }` | 读取该 profile 默认模式 + 参数 |
| — | `setDefaults(dshId, profile, defaults) -> boolean` | 校验并保存默认值 |
| `dsh.list()` | 新增 `dsh.profiles(id) -> string[]` | 指定 dsh 的 profile 名（启动选择用） |
| `onEvent(cb)` | 不变，事件携带 `id` | 关联多进程 |
| `openExternal(url)` | 不变 | 全局 |

新增错误码 `run.notFound`（对已退出的 id 操作）与参数校验码
`run.badArg/badPatch/badEnv/reservedEnv/badPort`。

### 3.4 生命周期

```
run:start
  ├─ 解析目标 dsh（显式 dshId，否则 active）
  ├─ 校验可执行文件
  ├─ 按 (dshId, profile) 去重检查
  ├─ spawn（app: pipe / shell: 终端窗口）
  ├─ runs.set(id, …); notifyRunState(); broadcast started
run:event(output) ──► 每进程 log 追加 + broadcast { id, line }
child close/error
  ├─ stopping ? code=0 : 原码
  ├─ runs.delete(id); notifyRunState(); broadcast exited
```

**托盘**：0 个 → `空闲`；1 个 → `运行中：a · 3 分 12 秒`；
多个 → `运行中 3 个：a、b、c`。tooltip 同步。

**关窗守卫**：`window:askClose` 负载由 `{ running?: string }` 改为
`{ running: string[] }`；渲染层 `CloseConfirmModal` 展示聚合告警。
主进程「不再询问」分支的 `confirmTerminate` 列出全部运行项并一次性终止。

**关于「退出」**：托盘退出与 `window:chooseClose('quit')` 都改为
`stopAllRuns()` 后 `app.quit()`。

## 4. UI 方案

### 4.1 信息架构

顶部页签顺序：`DSH · 运行 · Profile · 插件 · 设置 · 关于`，默认落在**运行**。
Profile 页移除运行态 UI，成为纯管理页。

### 4.2 运行页（`RunsSection`）

顶层是**两个 Tab**（`Tabs` + `.pm-fill-tabs`，撑满高度、各 pane 自管滚动）：

```
┌ 运行 ──────────────────────────────────────────────────────────────┐
│  [ 🚀 启动 ]   [ ☰ 进程管理 ]                                       │
├────────────────────────────────────────────────────────────────────┤
│ 启动 Tab：                                                          │
│  启动进程 · 选择 profile 即按已保存参数启动         DSH [dsh ▾]      │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                │
│  │ my-web   ▶ ⋯ │ │ my-api   ▶ ⋯ │ │ test   运行中 ⋯│               │
│  │ 2b · 5d      │ │ 1b · 0d      │ │ 1b · 3d       │                │
│  └──────────────┘ └──────────────┘ └──────────────┘                │
│  （▶ 启动；⋯ 打开参数配置弹窗；无「更多参数」按钮）                 │
├────────────────────────────────────────────────────────────────────┤
│ 进程管理 Tab（AppShell 左右分栏）：                                 │
│  运行中 (2) [全部中止] │  my-web · dsh · 应用控制台      [中止]      │
│  ● my-web  app         │  ┌ RunConsole (fill) ────────────────┐    │
│    dsh · 02:13         │  │ …输出…  ❯ 输入命令…                │    │
│  ● my-api  shell       │  └────────────────────────────────────┘    │
│  ─ 已结束 ─            │  未选中：EmptyState「选择一个进程」          │
│  ○ test   app          │                                            │
│    code 0 [重启][清除] │                                            │
└────────────────────────────────────────────────────────────────────┘

参数配置弹窗 RunLaunchModal（内部滚动 ScrollModal）：
  固定目标：my-web · <dsh>          ← 由磁贴的 ⋯ 决定，弹窗内不再设置 DSH/Profile
  [应用控制台 | 系统 shell]
  ▸ 高级启动参数（附加参数 / --patch / Web 端口 / 环境变量）
  [取消] [启动]
```

> 视觉：两个 Tab 的内容区都是**纯白平面**（不再灰底 + 白块分层），Tab 栏带
> **底部分界线**；元素之间用边框/分隔线区分，而非背景色分层。

**启动 Tab**

- 页头右侧是**本页局部的 DSH Select**（启动目标，与全局 active dsh 解耦）。
- profile 以 **`LaunchTile` 磁贴**网格呈现：名称 + `N bundle · M 依赖`。
  **只有图标可点**——▶ 用已保存模式/参数启动（停留在本 Tab，可连续启动）；
  **⋯ 打开该 profile 的参数配置弹窗**。运行中的磁贴显示绿色「运行中」。
- 启动后若走弹窗（配置过参数）则切到「进程管理」Tab 并选中新进程。

**进程管理 Tab**

- `AppShell` 左右分栏：侧栏是全部运行中 + 本次已结束进程（含「全部中止」、
  每项「中止 / 重新启动 / 清除」）；内容区是选中进程的控制台（`app` 用
  `RunConsole fill`，`shell` 显示提示与命令），未选中为空态。
- 已结束进程由渲染层本地保留；刷新页面只恢复运行中的进程。

**操作优化（本期）**

- 一键重启已结束进程（沿用其 dsh + 模式 + 已保存参数）。
- 记住每个 (dsh, profile) 的上次运行模式（app/shell）。
- 进程项标注所属 DSH；「全部中止」二次确认。

**状态与反馈**

- 启动失败（`run:start` 返回错误）→ `message.error(apiErrorText)`；
  运行中异常退出（非用户中止、非 0 码）→ 复用 `RunFailModal` 展示退出码、
  EADDRINUSE 端口提示、启动命令与完整输出。
- 三态齐备：列表 loading（拉取 `run:list` 时）、空态、错误 message。

### 4.3 Profile 页变更

- 删除头部「启动/中止」条、内嵌 `RunConsole`、`shell` 勾选框、
  `RunFailModal` 与 `useRunRuntime` 依赖。
- 保留 profile 列表/详情/克隆/新建/导入导出/迁移/回收站。
- （后续可加深）profile 列表上的「运行中」徽标 + 一键跳转到运行页，
  以及 Profile 详情内的管理动作，本期先不做跨页签联动。

### 4.4 文案（i18n）

新增 `run.*` 键（zh/en 同步）：`run.tab`、`run.title`、`run.description`、
`run.startNew`、`run.modeApp`、`run.modeShell`、`run.allStop`、
`run.empty.title`、`run.empty.desc`、`run.section.active`、
`run.section.exited`、`run.clear`、`run.shellHint`、`run.notFound` 等。
沿用既有 `run.running / run.stopped / run.stop / run.shellMode /
run.inputPlaceholder / run.failTitle / run.exited / run.portInUse`。

## 5. 实施计划（分期）

**第一期（本分支）——多进程底座 + 运行页 + Profile 解耦**

1. `shared/types.ts`：`RunMode` / `RunInfo`、扩展 `RunEvent`。
2. `core/shared/run-registry.ts` + 单测：纯决策逻辑。
3. `ipc/dsh/run.ts`：注册表化，按 id 的 start/stop/list/logs/input。
4. `preload` + `shared/api.ts`：契约升级。
5. `main/index.ts`：托盘聚合、关窗守卫、退出清理。
6. 渲染层：`useRuns` hook、`RunsSection` 页、`RunsModals`（迁移 `RunFailModal`）、
   `App.tsx` 新页签、`ProfileSection` 去运行化。
7. i18n（zh/en），删除 `useRunRuntime`。

**第二期（后续）**

- Profile 列表运行中徽标 + 跨页签跳转联动。
- 运行历史持久化、日志导出、进程资源占用（CPU/内存）。
- 每个 dsh 维度的运行视图（当前先沿用 active dsh）。

## 6. 测试与验收

- `pnpm run typecheck`（node + web）通过。
- `pnpm test`：新增 `core/shared/run-registry.test.ts`；既有 core 用例不回归。
- 手工验收：
  1. 同时启动 2+ 个不同 profile（app 模式），控制台独立流式输出。
  2. 同一 profile 二次启动被拒并提示。
  3. 分别中止单个进程，其余不受影响。
  4. 关闭窗口 → 提示「N 个进程运行中」，选托盘/退出行为正确。
  5. 刷新渲染进程（`Ctrl+R`）→ 运行列表从主进程恢复。
  6. shell 模式进程出现在清单中且可中止。
  7. 亮/暗双主题下运行页对比度与选中态正常。

## 7. 风险与取舍

- **同一 (dsh, profile) 单实例**是硬约束；同名 profile 在不同 dsh 下可并行。
  若将来要「同 profile 多开」，需先解决端口与 home 目录竞争（注入独立 home/PORT），
  届时 id 与去重键要相应放宽。
- **不设上限**：用户可启动大量进程，属于既定决策；如后续需要，可在
  `run:start` 加可配置闸门而不改数据模型。
- **shell 模式无内嵌输出**：控制台仅对 app 模式可用，属现有行为延续。
- 已结束进程仅存在于渲染层，刷新后不恢复历史（第一期刻意简化）。
