# DSH Launcher

**在一个桌面应用里管理 dsh 的配置档、插件与运行时。**

> [English](./README.md) · **简体中文**

DSH Launcher 是 `@deepseek-ai/dsh` 命令行运行时的一款 Windows 桌面管理器。它提供一个清晰、支持暗色模式的界面，让你创建和切换 dsh **配置档**、安装**插件**、管理 dsh **版本**、并运行任意配置档。

基于 Electron、React 与 Ant Design 构建。

---

## 功能特性

- **配置档** — 从官方模板（`base` / `web`）创建、克隆、软删除到可恢复的回收站，并可导出/导入为便携式 JSON。每个配置档都是自包含的 dsh 实例，由若干 *bundle 层* 加上你自己的 *patch 层* 组成。
- **插件商店** — 在 npm 仓库上浏览、搜索插件，选择版本并安装进配置档。也支持本地文件夹插件。
- **运行时** — 自动发现已安装的 dsh 版本，并指定其中一个为激活版本。
- **运行与控制台** — 启动配置档对应的 dsh，在内嵌的终端风格控制台观察输出；有配置档运行时关闭窗口会先询问，不会静默终止。
- **安全的回收站** — 被删除的配置档进入 `.trash`（自动编号命名）；清空回收站前不会真正销毁任何东西。
- **双主题与双语界面** — 亮 / 暗主题（可跟随系统），支持英文与简体中文。

---

## 技术栈

Electron 33 · electron-vite 2 · React 18 · Ant Design 6 · TypeScript 5 · sql.js（SQLite/WASM）· i18next · electron-builder · vitest。使用 pnpm 管理。

---

## 使用方法

1. **安装 dsh** — 应用会自动检测已安装的 dsh 运行时（位于 `~/dsh-launcher`），也可手动指定。
2. **创建配置档** — 选择一个模板并命名。它会成为一个自包含的 dsh 实例，带自己的 bundle 层与 patch 层。
3. **添加插件** — 在“插件”视图搜索 npm 仓库，选版本安装；本地文件夹也可。
4. **添加 bundle 层** — 加入官方 / npm 的 bundle 层，组合配置档实际运行的内容。
5. **运行** — 点击运行，在内嵌控制台查看输出。
6. **管理版本** — 切换激活的 dsh 版本；多个运行时可共存。

你的数据（配置档、插件、版本、设置）都存放在 `~/dsh-launcher` 下——删除该目录即可完全重置。

---

## 开发

```sh
pnpm install     # 安装依赖
pnpm run dev     # 启动带热更新的开发服务器
```

```sh
pnpm run build       # 编译到 out/
pnpm run start       # 预览编译产物
pnpm run typecheck   # 严格类型检查
pnpm test            # 运行单元测试
```

**打包分发**（使用 electron-builder）：

```sh
pnpm run pack           # 未打包目录 + 便携版 .exe  →  release/
pnpm run pack:portable  # 单文件便携版 .exe
pnpm run pack:dir       # 仅未打包目录
```

> 打包需要 `asarUnpack: ["**/sql.js/**"]`，以确保 SQLite 的 WASM 二进制在运行时仍可读取。尚未设置应用图标——放入 `build/icon.ico` 即可替换 Electron 默认图标。