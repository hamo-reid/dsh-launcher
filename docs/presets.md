# 预设（agent preset）

「预设」页是 launcher 对 agent preset 的**整体视图**：一个 dsh 的名册、每个 preset 的四项元数据，以及它在每个 profile 下能不能跑起来。preset 的具体内容不在 launcher 里编辑。

## 1. 真相来源：两个根

dsh 自己发现 preset 的顺序（`packages/preset/agent-presets` 的 `discovery.ts`）：

| 顺序 | 根 | trust | 可写 |
|---|---|---|---|
| 1 | 安装目录里的 `@deepseek-ai/dsh-agent-presets/presets` | `system` | 否 |
| 2 | 该 dsh home 下的 `.agent-presets` | `user` | 是 |

- 内置根不是 `<install>/node_modules/<name>`：pnpm 安装下除 `dsh` 以外的包都在 `.pnpm/<pkg>@<ver>_<hash>/node_modules`（或 `.pnpm/node_modules` 提升目录）里，所以 launcher 走该 dsh 自己的 Node 解析链（`core/store/module-resolve.ts`）再拼 `presets`。
- 自建根 = `<dsh home>/.agent-presets`。launcher 启动 dsh 时把 `DSH_HOME` 设为该 dsh 的 home，所以这里写下的就是 dsh 会发现的那份。
- 同 id 时**靠前的根赢**：自建目录若与内置 preset 同名，它会被内置遮蔽（与挂载时一致），launcher 也照此显示。
- 目录名不属于 `^[a-z0-9][a-z0-9-]*$` 的一律跳过 —— 那个名字不可能成为 preset，报出来只会教人忽略标记。

## 2. `preset.yml` 契约

`preset.yml` 只承载展示信息，id 是**目录名**、trust 来自所在的根，两者都不在这里：

```yaml
name: 标准模式
description: 功能完整的编码 Agent
order: 1
```

- 三个键都可缺省；空值等于不写这一项，三项都空则**删掉整个文件**（不发布空文本）。
- `order` 是「同一来源内」的排序：小的在前，没声明的排在有声明之后，再按 id。它不是全局名次。
- 读侧一律宽松：文件缺失、YAML 坏掉、类型不对，都降级为「没有元数据」，preset 照样挂载。

## 3. 组合面与健康

`agent.cordis.yml` 是顶层行列表，每行必须带 `name`，可带 `id`、`disabled`，可以是 `group: true` + `config: [子行]`。launcher 复刻 host 的两趟判断：

1. **形状**：非列表、行不是映射、行没有 `name`、group 的 `config` 不是列表 —— 任一命中即为「不能挂载」，行上打红标。
2. **可解析**：只看**会启动**的行。`Boolean(disabled)` 为真就跳过（`disabled: 0` 是要启动的，`disabled: !!js ...` 解析成非空字符串 → 跳过）；`name` 分类与 host 一致 —— `cordis:` → builtin，`.` 开头 → 相对 preset 目录，`file:`/绝对路径 → 文件，其余 → 包名。

## 4. profile 评级

每个 preset × 每个 profile 一个等级：

| 等级 | 含义 |
|---|---|
| 可用 | 该 profile 的解析链能解析所有会启动的行 |
| 缺 N 行 | 有 N 行谁也找不到（悬浮列出 `row "id": 包名`） |
| 不可用 | composition 读不出来（缺失/坏 YAML/形状不合法），带原因 |

- **解析链**（`moduleSearchRoots`，与 profile 的层行同一套）：安装链 → 该 profile 的 `node_modules` → 共享 profiles 根 → home。这比 host 自己的健康检查更宽 —— host 只从安装链向上走 `node_modules`，因为它判的是名册而不是一次启动；两者不一致的地方恰恰是这个评级要看的东西（例如某插件只装进了某一个 profile）。
- `!!js` 的 `name` 不判定，计入「由运行时决定」：宁可少报，也不能把 loader 能接受的 preset 判死。
- `group` 递归；判定只读文件与目录，不加载任何插件代码。

## 5. launcher 能做什么

- **改**：名称、描述、优先级 → 写该 preset 目录的 `preset.yml`。**只对自建 preset**；内置 preset 只读，编辑按钮禁用并提示。
- **复制**：把任意 preset 整个目录拷进自建根，新 id 就是新目录名。元数据随之重写：保留源的 description，name 用传入值，**丢掉源的 order**（否则副本会排进源的位次）。id 不可改名 —— 改 id 就是复制成新目录。
- **删除**：仅自建 preset，进系统回收站（可还原）。
- **打开**：打开目录（系统文件管理器）或用 VS Code 打开（`vscode://file/<path>` 协议，不 spawn `code`）。

## 6. 明确的非目标

- 不写 `agent.cordis.yml`：不做行级编辑、不做组装/骨架/素材挑选。组合面是 preset 本身，交给外部编辑器。
- 不做 launcher 全局 preset 库、商店、跨 dsh 汇总。
- 不改 `<home>/settings.yaml` 里的 `agent-presets.default`（默认 preset 的切换不在这一版里）。
- 不读 profile patch 里 `agent-presets.roots` 声明的额外根（已核对：官方安装的 13 个 bundle patch 与现有 profile patch 都没有声明）。

## 7. 代码位置

| 文件 | 职责 |
|---|---|
| `src/shared/preset.ts` | 两边共用的词汇（id 规则、文件名、根目录名、包名） |
| `src/main/core/presets/roots.ts` | 两个根、扫描、名册（健康标记、排序、first-root-wins） |
| `src/main/core/presets/rows.ts` | composition 的形状校验与行分类（复刻 host） |
| `src/main/core/presets/metadata.ts` | `preset.yml` 读取、渲染、写入 |
| `src/main/core/presets/rating.ts` | 每个 preset × 每个 profile 的评级 |
| `src/main/core/presets/authoring.ts` | 存元数据、复制、回收站删除 |
| `src/main/ipc/presets/presets.ts` | `preset:*` 六个通道 |
| `src/renderer/src/views/PresetsSection.tsx` | 一级「预设」页 |

真机核对（`official` dsh，`0.1.5`）：内置根解析到 `.pnpm/node_modules/@deepseek-ai/dsh-agent-presets/presets`，名册为 standard(1) / ptc(2) / minimal(3) / cordis(4)，两个 profile `base-web`、`hamo-studio` 全部「可用」，每个 preset 有 4–5 行因 `!!js` 门被跳过、0 行留给运行时。
