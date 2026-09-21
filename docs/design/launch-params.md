# 启动参数设计（Launch Parameters）

> 状态：第一期已实现（`feat/multi-run`）
> 关联：`docs/design/multi-run.md`、`src/main/core/profile/launch-spec.ts`、`src/main/core/profile/launch-options.ts`
> 界面：运行页「高级启动参数」

## 1. 背景

多进程落地后，「同一 profile 单实例」只规避了同 profile 的端口/数据竞争；
**不同 web profile 并行时仍可能抢同一个 web server 端口**。同时 launcher
此前把启动命令写死为：

```
<node> [--import <shim>] --expose-internals [--import tsx/esm] <entry> --profile <name>
```

用户既不能传应用参数，也不能加 `--patch` 覆盖层或自定义环境变量。

## 2. dsh 实际接受的启动参数（已核对本机 0.1.5-rc.2）

`@deepseek-ai/dsh/lib/bin.js` 的 commander 定义：

| 参数 | 说明 |
|---|---|
| `--profile <name>` | 要启动的 profile（必填，launcher 拥有） |
| `[args...]` | **`--profile` 之后的位置参数，原样透传给被启动应用** |
| `--patch <path>` | 额外 patch 覆盖层，**可重复**，叠加在 profile 层与 user 层之后（launcher 拥有） |
| `--from-default-profile <name>` | 从内置模板初始化新 profile（launcher 不暴露） |
| `--dump-config` / `--dump-default-config` | 打印配置树并退出（诊断） |

web 应用自身（`@deepseek-ai/dsh-web-app/startup`）解析 `--host` / `--port` /
`--no-open` / `--trusted-host` 这些**应用级 flag**，并据此提供 webserver 的
host/port（`--port 0` = 由系统分配空闲端口）。

> **端口不走 patch**：`webserver` 行的 config 会被 patch **整体替换**，只改 port
> 必须重述 host/compression 等键，跨版本极易失配。正确做法是把 `--port <n>`
> 追加为应用参数（见 §4）。环境变量如 `DSH_TELEMETRY_DISABLED` 由 dsh 直接读
> `process.env`，注入子进程环境即生效。

## 3. 设计目标与边界

- 单次启动可提供四类参数：**附加 app 参数 / `--patch` 覆盖 / 环境变量 / Web 端口**。
- 参数作为 **argv 数组**传递，永不经过 shell —— 无注入面。
- 保护 launcher 不变量：`--profile`、`--patch` 等 launcher flag 不允许出现在
  透传参数里（否则可静默改 profile）；保留环境键不可覆盖。
- **按 profile 持久记住默认参数**，下次启动自动回填；不填时命令与旧行为逐字节一致。
- 参数存 app 设置（键 `<dshId>::<profile>`），**不写进 profile 的 `package.json`**，
  因此机器相关的 patch 路径不会随 profile 导入/导出/迁移外泄。

## 4. 数据模型与组装

```ts
// src/shared/types.ts
export interface LaunchOptions {
  args?: string[]                 // --profile 之后的透传参数
  patches?: string[]              // 可重复的 --patch <file>
  env?: Record<string, string>    // 额外子进程环境变量
  port?: number                   // 便捷字段，编译为 --port <n>
}
```

`core/profile/launch-options.ts` 负责归一化/校验（`sanitizeLaunchOptions`），并把
便捷端口编译进透传参数（`effectiveArgs`：`[...args, '--port', String(port)]`，
端口放最后以压过手写的 `--port`）。

`buildDshLaunch` 组装顺序（关键）：

```
<node> [--import shim] --expose-internals [--import tsx/esm] <entry>
       --profile <name>
       [--patch <file> ...]
       [args...]                       # 含编译进来的 --port
```

`--patch` 是 launcher 选项，必须在应用位置参数之前，否则会被当成应用参数吞掉。

## 5. 安全校验（主进程，IPC 边界）

`core/profile/launch-options.ts`（纯函数 + patch 存在性检查）：

- `args`：拒绝含 `\0`/`\n`/`\r` 的项；拒绝 launcher 保留 flag
  `--profile`、`--patch`、`--from-default-profile`、`--dump-config`、
  `--dump-default-config`、`-V/--version`、`-h/--help`。
- `patches`：必须存在且为文件（不是目录），否则 `run.badPatch`。
- `env`：key 匹配 `^[A-Za-z_][A-Za-z0-9_]*$`；拒绝保留键
  `ELECTRON_RUN_AS_NODE`、`DSH_HOME`、`NODE_OPTIONS`、`NODE_PATH`、`PATH`
  （防 shim 失效 / 劫持 Node 解析 / 换 PATH）；值拒绝控制字符。
- `port`：整数且 `0..65535`。

错误码：`run.badArg`、`run.badPatch`、`run.badEnv`、`run.reservedEnv`、`run.badPort`。

## 6. 持久化

- 键：`<dshId>::<profile>`，存于 `AppSettings.launchOptions` / `runModes`
  （`appState.launchOptionsKey / readLaunchOptions / writeLaunchOptions /
  readRunMode / writeRunMode`）。
- 启动时：`run:start` 解析出的模式与显式传入的 options **写回**为该 (dsh, profile)
  默认值；省略则读取已存默认值。
- 也可只保存不启动：`run:setDefaults(dshId, profile, { mode, options })`。

## 7. IPC / API

| 通道 | 签名 | 说明 |
|---|---|---|
| `run:start` | `(profile, mode?, options?, dshId?) → { id }` | 校验并持久化，再启动；dshId 决定目标 dsh |
| `run:getDefaults` | `(dshId, profile) → { mode, options }` | 读取默认模式 + 参数 |
| `run:setDefaults` | `(dshId, profile, defaults) → boolean` | 校验并保存默认值 |
| `run:pickPatch` | `() → string` | 选 `.yml/.yaml` 覆盖文件；`''` = 取消 |
| `dsh:profiles` | `(id) → string[]` | 指定 dsh 的 profile 名（启动选择用） |

## 8. UI（运行页「高级启动参数」）

运行页顶层是两个 Tab：**启动** 与 **进程管理**（见 `multi-run.md` §4.2）。内容区为
**纯白平面**，Tab 栏带底部分界线。启动 Tab 页头右侧是**启动目标 dsh 的 Select**
（与全局 active dsh 解耦）；该 dsh 的 profile 以 `LaunchTile` 磁贴网格呈现
（名称 + bundle/依赖数）。**磁贴只有图标可点**：▶ 用已保存模式/参数直接启动，
**⋯ 打开该 profile 的启动表单**（不再有「更多参数」按钮）。表单的 **DSH/Profile
由所点磁贴固定，弹窗内不再提供选择**，只编辑模式与参数；表单在 `RunLaunchModal`
（宽度 `MODAL.narrow`，用 `ScrollModal` 承载）中：

- 顶部显示固定目标（profile + dsh），只读。
- 运行模式：应用控制台 / 系统 shell（默认沿用该 profile 上次的模式）。
- 高级启动参数（默认折叠）：附加参数、`--patch` 覆盖、Web 端口、环境变量。
- 「启动」时校验并持久化为该 profile 的默认参数；也可「保存为默认参数」。
- **弹窗体固定最大高度、在弹窗内部滚动**：展开高级参数时不会把弹窗撑出视口，
  也不会变成整层 mask 滚动。

> 设计原则：表单/参数等重内容放内容区或弹窗；弹窗内容再长也只滚动弹窗体本身。

## 9. 测试与验收

- `core/profile/launch-options.test.ts`：保留 flag/env 键、控制字符、缺失/目录 patch、
  端口范围、`effectiveArgs` 端口置后。
- `core/profile/launch-spec.test.ts`：无参时命令不变；patch 在 `--profile` 后、透传参数最后；
  额外 env 合并且不破坏 bundled-node 契约。
- 手工：给两个 web profile 各设不同 `--port` 并同时启动，均正常监听；`--resume`
  类参数透传生效；非法 env key 被拒并有明确提示；重启应用后默认参数仍在。

## 10. 风险

- 透传参数语义由各应用定义，launcher 只透传不解释；文档需说明「参数直接交给 dsh」。
- `--patch` 路径是机器相关的，只存 settings、不写 profile，避免污染可移植性。
- 环境变量注入靠保留键黑名单 + key 字符集收敛约束，避免 shim 被绕过。
