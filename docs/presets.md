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
| 重复 id | 靠前的根赢 | dsh 直接报 `Duplicate agent preset`，靠前的声明赢（借 row id 当身份的坏行不参与，见 §3.2） |

## 1. 判定模型：看组合里挂了谁，不看版本号

`core/presets/layers.ts` 按 profile 读它的补丁层（bundle 层 → profile 层 → home 层），扫每层里出现的插件名：

| 组合里出现 | 模型 |
|---|---|
| `@deepseek-ai/dsh-agent-preset`（或 `…-registry`） | `declaration` |
| `@deepseek-ai/dsh-agent-presets` | `directory` |
| 都没有 | `none`（页面说这个 dsh 没启用 agent preset，**并且不列任何「来源」**） |

`none` 这一格有具体后果：没有任何东西会读 preset，所以退役根 `<home>/.agent-presets` 与未挂载包的 `presets/` **不是**这份名册的来源，页面不列它们（来源面板为空、按钮禁用），`preset:reveal` 也对这些 id 报 `preset.notFound`。列出来会与同页「这个 dsh 没有启用 agent preset」的空状态自相矛盾。

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

这个声明全仓只有一处读：`core/store/bundle-manifest.ts`。之前有两个各自复刻的版本，于是数组形式各错一种：组合层读取只认字符串形式（名册全空、不报错），子包扫描把数组交给 `path.join`（TypeError 直接抛出 `install` / `uninstall` / 已装概览的调用方）。

自建的声明写在**当前 profile 的 `cordis.patch.yml`**（也可以写在 home 层，或做成一个组合包装进来；launcher 只写 profile 层，因为 home 层优先级更高、会影响所有 profile）。

### 3.2 读取：按 loader 行 id 折叠

`core/presets/declaration.ts` 的 `readDeclarations` 按 dsh 的语义折叠各层：

- 出现 `@deepseek-ai/dsh-agent-preset` 的行**定义**（或替换）它这个 loader 行 id 的定义；引用同一 id 但不带 name 的行只改它的 `disabled`。**后一层赢**，这就是「这个 entry 的字段最终是最后一层写的那个值」。
- preset 身份取 `config.id`，不是 loader 行 id。两行声明同一个 preset id 就是 host 的 `Duplicate agent preset`：靠前的赢，输的那个进 `warnings` 而不是被悄悄丢掉。
- **读到的 `config.id` 也要过 `^[a-z0-9][a-z0-9-]*$`**：不合规则的行标 `broken`（理由写明宿主也会拒），id 仍按文件原样显示。写侧本来就守这条，读侧不守就会把一个不可用的 id 当正常名册项列出来。
- **`config.id` 缺失时那行借 loader 行 id 当身份，但借来的 id 不参与"谁先到"**：它带着 `broken` 留在名册里，永不被丢，也永不占位。否则一个坏行能遮蔽一个真能用的 preset（真 preset 被当重复项丢弃），而"谁先注册这个 id"本来就是关于身份的问题，row id 不是身份。两行因此可能显示同一个 id：行 key 与评级取值都不再只认 id（评级按名册位置取，名册与 `grades` 由同一个数组生成）。
- **同一个 loader 行 id 被两个层各 `insert` 一次，是宿主的 `duplicate loader entry id`，整个 profile 起不来** —— 而折叠本身看不出它，因为"后一层再用一次同一 row id"正好是它存在的理由（上面那条替换）。所以折叠之外另按 `collectInsertIds`（与启动预检 `findInsertConflicts` 同一套结构遍历）数每个 row id 被 insert 的次数，**只对本名册自己的 row id** 报 warning，措辞用宿主那句 `duplicate loader entry id`。不这么报的话，页面会为一个起不来的 profile 显示一份健康名册。只改 `disabled` 的覆盖行不算 insert（两处判定同源）。
- 激活不了的声明留在名册里带原因（缺 `config`、`config.id` 为空、`name`/`order` 类型不对、`plugins` 形状不合法、YAML 读不出来）。占着 id 却什么都不显示，比一个坏行更糟。
- `disabled: true`（无论写在声明行上还是后一层的覆盖行上）会让这个 preset 从名册里消失，与 host 一致。

### 3.3 写入：`plugins` 块一个字节都不动

声明行的 `config.plugins` 是真实组合文本，里面可能有 `!!js` 门和 `|` 块标量。`patch/yaml.ts` 的注释写得很清楚：`!!js` 只能以私有哨兵存活，**绝不能进 dump**。所以：

- **改描述**：只在 `config` 块里增删改 `name` / `description` / `order` 三个标量行（`patch.ts` 的 `setConfigScalar`），`plugins` 块与它周围的注释逐字保留。
- **复制**：把源声明的 `plugins:` 块整段文本切片、改缩进后放进新行（`pluginsBlockOf` + `renderDeclarationRow`），同样不重新渲染。
- **删除**：从它所在的那一层删掉这一行（`removeInsertRow`）；那一层因此没有条目时留下 `[]` 标记 —— 只剩注释的补丁文件不是合法 YAML 文档，dsh 会拒绝启动整个 profile。
- **新建的 loader 行 id 用 `local-preset-<id>`**，不是官方的 `preset-<id>`：loader 行 id 撞了会让 dsh **拒绝启动整个 profile**，而 preset id 撞了只让那一条声明失败。用 launcher 自己的命名空间，将来 dsh 新增同名内置 preset 时退化成「一个坏行」，而不是「起不来」。
- 写入前三道护栏：`config.id` 已被任何层占用、`local-preset-<id>` 行 id 已被占用、id 不合法 —— 都拒绝。
- **一份声明能否改，看它是不是 profile 层**：本页只写当前 profile 的补丁。bundle 层属于部署（`preset.readOnly`）；home 层（`<home>/cordis.patch.yml`）是用户自己的，但**机器级、所有 profile 都组合它**，所以这一页也只读，用**另一个错误码** `preset.homeReadOnly` 拒绝，行上给的原因也不同（`preset.homeReadOnlyHint`）。分成两个码是因为文案由 code 决定（`lib/ipc.ts` 查 `errors.<code>`）：一个码只可能说出其中一种原因，而"内置不能改"和"改了会影响所有 profile"是两件事、两个改法。
- 只读不等于不可读：**复制仍允许以 home 层声明为源**（副本落在 profile 层）。
- 同一判据必须在显示侧：`editable` 就是 `layer === 'profile'`，UI 与后端不同源时界面会给出后端随后拒绝的操作（`store/refstate.ts:18-20` 那条规矩，反方向同样成立）。连带效果：删除确认文案「声明式的会从 profile 补丁里移除」在这个口径下自动正确 —— 能删的只有 profile 层。

### 3.4 官方四个 preset 没有名称也没有描述

声明模型下官方那四条 `presets/*.patch.yml`，`config` 里**只有 `id` 和 `order`** —— `name` 和 `description` 都没写：

```yaml
- insert:
    - id: preset-standard
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: standard          # ← 没有 name，没有 description
        order: 1
        plugins: [...]
```

这不是读不出来，是**数据里没有**。两处对照：

- 目录模型（0.1.5-rc.2）的 `preset.yml` 里描述是有的，例如 `standard`：「功能完整的编码 Agent，支持文件编辑、Shell、文件与网页检索、Skills、计划、目标、子代理和工作流。」同一套读代码在那一版读得出来。
- 宿主的 schema **支持**这两个字段：`dsh-agent-preset-registry` 的 `PresetDefinition` 是 `{ id, name?, description?, order?, plugins }`，官方只是没填。

所以 0.2.0-rc.1 的四张内置卡显示：标题退回 id（`name ?? id`），简介是占位文案「（没有描述）」。**这是数据属性，不是缺陷**，launcher 不替它编文案（内置文案会随官方措辞变更而陈旧，且没有维护者）。

用户想要一个有描述的 preset，唯一正路是**复制一份再改**：复制对话框只收 id 和 name，复制出的行落在 profile 层、**可编辑**，随后「编辑描述」写进那一份的 `config.description`。复制品不带源描述，因为源本来就没有（`index.ts` 的复制路径是 `source.description ?? {}`）。迁移旧目录同理：`preset.yml` 里的描述会带进新声明（`legacy.ts` 的 `migrationInput`）。

## 4. 组合面与能不能挂载

### 4.1 什么算一行：entry 位置

**只有 patch 结构里的 entry 才算行；行自己的 `config` 是插件私有数据。** `patch.ts` 的 `positionedRows` 是全部读取器（`parsePatchRows` / `parseNamedRows` / `parseClassifiedRows` / `collectInsertIds` / `findIdLine`）唯一的「一行」定义 —— 两套口径正好在要紧的地方分歧，所以只能有一套。它走的是 host `applyEntryPatches` 的结构，不是文件缩进：

- entry 来自顶层补丁条目数组，以及**顶层 `insert:` 列表**（`insert` 是补丁键，`applyEntryPatches` 只从顶层补丁列表读它，写在 entry 上的 `insert:` 不是补丁）；
- 还有 **group entry 的 `config` 列表** —— group 的 `config` 本身就是子 entry 列表（顶层 `- id: <group>` 带 `insert:` 也是往它里面插）；group 由 `group: true` 或包名 `cordis:group` 认；
- 其余 `config` 一概不下钻。

这条口径是 0.2.0-rc.1 逼出来的：四个 `presets/*.patch.yml` 各只有**一条**声明行，而 `config.plugins` 里躺着整套插件名册（`standard` 32 行，含嵌套 group）。按缩进读就会把这 100 来个 id 当成该层 insert 进来的 entry，于是它们与 base 层真正的同名 entry 撞车 —— 一个启动正常的 profile 被报出 32 条「重复插入的 entry id」，名册里多出一堆幻影插件，删除确认里的补丁行数也从 2 变成 40。

写侧同理：`findIdLine` 只认 entry 行，所以「按 id 改」永远落在 host 真正加载的那一行上。profile 补丁里带着 preset 声明（launcher 自己复制的就是这种）时，缩进盲的查找会命中名册里的 `tool-bash`，把 preset 的私有数据改掉。

整篇缩进的补丁是合法 YAML，所以顶层条目的缩进取**文档里第一条 `- ` 行**的缩进，而不是硬编码第 0 列。

### 4.2 层 = 组合包，文件是层内的维度

层叠栈按**组合包**列一层，不按文件。依据两条，都在宿主那边：

- 宿主的单位就是组合包：它的 `profile.layers` 是「每个组合包一项」，每项带一个 `patchPaths` **列表**；只有 `--dump-config` 的注释细到文件（`# == 文件`）。
- 可操作的单位也只有组合包：启用 / 停用 / 移除都作用在 `dsh.profile.bundles` 的条目上，单个 patch 文件从来不是能单独处理的对象。

所以 `ProfileLayer.files` 是层内的维度，文件这个粒度只留在三处真正需要它的地方：**行的来源**（这行是哪个文件写的，`lastSeenByRow` 按文件算）、**冲突标签**（点明要改哪个文件）、**预设页的位置列表**（哪个文件声明了哪些 preset）。组合包只在声明了**多个**文件时给自己的文件加限定（`bundle · web-app · presets/standard.patch.yml`）；单文件时不加，标签与 React key 与以前逐字相同。

`dsh.profile.bundles` 里同名列两次是两个层（宿主确实会应用两次），不合并。

### 4.3 能不能挂载

行列表每行必须带 `name`，可带 `id`、`disabled`，可以是 `group: true` + `config: [子行]`。launcher 复刻 host 的两趟判断：

1. 形状：非列表、行不是映射、行没有 `name`、group 的 `config` 不是列表，命中任一就是「不能挂载」，行上打红标。
2. 可解析：只看会启动的行。`Boolean(disabled)` 为真就跳过（`disabled: 0` 是要启动的，`disabled: !!js ...` 解析成非空字符串 → 跳过）；`name` 分类与 host 一致 —— `cordis:` → builtin，`.` 开头 → 相对**声明所在的补丁文件**目录（目录模型则是相对 preset 目录），`file:`/绝对路径 → 文件，其余 → 包名。
   - **`file:` 是绝对 URL，不是"相对"的另一种写法**（实测 0.2.0-rc.1 宿主：见 §9）。宿主只把 `.` 开头的 `name` 锚到声明文件旁边；带 `file:` 的交给 Node 的 ESM 解析器当 URL 处理，而那里**从不**按声明层 base 解析。于是 `file:./x.mjs` 写在与声明同一目录里也**取不到那个文件**：Windows 上宿主直接拒绝这一行（`File URL path must be absolute`），POSIX 上它塌成文件系统根。所以评级也**不**给它加 base（加了就会把一个宿主拒绝的行判成可用），这种行按"缺行"计入 —— 那是关于**行**的实话，不是关于文件的误报。
   - 想让"我旁边的这个文件"生效，写 `./x.mjs`（宿主会按每个补丁文件锚定，评级同样按声明的 baseDir 解析）。`file:` 只用于绝对位置。

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

页头只有两层信息：标题「预设」，下面一行**只报数据**的汇总，右侧控件。

- **汇总行**：`N 个 preset` 后接各等级的个数（`X 个可用` / `Y 个不可用` / `Z 个缺行` / `W 个未评级`），问题按严重度排在前面；全可用时收成一句「全部可用」，空名册干脆不出这一行（空态自己会说话）。分段与计数在 `lib/presetRow.ts`（`presetRosterSummary`），一格一个 preset、按**位置**取评级，与行上的标签同一套判据。**「不能挂载」不单列一段**：宿主挂不上的声明拿到的就是 `unusable` 评级（§5），再开一个桶会把同一个 preset 在这条被当作总数的行里数两遍 —— 那件事由行上的标签自己说。
- **说明**：右侧的「说明」是这一页唯一的解释性文字，点开是三个答案 —— 评级怎么读（按当前 profile 的解析链判定，悬停标签看缺了哪几行）、名册由什么模型决定（目录 / 组合层里的一行声明）、这份名册来自哪些层（组合包的哪个 patch 文件、profile 层、home 层，路径可复制）。`none` 模型下没有名册、没有评级也没有来源，按钮禁用（§1）。**页头不写这些**：解释性文案不占版面，需要时才展开。

每行只有两个控件：「打开」下拉，和一个「…」菜单（编辑描述 / 复制 / 删除）。这一页不写的 preset 菜单少两项（只剩复制），标签上的悬浮说明写出**为什么**：内置的与 home 层的是两种不同原因（见 §3.3）。

- **Profile 选择器**：页面右上角，带 `Profile` 前缀。它决定名册和评级，也是写入目标 —— 声明模型下每个 profile 有自己的名册。选择器只列**本 dsh 确认过**的名字（作用域与"读自哪台 dsh"绑成一个值）：切换 dsh 时旧名字整体作废、重读之后才恢复，所以这一页不会拿着上一台 dsh 的 profile 名去问当前这台（那种请求会被主进程以 `profile.notFound` 拒绝）。名字在页面停留期间没了（改名 / 删除 / home 被改）时，页面重读一次名单再问，而不是把这次拒绝报给用户。
- **新建**：两种起点，在同一个弹窗里切换。最小实例 = 以内置的极简模式（id `minimal`）为起点，那是这个部署自己最小的组合面；复制已有 = 从名册里任选一个。两者的插件列表都来自源、逐字复制，所以新 preset 的可挂载性和它的起点一样。名册里没有内置极简模式时，最小实例这一项不可选。**「已占用」的名册来自名册 + 退役目录**：core 两样都拒（退役目录的 id 一旦迁移就会撞），而名册只显示前者，所以弹窗只按名册判就会给出一个必然失败的「创建」。
- **改描述**：目录模型写 `preset.yml`；声明模型改声明行里的标量。只对 **profile 层**的 preset 开放（§3.3）：内置的与 home 层的都只读，后者要改请直接编辑 `<home>/cordis.patch.yml`。
- **复制**：新 id 就是新身份。元数据随之重写：保留源的 description，name 用传入值，丢掉源的 order，否则副本会排进源的位次。id 不能改名，改 id 就是复制成新的。**源可以是只读的**：副本落在 profile 层。
- **删除**：仅 profile 层的 preset。目录模型进系统回收站（可还原）；声明模型从 profile 补丁里移除行。
- **打开**：下拉里选「在文件管理器中显示」或用 VS Code。目录模型打开 preset 目录；声明模型打开**承载它的补丁文件**（在文件管理器里显示的是它所在的目录）。VS Code 走 `vscode://file/<path>` 协议，不 spawn `code`。**只定位，不评级**：一次点击不该为了一行路径把整份名册逐行走一遍解析链。
- **点一行看内容**：行的身份块可点（鼠标 / Enter / Space），弹出这份 preset **由哪些行组成** —— 只读，按**四态**分组：找不到（缺件，评级说的就是它）→ 由运行时决定（`!!js`，launcher 不判）→ 被禁用（`disabled:` 为真，宿主不启动）→ 会启动（能找到）。每行给 `name` 原文（`!!js` 行还原成文件里的写法，不是解析器内部的哨兵）、它属于哪一类（内置 / 相对路径 / 文件 / 包；`!!js` 行**不给**类别，因为类型由 loader 定）、以及宿主自己的位置措辞（`row "id"` / `row N`，group 路径带着）。**行的 `config` 不进这个视图**（插件私有数据，§4.1），视图里也没有任何写入入口 —— 行级编辑仍然不做（§7）；写入只留在行菜单里。分组顺序与判据在 `lib/presetRow.ts`（`presetRowSections`），行状态与徽标来自**同一遍**判定：计数是那个行数组的投影，两边不可能各说一套。
- **说明弹层**：把「怎么读评级、名册由谁决定、来源在哪」三件事收在一处（见上）。
- **旧目录迁移**：在声明模型的 dsh 上，`.agent-presets` 里剩下的目录会被识别为**不会被加载**，并给出「迁移为声明」：往当前 profile 的补丁里写一条同 id 的声明（id 取目录名，name/description/order 取 `preset.yml`，`plugins` 取 `agent.cordis.yml` 逐字）。**旧目录一个字节都不动。** 已经存在同 id 声明（含刚迁移完）的目录标为「已有同 id 的声明」，按钮不可用；组合读不出来的目录标为「内容读不出来」，同样不可迁移。

## 7. 不做的部分

- 不写 `plugins` 列表：没有行级编辑，也没有组装/骨架/素材挑选。插件列表就是 preset，交给外部编辑器。
  - **看内容 ≠ 组装**：「点一行看内容」只**列**宿主会加载的行与它们的判定（四态 + 类别），不挑零件、不加行、不改行、不改 `disabled`，也不枚举 preset 贡献的 skill 根（`!!js` 根只能按随包约定枚举，那个答案在技能页，这里再造一份就是第二个答案）。
  - **例外（尚未实现）**：[`design/assembly.md`](./design/assembly.md) 计划引入独立的「组装面」，届时本条收窄为「组装面只落地零件，不替用户挑 preset」。**组装本身一行未实现** —— 已经发货的只有四个与组装解耦的 skill 侧缺陷（`6b80b84` / `db83573` / `f652479` / `4fe1e65`，规则见 [`specs/extensions.md`](./specs/extensions.md) §3.1、§3.4）—— 所以**本条现在仍然有效**。
- 不装组合包（`plugin_manager install_bundle`）—— 那条路是 Creator 模式在对话里做的；launcher 只声明在 profile 补丁里的行。
- 不做 launcher 全局 preset 库、商店、跨 dsh 汇总。
- 不改 `<home>/settings.yaml` 里的默认 preset（`agent-preset-registry` 的 `selectedDefault` / 旧的 `agent-presets.default`）。
- 不读 profile patch 里 `agent-presets.roots` 声明的额外根（已核对：官方安装的 bundle patch 与现有 profile patch 都没有声明；声明模型里也没有 roots 这个概念）。

## 8. 代码位置

| 文件 | 职责 |
|---|---|
| `src/shared/preset.ts` | 两边共用的词汇（id 规则、两套模型的文件名与包名、模型枚举、**行类别与行状态** —— 行类别在渲染层要用来打标签，所以定义在 shared、由 `rows.ts` 别名） |
| `src/main/core/presets/index.ts` | 门面：读一份名册、写入、打开位置、迁移 —— 上层只认它 |
| `src/main/core/presets/layers.ts` | 按 profile 读补丁层并判定模型 |
| `src/main/core/presets/declaration.ts` | 声明模型的折叠读、渲染、写入（`plugins` 逐字保留） |
| `src/main/core/presets/legacy.ts` | 旧 `.agent-presets` 目录的识别与迁移输入 |
| `src/main/core/presets/roots.ts` | 目录模型的两个根、扫描、名册（健康标记、排序、first-root-wins） |
| `src/main/core/presets/metadata.ts` | `preset.yml` 读取、渲染、写入 |
| `src/main/core/presets/rows.ts` | 组合行的形状校验与行分类（复刻 host），两个模型共用 |
| `src/main/core/presets/rating.ts` | 按 profile 判分（模型无关的 target 入口）：一遍遍历产出**每行的四态**，四个计数是那个数组的投影 |
| `src/main/core/presets/authoring.ts` | 目录模型：存元数据、复制、回收站删除 |
| `src/main/core/patch/patch.ts` | 补丁文本的行级读写：entry 位置的唯一判定（`positionedRows`）、只改 config 标量的 `setConfigScalar` |
| `src/main/core/store/bundle-manifest.ts` | `dsh.bundle.patch` 声明的唯一读取处（单文件或数组） |
| `src/main/core/store/combo.ts` | 组合层读取（一个组合包声明的全部 patch 文件） |
| `src/main/ipc/presets/presets.ts` | `preset:*` 七个通道 |
| `src/renderer/src/views/PresetsSection.tsx` | 一级「预设」页（页头 = 标题 + 一行数据汇总 + 控件；行可点开内容；弹窗只收**位置 + 行身份**，grade 恒按位置对齐取） |
| `src/renderer/src/views/presets/PresetDetailModal.tsx` | 内容详情弹窗；导出的 `PresetDetailBody` 是断言入口（`Modal` 走 portal，server render 里看不到） |
| `src/renderer/src/views/presets/PresetModals.tsx` | 改描述 / 新建两个弹窗 |
| `src/renderer/src/components/ClickRegion.tsx` | 「这块可点」的契约（鼠标 + Enter/Space，且不放自己的控件）；`PluginCard` 与 preset 行共用 |
| `src/renderer/src/lib/presetRow.ts` | 行级决策（菜单项、「为什么不能改」的原因键）+ 内容视图的分组与评级标签 + 页头汇总行的分段（`presetRosterSummary`）+ 来源键映射（`Dropdown`/`Tooltip` 在 server render 里看不到，见 [`TESTING.md`](./TESTING.md) §4） |
| `src/renderer/src/lib/presetCreate.ts` | 新建弹窗的判定：「已占用」的 id 集合（名册 + 退役目录）与草稿能否提交 |

## 9. 真机核对

- **目录模型**（`official`，dsh `0.1.5-rc.2`）：内置根解析到 `.pnpm/node_modules/@deepseek-ai/dsh-agent-presets/presets`，名册 standard(1) / ptc(2) / minimal(3) / cordis(4)，两个 profile 全部「可用」，每个 preset 有 4–5 行因 `!!js` 门被跳过、0 行留给运行时。
- **声明模型**（`official-0.2.0-rc1`，dsh `0.2.0-rc.1`，profile `test`）：`@deepseek-ai/dsh-agent-presets` 已不在安装里（`resolveModule` 返回 MISSING），`@deepseek-ai/dsh-agent-preset` 与 `…-registry` 走 pnpm 提升目录解析成功。层叠栈 **4 层**：base（94 行 / 1 文件）、`web-app`（116 行 / **5 个文件**：`cordis.patch.yml` 112 行 + `presets/{standard,ptc,minimal,cordis}.patch.yml` 各 1 行，即声明行本身，名册在它的 `config` 里）、`dsh-experimental-agent-team-profile`（7 行 / 1 文件）、profile 补丁（1 行 / 1 文件）；按文件展开是 8 层。`--dump-config` 的 `profiles/test/cordis.yml` 里是 `agent-preset-registry`（`default: standard`）与 `preset-standard/ptc/minimal/cordis` 四行，`web-app` 的 `presets/*.patch.yml` 与 tag 逐字节一致。
- **上面两条 0.2.0-rc1 隐患都由此暴露**（数组形式 `dsh.bundle.patch` 的连带）：按缩进读行会让那四个文件各报出整套名册（33/34/8/34 行）—— 32 条幻影「重复插入的 entry id」、`validateComposition.ok = false`、名册里多出幻影插件、删除确认里的补丁行数从 2 变 40；`subdeps` 把声明交给 `path.join` 则 TypeError 抛出 `install` / `uninstall` / 已装概览。修后同一台机器：`insert conflicts: 0`、`validateComposition.ok = true`、组合插件 217（base 94 + web 116 + agent-team 7）、名册 standard/ptc/minimal/cordis 全 `ok`；`listBundleSubdepNames(web-app)` 返回 85 个子包，不再抛。
- **描述的对照**（同一台机器，同一套读代码）：声明模型下四个内置 `name` 与 `description` **都**是 `undefined`（见 §3.4）；目录模型下四条都读得出来，例如 `minimal` 的「仅提供持久 shell 的单工具编码 Agent。」。这条对照是「数据缺失、不是读坏」的直接证据。
- **目录模型未受影响**（`official`，dsh `0.1.5-rc.2`，profile `base-web`）：3 层 84/94/1 行，每层 1 个文件，0 冲突，名册与判分与改动前一致。
- **相对 `file:` 的实测**（`official-0.2.0-rc1`，dsh `0.2.0-rc.1`，2026-10-09）：临时 `$DSH_HOME` 下一个**不挂任何组合包**的 profile（`bundles: []`，`cordis.yml` 为 `[]`），补丁层与 `--patch` overlay 各插一行 `file:./…`，同目录放好对应文件，再跑 `dsh --profile probe --patch <overlay> --dump-config-schema`（这条路径会真的 `import` 每一行）。结果：**四行相对形式（`file:./x`、`file:x`，分别写在 profile 层与 overlay 层）全部报 `dsh: error: [/N] File URL path must be absolute`**，进程退 1；同一次运行里那一行**绝对** `file:///C:/…/profile-abs.mjs` 正常导入（`entries[0]` 无诊断），文件也确实存在。文件"就在声明旁边"这件事与结果无关 —— 那个文件从头到尾没被查过。机制在 Node 侧复核过：`import.meta.resolve('file:./x.mjs')` 抛 `ERR_INVALID_FILE_URL_PATH`，而 `import.meta.resolve('./x.mjs')` 正常解析到同目录；`new URL('file:./x.mjs')` 不带 base 得到 `file:///x.mjs`（盘根），带 base 才得到 `<base>/x.mjs` —— 宿主走的是前者那条路。
- 声明模型的包名解析靠 pnpm 的 `.pnpm/node_modules` 提升目录，所以 launcher 现有的解析链（`moduleSearchRoots` 第一段）直接可用，不需要为它另造一套。
