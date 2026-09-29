# 预设（agent preset）

「预设」页管**一个 profile** 的 agent preset：名册、四项元数据（id、名称、描述、优先级）、定义在哪里，以及它在这个 profile 下能不能用。preset 的插件列表不在 launcher 里改 —— 它就是 preset，页面只把它交给外部编辑器。

dsh 先后出过**两套 preset 模型**，页面同时服务两套，不问你正在看哪一套：

| | 目录模型（≤ `0.1.5-rc.2`） | 声明模型（`0.2.0-rc.1` 起） |
|---|---|---|
| preset 是什么 | 一个目录 | 组合层里的一行插件声明 |
| 组合定义 | `agent.cordis.yml` 的顶层行列表 | 该行 `config.plugins`（同一个行列表） |
| 显示元数据 | `preset.yml` 的 name/description/order | 该行 `config.name` / `config.description` / `config.order` |
| id | 目录名 | `config.id` |
| 从哪发现 | 扫两个根目录 | 该 profile 组合出来的补丁层 |
| 内置/自建 | `trust: system \| user` | 没有 trust：所在层即出身（bundle = 内置，profile/home = 自建） |
| 重复 id | 靠前的根赢 | dsh 直接报 `Duplicate agent preset`，靠前的声明赢 |

## 1. 判定模型：看组合里挂了谁，不看版本号

`core/presets/layers.ts` 按 profile 读它的补丁层（bundle 层 → profile 层 → home 层），扫每层里出现的插件名：

| 组合里出现 | 模型 |
|---|---|
| `@deepseek-ai/dsh-agent-preset`（或 `…-registry`） | `declaration` |
| `@deepseek-ai/dsh-agent-presets` | `directory` |
| 都没有 | `none`（页面说这个 dsh 没启用 agent preset） |

- 版本号说的是**装了什么**，组合里挂着谁说的是**跑什么**：profile 仍选中旧版 bundle、或新版装了没被组合进去时，两者不一致。判定因此按 profile 做，而不是按 dsh 做。
- 两个都在时报 `declaration`：目录包没有扫描它的 host 就只是一堆死代码，留着它证明不了什么。

## 2. 目录模型

### 2.1 两个根

dsh 自己的发现顺序（`packages/preset/agent-presets` 的 `discovery.ts`）：

| 顺序 | 根 | trust | 可写 |
|---|---|---|---|
| 1 | 安装目录里的 `@deepseek-ai/dsh-agent-presets/presets` | `system` | 否 |
| 2 | 该 dsh home 下的 `.agent-presets` | `user` | 是 |

- 内置根不是 `<install>/node_modules/<name>`：pnpm 安装下除 `dsh` 以外的包都在 `.pnpm/<pkg>@<ver>_<hash>/node_modules`（或 `.pnpm/node_modules` 提升目录）里，所以 launcher 走该 dsh 自己的 Node 解析链（`core/store/module-resolve.ts`）再拼 `presets`。
- 自建根 = `<dsh home>/.agent-presets`。launcher 启动 dsh 时把 `DSH_HOME` 设为该 dsh 的 home，所以这里写下的就是 dsh 会发现的那份。
- 同 id 时靠前的根赢：自建目录与内置 preset 同名时被内置遮蔽（与挂载一致），launcher 照此显示。
- 目录名不属于 `^[a-z0-9][a-z0-9-]*$` 的一律跳过。这种名字不可能成为 preset，报出来只会让人学会忽略提示。

### 2.2 `preset.yml` 契约

`preset.yml` 只放展示信息。id 是目录名，trust 来自所在的根，两者都不在这里：

```yaml
name: 标准模式
description: 功能完整的编码 Agent
order: 1
```

- 三个键都可缺省；空值等于不写这一项；三项都空就删掉整个文件，不发布空文本。
- `order` 只在同一份名册内排序：小的在前，没声明的排在有声明之后，再按 id。它不是全局名次。
- 读侧一律宽松：文件缺失、YAML 坏掉、类型不对，都降级为「没有元数据」，preset 照样挂载。

## 3. 声明模型

dsh `0.2.0-rc.1` 删掉了目录 preset，没有兼容读取：`packages/preset/agent-preset` 的 skill 原话是 "Nothing reads that directory any more"。现在一个 preset 是一行普通插件：

```yaml
- insert:
    - id: preset-minimal                     # loader 行 id，约定 preset-<id>
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: minimal                          # preset 身份，session 记的是它
        order: 3
        plugins:                             # 原来的 agent.cordis.yml，逐字搬过来
          - id: persona
            name: '@deepseek-ai/dsh-persona'
```

### 3.1 从哪来

内置四个（standard/ptc/minimal/cordis）现在是 `@deepseek-ai/dsh-web-app` 组合包的 `presets/<id>.patch.yml`，由 `package.json` 的 `dsh.bundle.patch` 数组排在 `cordis.patch.yml` 之后。**一个组合包可以声明多个 patch 文件**，launcher 按声明顺序全部读取（`core/store/combo.ts` 的 `resolveBundlePatches`）——只读第一个的话，这四个文件一个都看不见。

自建的声明写在**当前 profile 的 `cordis.patch.yml`**（也可以写在 home 层，或做成一个组合包装进来；launcher 只写 profile 层，因为 home 层优先级更高、会影响所有 profile）。

### 3.2 读取：按 loader 行 id 折叠

`core/presets/declaration.ts` 的 `readDeclarations` 按 dsh 的语义折叠各层：

- 出现 `@deepseek-ai/dsh-agent-preset` 的行**定义**（或替换）它这个 loader 行 id 的定义；引用同一 id 但不带 name 的行只改它的 `disabled`。**后一层赢**，这就是「这个 entry 的字段最终是最后一层写的那个值」。
- preset 身份取 `config.id`，不是 loader 行 id。两行声明同一个 preset id 就是 host 的 `Duplicate agent preset`：靠前的赢，输的那个进 `warnings` 而不是被悄悄丢掉。
- 激活不了的声明留在名册里带原因（缺 `config`、`config.id` 为空、`name`/`order` 类型不对、`plugins` 形状不合法、YAML 读不出来）。占着 id 却什么都不显示，比一个坏行更糟。
- `disabled: true`（无论写在声明行上还是后一层的覆盖行上）会让这个 preset 从名册里消失，与 host 一致。

### 3.3 写入：`plugins` 块一个字节都不动

声明行的 `config.plugins` 是真实组合文本，里面可能有 `!!js` 门和 `|` 块标量。`patch/yaml.ts` 的注释写得很清楚：`!!js` 只能以私有哨兵存活，**绝不能进 dump**。所以：

- **改描述**：只在 `config` 块里增删改 `name` / `description` / `order` 三个标量行（`patch.ts` 的 `setConfigScalar`），`plugins` 块与它周围的注释逐字保留。
- **复制**：把源声明的 `plugins:` 块整段文本切片、改缩进后放进新行（`pluginsBlockOf` + `renderDeclarationRow`），同样不重新渲染。
- **删除**：从它所在的那一层删掉这一行（`removeInsertRow`）；那一层因此没有条目时留下 `[]` 标记 —— 只剩注释的补丁文件不是合法 YAML 文档，dsh 会拒绝启动整个 profile。
- **新建的 loader 行 id 用 `local-preset-<id>`**，不是官方的 `preset-<id>`：loader 行 id 撞了会让 dsh **拒绝启动整个 profile**，而 preset id 撞了只让那一条声明失败。用 launcher 自己的命名空间，将来 dsh 新增同名内置 preset 时退化成「一个坏行」，而不是「起不来」。
- 写入前三道护栏：`config.id` 已被任何层占用、`local-preset-<id>` 行 id 已被占用、id 不合法 —— 都拒绝。
- 一份声明能否改，看它**在哪一层**：bundle 层属于部署，只读；profile / home 层是用户自己的，可改。折叠已经把「谁赢」算出来了，所以赢家天然就是该改的那一层。

## 4. 组合面与能不能挂载

行列表每行必须带 `name`，可带 `id`、`disabled`，可以是 `group: true` + `config: [子行]`。launcher 复刻 host 的两趟判断：

1. 形状：非列表、行不是映射、行没有 `name`、group 的 `config` 不是列表，命中任一就是「不能挂载」，行上打红标。
2. 可解析：只看会启动的行。`Boolean(disabled)` 为真就跳过（`disabled: 0` 是要启动的，`disabled: !!js ...` 解析成非空字符串 → 跳过）；`name` 分类与 host 一致 —— `cordis:` → builtin，`.` 开头 → 相对**声明所在的补丁文件**目录（目录模型则是相对 preset 目录），`file:`/绝对路径 → 文件，其余 → 包名。

## 5. profile 评级

页面按 profile 读取，所以每个 preset 只有一个等级，问的是「这个 profile 能不能用」：

| 等级 | 含义 |
|---|---|
| 可用 | 该 profile 的解析链能解析所有会启动的行 |
| 缺 N 行 | 有 N 行谁也找不到（悬浮列出 `row "id": 包名`） |
| 不可用 | 组合读不出来（缺失/坏 YAML/形状不合法/声明没有 `config`），带原因 |

- 解析链（`moduleSearchRoots`，与 profile 的层行同一套）：安装链 → 该 profile 的 `node_modules` → 共享 profiles 根 → home。这比 host 自己的健康检查更宽：host 只从安装链向上走，判的是名册而不是一次启动。两者不一致的地方正是这个评级要回答的，比如某插件只装进了某一个 profile。
- `!!js` 的 `name` 不判定，计入「由运行时决定」：宁可少报，也不把 loader 能接受的 preset 判死。
- `group` 递归；判定只读文件与目录，不加载任何插件代码。

## 6. launcher 能做什么

每行只有两个控件：「打开」下拉，和一个「…」菜单（编辑描述 / 复制 / 删除）。预设不属于用户时菜单少两项，而已。

- **Profile 选择器**：页面右上角。它决定名册和评级，也是写入目标 —— 声明模型下每个 profile 有自己的名册。
- **新建**：两种起点，在同一个弹窗里切换。最小实例 = 以内置的极简模式（id `minimal`）为起点，那是这个部署自己最小的组合面；复制已有 = 从名册里任选一个。两者的插件列表都来自源、逐字复制，所以新 preset 的可挂载性和它的起点一样。名册里没有内置极简模式时，最小实例这一项不可选。
- **改描述**：目录模型写 `preset.yml`；声明模型改声明行里的标量。只对用户自己的 preset 开放，内置 preset 的「内置」标签上挂着只读原因。
- **复制**：新 id 就是新身份。元数据随之重写：保留源的 description，name 用传入值，丢掉源的 order，否则副本会排进源的位次。id 不能改名，改 id 就是复制成新的。
- **删除**：仅用户自己的 preset。目录模型进系统回收站（可还原）；声明模型从 profile 补丁里移除行。
- **打开**：下拉里选「在文件管理器中显示」或用 VS Code。目录模型打开 preset 目录；声明模型打开**承载它的补丁文件**（在文件管理器里显示的是它所在的目录）。VS Code 走 `vscode://file/<path>` 协议，不 spawn `code`。
- **来源**：页面右上角的「来源」列出这份名册来自哪些层（组合包的哪个 patch 文件、profile 层、home 层），路径可复制。
- **旧目录迁移**：在声明模型的 dsh 上，`.agent-presets` 里剩下的目录会被识别为**不会被加载**，并给出「迁移为声明」：往当前 profile 的补丁里写一条同 id 的声明（id 取目录名，name/description/order 取 `preset.yml`，`plugins` 取 `agent.cordis.yml` 逐字）。**旧目录一个字节都不动。** 已经存在同 id 声明（含刚迁移完）的目录标为「已有同 id 的声明」，按钮不可用；组合读不出来的目录标为「内容读不出来」，同样不可迁移。

## 7. 不做的部分

- 不写 `plugins` 列表：没有行级编辑，也没有组装/骨架/素材挑选。插件列表就是 preset，交给外部编辑器。
- 不装组合包（`plugin_manager install_bundle`）—— 那条路是 Creator 模式在对话里做的；launcher 只声明在 profile 补丁里的行。
- 不做 launcher 全局 preset 库、商店、跨 dsh 汇总。
- 不改 `<home>/settings.yaml` 里的默认 preset（`agent-preset-registry` 的 `selectedDefault` / 旧的 `agent-presets.default`）。
- 不读 profile patch 里 `agent-presets.roots` 声明的额外根（已核对：官方安装的 bundle patch 与现有 profile patch 都没有声明；声明模型里也没有 roots 这个概念）。

## 8. 代码位置

| 文件 | 职责 |
|---|---|
| `src/shared/preset.ts` | 两边共用的词汇（id 规则、两套模型的文件名与包名、模型枚举） |
| `src/main/core/presets/index.ts` | 门面：读一份名册、写入、打开位置、迁移 —— 上层只认它 |
| `src/main/core/presets/layers.ts` | 按 profile 读补丁层并判定模型 |
| `src/main/core/presets/declaration.ts` | 声明模型的折叠读、渲染、写入（`plugins` 逐字保留） |
| `src/main/core/presets/legacy.ts` | 旧 `.agent-presets` 目录的识别与迁移输入 |
| `src/main/core/presets/roots.ts` | 目录模型的两个根、扫描、名册（健康标记、排序、first-root-wins） |
| `src/main/core/presets/metadata.ts` | `preset.yml` 读取、渲染、写入 |
| `src/main/core/presets/rows.ts` | 组合行的形状校验与行分类（复刻 host），两个模型共用 |
| `src/main/core/presets/rating.ts` | 按 profile 判分（模型无关的 target 入口） |
| `src/main/core/presets/authoring.ts` | 目录模型：存元数据、复制、回收站删除 |
| `src/main/core/patch/patch.ts` | 补丁文本的行级读写（含只改 config 标量的 `setConfigScalar`） |
| `src/main/core/store/combo.ts` | 组合层读取（一个组合包声明的全部 patch 文件） |
| `src/main/ipc/presets/presets.ts` | `preset:*` 七个通道 |
| `src/renderer/src/views/PresetsSection.tsx` | 一级「预设」页 |

## 9. 真机核对

- **目录模型**（`official`，dsh `0.1.5-rc.2`）：内置根解析到 `.pnpm/node_modules/@deepseek-ai/dsh-agent-presets/presets`，名册 standard(1) / ptc(2) / minimal(3) / cordis(4)，两个 profile 全部「可用」，每个 preset 有 4–5 行因 `!!js` 门被跳过、0 行留给运行时。
- **声明模型**（`official-0.2.0-rc1`，dsh `0.2.0-rc.1`）：`@deepseek-ai/dsh-agent-presets` 已不在安装里（`resolveModule` 返回 MISSING），`@deepseek-ai/dsh-agent-preset` 与 `…-registry` 走 pnpm 提升目录解析成功；`profiles/test/cordis.yml` 里是 `agent-preset-registry` + `preset-standard/ptc/minimal/cordis` 四行，`web-app` 的 `presets/*.patch.yml` 与 tag 逐字节一致。
- 声明模型的包名解析靠 pnpm 的 `.pnpm/node_modules` 提升目录，所以 launcher 现有的解析链（`moduleSearchRoots` 第一段）直接可用，不需要为它另造一套。
