# Profile 编辑工作台设计

> 状态：已实现（P0/P1）
> 相关文件：`src/renderer/src/views/ProfileDetail.tsx`、`src/renderer/src/components/CodeEditor.tsx`、`src/renderer/src/lib/monaco.ts`、`src/main/core/profile.ts`、`src/main/ipc/profile.ts`

## 1. 背景

旧范式是「只读概览 + 弹窗下钻」：编辑几乎都藏在 `ScrollModal` 里做行级表单，
`package.json` 只读、没有源码面。可编辑性被范式本身限制。

## 2. 目标范式：三栏工作台

```
SectionHeading（全宽）: <profile> · [冲突 N]   [校验启动] [重命名] [打开目录] [检查器 ⏻]
┌───────────────┬──────────────────────────────────────┬───────────────────────┐
│ NavList       │ Panel（区名 + 局部操作）              │ Inspector（可折叠）    │
│ 清单          │  清单：元数据表单 + Monaco(填满高度)   │ · 通过 / 问题（N）     │
│ 依赖 (21)     │  依赖：只读行(编辑/删除) + 添加        │ · 组合缩略             │
│ Bundle 层 (4) │  Bundle：拖拽 + 重新解析 / 激活        │ · 问题项（点击跳转）   │
│ Profile Patch │  Patch：层卡 + 源码 + 复制/移动        │ · 校验 / 打开目录      │
│ Home Patch    │  Home：Monaco(填满)                   │                       │
│ 诊断 ●/✓      │  诊断：校验详情（折叠）                │                       │
└───────────────┴──────────────────────────────────────┴───────────────────────┘
```

- 页头只保留**全局操作**；区级操作在各 Panel 头部（依赖添加、bundle 重新解析/激活、
  patch 源码/复制移动、诊断校验）。
- 导航用 `NavList`：图标 + 计数/徽标（诊断：通过=绿勾，问题=红色 `Badge`）。
- 中栏每个区一个 `Panel`；源码区（清单/Home）用 `Panel fill` + `CodeEditor height="100%"`
  填满可用高度。
- 检查器**可折叠**，问题项可点击跳转到对应区；顶部显示组合缩略与快捷动作。
- 三栏各自滚动，去掉了外层滚动（无嵌套滚动条）。

弹窗只保留：行编辑（config/insert）、新建行、重命名、复制/移动 patch、创建/导入等。

## 3. 能力 → 落点

| 能力 | 实现 |
|---|---|
| 依赖编辑 | 「依赖」表单：改/删/加；`setDependency`/`removeDependency` 重写 `package.json` → `pnpm install` → `reconcileBundles`（声明 `dsh.bundle.patch` 的依赖自动激活为层） |
| 内嵌 patch 原始编辑 | Profile/Home Patch 的源码模式（Monaco，YAML）；写前 `assertPatchDocValid` + 写入验证 |
| 清单元数据 | 「清单」表单：显示名 `name`、`patchReload`；另有 JSON 源码模式（写前形状校验） |
| 手动管理 bundle | 「Bundle 层」：拖拽排序、移除、从「已安装未激活」候选中激活（`addBundle` 校验 patch 可解析） |
| 校验启动 dry-run | `validateComposition`：解析错误 + 重复 insert id + 缺失/未激活 bundle；「组合与诊断」详列 + 右栏常驻摘要 |
| 跨 profile 复制/移动 | 「Profile Patch」→ 复制/移动 patch…：按行 id 合并到目标 profile，写前复验，移动则清空源行 |

## 4. Monaco 集成要点

- 类型取自 `monaco-editor/editor/editor.api`，行为贡献取自 `editor.main`（含 YAML 基础语法与
  JSON 语言服务）；**不用 CDN**（离线 + 沙箱）。
- worker 走 Vite `?worker` 同源产物；`index.html` 的 CSP 增加
  `worker-src 'self' blob:` 与 `font-src 'self' data:`。
- `CodeEditor` 懒加载，Monaco 独立 chunk；`electron.vite.config.ts` 的
  `dropUnusedMonacoFeatures` 插件剔除未用的 TS/CSS/HTML 语言特性与 worker、
  以及未用的基础语言定义（产物 ~30MB → ~13MB）。
- 主题跟随 `ThemeProvider`（`vs` / `vs-dark`）。

## 5. 不变量

1. 所有写盘都先校验后写、写完复读验证（manifest JSON 形状 / patch 顶层数组）。
2. Launcher 只写宿主可识别的规范字段；Launcher 专有状态不落进 profile。
3. 重命名禁止运行中的 profile；保留名（`acp/web/headless/sdk/sdk-minimal`）不可用。
4. 跨 profile 传输按行 id 合并，避免重复 insert id。

## 6. 待办（后续）

- 行级选择后复制/移动（当前为整层）。
- 跨 dsh 的行级传输（整 profile 迁移已有 `mirrorProfile`）。
- 源码模式的保存前 diff（Monaco DiffEditor 已封装，尚未接入）。
- 运行中编辑的热重载提示细化。
