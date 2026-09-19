# Profile 布局设计（与宿主一致）

> 状态：已实现
> 相关文件：`src/main/core/appState.ts`、`src/main/core/home.ts`、`src/main/ipc/dsh.ts`、`src/renderer/src/views/DshSection.tsx`

## 1. 背景

宿主 `dsh` 对 profile 只有一个约定：

```
<DSH_HOME>/profiles/<name>          # resolveProfileDir(name, home)
```

`$DSH_HOME` 由 `resolveDshHome()` 解析（`configured > $DSH_HOME > ~/.dsh`），
profile 目录固定为其下的 `profiles/`；宿主没有任何 profiles-dir 覆盖开关
（`apps/cli/src/args.ts` 只有 `--profile <name>`）。

Launcher 早期为每个 dsh 记录了一个可选的 `profilesDir` 覆盖。它与宿主冲突：
Launcher 在覆盖目录读写，宿主启动时却去 `<DSH_HOME>/profiles` 找，导致
「Launcher 里能建、宿主启动不了」的静默错配。

## 2. 决策

**profile 位置恒为 `<home>/profiles`，取消独立覆盖。** 想换位置就换 home
（也就是 `DSH_HOME`）——这正是直接启动 dsh 时同样使用的唯一开关。

保证：

- Launcher 启动传 `DSH_HOME = entry.home`；直接执行
  `DSH_HOME=<同一个 home> dsh --profile <name>` 读到的就是**同一份** profile。
- Launcher 只做**管理面**，且落盘一律用宿主规范格式（`package.json` /
  `cordis.patch.yml` / `pnpm-workspace.yaml`），因此不改变直接启动的行为。

## 3. 落盘归属

| 数据 | 位置 | 谁读 |
|---|---|---|
| profile 目录 / 清单 / 用户 patch | `<home>/profiles/<name>/…` | 宿主 + Launcher（规范格式） |
| 机器级 home patch | `<home>/cordis.patch.yml` | 宿主 + Launcher |
| 启动参数（args/patches/env/port）、上次运行模式 | Launcher 设置（`launchOptions` / `runModes`） | 仅 Launcher；只在 spawn 时作为参数传入，不写进 profile |
| 回收站 | `<home>/profiles/.trash` | 仅 Launcher（宿主不枚举 profile，无影响） |
| 插件库 / 导入临时目录 / dsh 版本库 | Launcher `userData` | 仅 Launcher |

## 4. 兼容处理（旧 `profilesDir`）

旧设置里可能残留 `profilesDir`：

- **一律忽略**：`profilesRootFor` / `effectiveProfileDir` 不再读取它。
- **页面提示**：`dsh:list` 计算 `legacyProfilesDir`（仅当该值不同于
  `<home>/profiles` **且目录仍存在**时返回）；DSH 页在「目录配置」面板显示
  警告，附可复制的路径，提示用户手动迁移到固定目录。目录被移走后提示自动消失。
- 不做自动搬迁，避免误合并/误删。

## 5. 不变量（后续改动请遵守）

1. 任何 profile 路径都必须由 `DshContext.home` 派生（`profilesDir(ctx)` /
   `profileDir(ctx, name)`），不得引入第二个根。
2. Launcher 写入 profile 的内容必须是宿主可识别的规范字段；Launcher 专有状态
   只存自己的设置或 `userData`。
3. 启动命令的 `DSH_HOME` 必须等于 `entry.home`，与直接启动保持等价。
