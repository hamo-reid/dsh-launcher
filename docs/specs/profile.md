# 规范 · Profile 布局与所有权

> 适用范围：`src/main/core/profile/**`、`src/main/core/store/**`、`src/main/ipc/dsh/**`、profile 相关的渲染层
> 定位：**profile 落盘位置与写入契约的唯一规范**。历史取舍、实施计划、待办见 git 历史。

## 1. 位置：只有一个根

宿主 `dsh` 对 profile 只有一条约定：

```
<DSH_HOME>/profiles/<name>
```

- `$DSH_HOME` 解析顺序：configured > `$DSH_HOME` > `~/.dsh`。
- 宿主没有 profiles-dir 覆盖开关，Launcher 也不引入。

**P1** 任何 profile 路径都必须由 `DshContext.home` 派生（`profilesDir(ctx)` /
`profileDir(ctx, name)`），不得引入第二个根。

**P2** 启动命令的 `DSH_HOME` 必须等于 `entry.home`：`DSH_HOME=<home> dsh --profile
<name>` 与 Launcher 启动读到的必须是同一份 profile。

**P3** 旧设置里的 `profilesDir` 一律忽略（`profilesRootFor` / `effectiveProfileDir`
不读它）。`dsh:list` 只在它不同于 `<home>/profiles` **且该目录仍存在**时返回
`legacyProfilesDir` 供页面提示；**不做自动搬迁**，避免误合并 / 误删。

## 2. 落盘归属

| 数据 | 位置 | 谁读 |
|---|---|---|
| profile 目录 / 清单 / 用户 patch | `<home>/profiles/<name>/…` | 宿主 + Launcher（规范格式） |
| 机器级 home patch | `<home>/cordis.patch.yml` | 宿主 + Launcher |
| 启动参数（args / patches / env / port）、上次运行模式 | Launcher 设置（`launchOptions` / `runModes`） | 仅 Launcher；只在 spawn 时作为参数传入 |
| 回收站 | `<home>/profiles/.trash` | 仅 Launcher（宿主不枚举 profile） |
| 插件库 / 技能库 / dsh 版本库 | Launcher 数据根（`dataRoot`，默认 `userData`） | 仅 Launcher |
| 设置数据库 / 日志 / 导入临时目录 | Launcher `userData` | 仅 Launcher |

**P4** Launcher 专有状态（启动参数、上次运行模式、各库、设置、日志）只存自己的设置或
数据根，**不落进 profile**。

**P5** `dataRoot` 只覆盖 Launcher 私有目录（插件库 / 技能库 / dsh 版本库）；profile
位置与它无关，恒为 `<home>/profiles`。

## 3. 清单字段（严格按宿主契约）

- **bundle patch 文件名**：由 bundle 包的 `dsh.bundle.patch` 声明（宿主
  `loadProfileDirectory` 契约）。Launcher 的组合层 / 插件列表据此解析，缺失时回退历史
  默认 `cordis.patch.yml`。bundle 判定同样以该键是否存在为准（对齐宿主 `exportsPatch`）。
- **`dsh.profile.patchReload`**：宿主据此选择 patch 文件生命周期（`live` 热重载 /
  `startup` 只读一次）。创建 / 导入 profile 时显式写入（自定义 profile 默认 `live`），
  导出时经 `ProfileExport.patchReload` 携带（可选、向后兼容）。
- **保留名**：`acp` / `web` / `headless` / `sdk` / `sdk-minimal` 是宿主内置模板名
  （`PROFILE_TEMPLATES`）。Launcher 拒绝用这些名字创建 / 克隆 / 导入并给出提示，规则见
  `src/shared/profile-name.ts`。

## 4. 写入契约

- **先校验后写，写完复读验证**：manifest JSON 形状、patch 顶层数组。
- **只写宿主可识别的规范字段**（`package.json` / `cordis.patch.yml` /
  `pnpm-workspace.yaml`），保证直接启动 dsh 的行为不变。
- **机器相关的路径不进 profile 补丁**：绝对路径会随 profile 导出 / 迁移跑到别的机器上。
- **patch 行级编辑**：只改目标行的行区间，文件内注释与手写行原样保留；`insert:` 的子行
  删光时连带删掉 `- insert:` 头。
- **patch 行 id 走白名单**，不接受任意 id。
- **`!!js` 只读**：可解析，永不 dump 回 js-yaml。
- **跨 profile 复制 / 移动 patch**：按行 id 合并到目标 profile，写前复验；移动则清空源行。
- **依赖编辑**：改 `package.json` → `pnpm install` → `reconcileBundles`（声明
  `dsh.bundle.patch` 的依赖自动激活为层）。
- **重命名**：禁止对运行中的 profile 执行；保留名不可用。

## 5. 启动前预检（重复 insert id）

宿主按 **bundle 层 → profile → home → `--patch`** 的顺序应用各层的 `insert`，同一
loader entry id 被插入两次会以 `duplicate loader entry id` 硬失败。

- `findInsertConflicts`（`core/store/combo.ts`）在 `run:start` 前复算一次，发现重复返回
  `run.insertConflict` 并点名冲突的层；Profile 详情页展示同一告警，便于启动前发现。
- `config` / `disabled` 这类 id 覆盖型 patch 允许跨层重复，不计入。
- 典型冲突：一个 profile 同时含 `@deepseek-ai/dsh-web-app` 与某个自带官方 roster 的替代
  app bundle。

## 6. 编辑面契约

Profile 详情是**三栏工作台**，不是「只读概览 + 弹窗下钻」：

```
SectionHeading（全宽，只放全局操作）
[NavList 清单 / 依赖 / Bundle 层 / Profile Patch / Home Patch / 诊断 ●✓]
[Panel    区名 + 区级操作；源码区用 Panel fill + CodeEditor height=100%]
[Inspector 可折叠：通过 / 问题（N）、组合缩略、问题项可点击跳转]
```

- 三个栏各自滚动，无嵌套滚动条。
- 弹窗只用于：行编辑（config / insert）、新建行、重命名、复制 / 移动 patch、创建 / 导入。
- 源码面用本地 Monaco（不用 CDN），懒加载、独立 chunk，主题随 `ThemeProvider`。

## 7. 组合判定的锚：profile

**P6** 对组合、依赖或清单的判定与诊断必须带上目标 profile —— 解析链的锚是
**`(dsh, profile)`**，不是 dsh。落点：`DiagnoseOptions.profile`、`listMcpServers(ctx, profile)`、
`skillRoots(ctx, { profile })`。

脱离 profile 判定不是「少一层信息」，而是**误报**：`preSnapshotChecks` 曾在一个没有 profile 的
组合上判定，把一个在 `hamo-studio` 里跑得好好的 monorepo 聚合包报成「27 个 entry id 未知 +
3 个包无法解析」，带上该 profile 则 0 blocker（`4fe1e65`）。反向也成立：没有 profile 时该给
「这个 dsh 的机器级答案」，而不是猜某个 preset 层（`skillRoots(ctx)` 不产出 preset 根）。

## 8. 插件库：路径由谁拼、版本由谁认

**P7** 插件库里每一个**由外部字符串拼出的目录名**都必须在**拼路径处**过守卫，不能只依赖 IPC 边界：
同一个字段会在多条路径上被拼装，边界只是其中一条入口。已知的拼装点与取值来源：

| 路径 | 段 | 取值来源 | 守卫 |
|---|---|---|---|
| `archive/<name>/<version>/` | name / version | IPC 入参；`github:` / 本地 zip / 文件夹包的 `package.json`；dev 包 | `pathIdentifierInvalid` / `versionInvalid`（`store/install.ts`） |
| `.trash/<name>@<version>` | name / version | 同上 | 同上（与 `dest` 同一变量、同一处校验） |
| `.pack/<name>` | name | dev 包自己的 `package.json`（`packDevPackage`） | `pathIdentifierInvalid` |
| `.import/<stem>` | stem | 用户所选 zip 的**文件名**去掉 `.zip` 后缀（`addLocalPlugin`） | `pathIdentifierInvalid` |

判据不是「含 `/` 就危险」，而是**这一段能不能让路径塌回某个已存在的祖先**：`.`、`..` 以及任意长度的
纯点号都能（`join('archive', '.', '1.0.0')` 就是 `archive/1.0.0`，`join('archive', 'pkg', '..')` 是整个
`archive/`；文件名 `...zip` 去掉后缀恰好是 `..`，于是 `.import/..` 就是 store 根）。所以
`pathIdentifierInvalid` 拒绝一切纯点号 token，`versionInvalid` 另外拒绝含 `..` 的值。这些路径随后都由
`rmSync(…, { recursive: true })` 清理过（替换归档、清 pack 目录、准备解压目录），放行一段就等于放行
一次递归删除。scoped 包名里的那**一个** `/`（`@scope/name`）是唯一合法的分隔符，它只让路径多嵌套一层。

**P8** 报告与切换所用的版本必须是**本次实际归档的那个版本**，不得用 `latestStoreVersion(…)` 反推：
它回答的是「库里最高的版本」。库中已有更高版本时（已发布的 `2.0.0` 与本地开发中的 `1.0.0` 并存），
反推会把 profile 切到**另一个构建**，并把这个号写进返回字段与提示文案，而所有消息都显示成功。
`installSource` 在成功返回里带回 `version`（`InstallResult`），`snapshotDevPlugin` 用它而不是再查一次库。