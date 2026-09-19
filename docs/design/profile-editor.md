# Profile 编辑工作台设计

> 状态：已实现（P0/P1）
> 相关文件：`src/renderer/src/views/ProfileDetail.tsx`、`src/renderer/src/components/CodeEditor.tsx`、`src/renderer/src/lib/monaco.ts`、`src/main/core/profile.ts`、`src/main/ipc/profile.ts`

## 1. 背景

旧范式是「只读概览 + 弹窗下钻」：编辑几乎都藏在 `ScrollModal` 里做行级表单，
`package.json` 只读、没有源码面。可编辑性被范式本身限制。

## 2. 目标范式：三栏工作台

```
SectionHeading: <profile> · [校验启动] [重命名] [源码] [打开 patch 源文件] [重新解析 bundles]
┌───────────────┬──────────────────────────────────────┬───────────────────────┐
│ StructureNav  │ EditorPane                            │ InspectorPane          │
│ 清单 / 依赖 / │  按 section 渲染：                     │ 组合校验（常驻）        │
│ Bundle 层 /   │   清单(表单+JSON 源码) / 依赖(增删改) / │ · 解析错误             │
│ Profile Patch │   Bundle 层(排序/移除/激活) /          │ · 重复 insert id       │
│ / Home Patch  │   Profile Patch(结构化行+源码) /       │ · 缺失/未激活 bundle    │
│ / 组合与诊断  │   Home Patch(YAML 源码) / 组合与诊断    │                       │
└───────────────┴──────────────────────────────────────┴───────────────────────┘
```

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
