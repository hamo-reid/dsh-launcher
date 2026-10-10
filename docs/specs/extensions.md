# 规范 · 扩展（MCP + Skills）

> 适用范围：`src/main/core/mcp/**`、`src/main/core/skills/**`、`src/main/ipc/extensions/**`、扩展相关的渲染层
> 定位：**MCP 服务器与 Skill 库的读写契约、根解析规则与安全边界的唯一规范**。

「扩展」section 下，MCP 与 Skills 是**两条独立轨道**，只共享该 section 的 dsh / profile
选择器。

## 1. 已确认的决策

| 决策点 | 结论 |
|---|---|
| MCP 写入层 | 默认写 **profile 层**；显式勾选「应用到所有 profile」时写 **home 层**（机器级，组合在 profile 层之后） |
| 编辑运行中的 profile | 允许 —— dsh 对配置行原地热重载，等价于「重连该服务器」手势 |
| bundle（随包）行 | 只读，不可编辑 / 删除；**可停用** —— 写 profile 层的 id-targeted override，**绝不二次 insert 同一 server** |
| MCP 凭据 | 引用式：patch 行写 `!!js process.env.<NAME>`，值不落盘 |
| skill 删除 | 移入 **OS 回收站**（`shell.trashItem`），可随时在系统回收站恢复 |
| skill 可写范围 | 仅 user-dsh 根（`<dshHome>/skills`）；其余根只读展示 |
| profile 作用域（两个页面共用） | 名字与「它读自哪台 dsh」绑成一个值（`renderer/src/lib/profileScope.ts`）；页面**只问本 dsh 名单确认过的名字**，切 dsh 时旧名字整体作废 |
| 技能列表的呈现 | dsh 面板 = **卡片栅格**（一张卡一个 skill，自带操作），扫描的根在它上方作为一块安静的信息块；dsh 面板与技能库都以**面板自身**为 zip 落点（覆盖层只在手势期间存在，`components/DropZone.tsx`），不再有常驻的拖放方块；来源文案/颜色只有一份（`renderer/src/lib/skillSource.ts`） |

## 2. MCP

### 2.1 行级读写，不做整文件 YAML 重写

- **读**：`parseNamedRows` 按 `name === '@deepseek-ai/dsh-mcp-client'` 过滤，
  `extractKeyValue` 抽取每行的 `config` 体。
- **写**：`addMcpServer` / `updateMcpServer` / `removeMcpServer` 只改动目标行的行区间，
  **文件内注释与手写行原样保留**。
- 删光一个 `insert:` 的全部子行时，连带删掉 `- insert:` 头（`removeInsertRow`）。
- `patch.ts` 的 `blockEnd` 必须**缩进感知**：行内嵌套的 `- ` 列表不得截断块结束位置
  （MCP 行的 `env:` / `headers:` 列表踩过这个坑）。
- 每次写入后校验回读（`commitLayer` + `findMcpServer` / `verifyDisabledState`）。

### 2.2 `!!js` 与 js-yaml

js-yaml 拒绝未知显式标签；cordis 的 `!!js` 必须按其 **RESOLVED 名**
`tag:yaml.org,2002:js` 注册（短名不匹配，见 `core/patch/yaml.ts`，MCP 与
skill-filesystem 的 config 解析共用）。**标签是 load-only：Launcher 永不把 `!!js`
dump 回 js-yaml。**

### 2.3 分层与诊断

`listMcpServers(ctx, profile)` 按 **bundle → profile → home** 顺序读取并汇总。
`diagnoseMcpServers` 在启动前点名以下问题：

- 同名 `serverName` 冲突（dsh 会因 duplicate loader entry 直接 abort，Launcher 提前报出
  冲突双方）；
- `serverName` / `transport` / endpoint 缺失或非法；
- `config` 无法解析的行保留原文（`rawConfig`），只读展示。

### 2.4 密钥（引用式）

`!!js process.env.<NAME>` 让密钥不进 patch 文件（因此也不进 profile 导出 / 备份）。但 dsh
在 spawn MCP 子进程前会**清洗环境变量形状的凭据**，OS 级环境变量传不进子进程 —— 值必须
出现在 **dsh 进程自身**的环境里。补齐的另一半：

- **存储**：`core/mcp/secrets.ts`，name → value，经注入的 safeStorage cipher（同 GitHub
  token，`main/index.ts` 接线）静态加密落 `app.sqlite`；无 OS 密钥环时以 `plain:` 前缀
  明文兜底（诚实降级，不假装加密）。
- **注入**：`ipc/dsh/run.ts` 组装启动命令时把 `mcpSecretsEnv()` 并入子进程 env；用户在启动
  面板 env 编辑器里显式设置的值优先生效。
- **边界**：renderer 只见名字（返回 names，值单向保存、**永不回读**）；`exportSettings`
  剥离整张表；导入设置时保留本机密钥（同 token 的处理）；日志只打动作与名字。

## 3. Skills

### 3.1 根解析（镜像 dsh 的 `skill-filesystem`，rank 越小越优先）

| rank | 来源 | 路径 | Launcher 视角 |
|---|---|---|---|
| 100 / 200 | project-dsh / project-agents | `<cwd>/.dsh/skills` 等 | 不管理（cwd 相关，属会话范畴） |
| 300 | custom | home 层 `skill-filesystem` 行的 `customSkillDirs` | 只读 |
| 400 | user-dsh | `<dshHome>/skills`（`DSH_HOME` = `entry.home`） | **可写** |
| 500 | user-agents | `$DSH_AGENTS_HOME` 或 `~/.agents/skills` | 只读 |
| 600 | bundled | config `bundledSkillDir` / `$DSH_BUNDLED_SKILL_DIR` | 只读 |

config 行（`- id: … / name: '@deepseek-ai/dsh-skill-filesystem'`）从 **home 层**读取；
`includeDefaultRoots` / `dshHome` / `agentsHome` 覆盖均被尊重。

**preset 贡献的根**（`source: 'preset'`，rank 同 custom = 300，只读）：按 preset 的**随包布局约定**
枚举 —— 目录模型取各 preset 目录的 `skills/`，声明模型取 `@deepseek-ai/dsh-agent-preset` 包自己的
`skills/`（`core/skills/preset-roots.ts`）—— **不读 preset 自己行里 `customSkillDirs` 的字面量项**。
带 profile 才枚举（`skillRoots(ctx, { profile })`）：preset 只在某个 profile 的组合里才有意义，
没有 profile 就没有 preset 根。preset 把根指到别处时落在 Launcher 视野之外 —— 这是该模块注释里
明示的取舍，不是漏做。

**`!!js` 根**：`!!js` 在 `loadYaml` 之后仍是**带哨兵前缀的字符串**，所以 `typeof value === 'string'`
过滤不住它 —— 必须显式过 `isJsExpr`（标签本身见 §2.2）。这条**对四个 config 路径字段一视同仁**
（`dshHome` / `agentsHome` / `customSkillDirs` 的每一项 / `bundledSkillDir`）：Launcher 求不了就**当作
未配置**，绝不 `resolve` 它。其中 `customSkillDirs` 的 `!!js` 项额外上报成「由运行时解析」
（`runtime: true` / `exists: false`，`path` 是表达式源码而非文件路径），**不参与 `resolve`，也不进任何
扫描**；另外三个字段则直接退回默认值 —— 对 `dshHome` 尤其要紧：它**替换**真实可写根，被哨兵顶掉后
`user-dsh`（`<home>/skills`）会从列表里消失，同时报出一个 writable 的幻影根。随包 preset 写的正是这一
形式，所以这是常态而非边角。

**空白值同样等于未配置**，config 与环境变量两侧一致：`resolve('')` 是**当前工作目录**，而它存在 ——
扫描器会走进 Launcher 自己的工作目录，把那里的 `SKILL.md` / `*.md` 当成这个 dsh 的技能。`??` 不吃 `''`，
所以 env 覆盖必须显式判空；`pathOverride` 是唯一判据，同时管四个字段与两处 env（`DSH_AGENTS_HOME` /
`DSH_BUNDLED_SKILL_DIR`）。只有**决定**按去空白后的形式做，路径本身的字节不改写。

### 3.2 接受规则（与 dsh 逐条一致）

文件被识别为 skill，当且仅当：

- 以 `---` 围栏 frontmatter 开头且正确闭合；
- `name` 为非空小写 kebab-case（`[a-z0-9]+(?:-[a-z0-9]+)*`）；
- `description` 非空；
- `disable-model-invocation` / `user-invocable` 为布尔值（camelCase 旧键与 dsh 一样
  **拒绝**）。

**dsh 静默忽略**不合格文件，Launcher 则以 issue 形式点名文件与原因 —— 这是两处唯一的
行为差异，且只差在「可见性」上。

### 3.3 写入 / 重命名 / 删除

写入口在 **dsh 可写根**（`ext:skill*`）与 **库**（`ext:libSkill*`）两侧同形：一侧管「这个 dsh 上的副本」，
一侧管「launcher 全局的库」，页面**成对使用，不互相借用**（脚手架也不例外：`ext:skillScaffold` /
`ext:libSkillScaffold`）。

- **写**（`writeSkill` / `ext:skillSave`）：整文件文本编辑，frontmatter `name` 是权威名称；改名时先在
  同根内 rename bundle 目录；写后校验回读。文本必须是字符串且不超过 **256 KB**，超出在 IPC 边界拒绝。
- **拒绝覆盖**：**新建**（`previousName === null`）时可写根里已有 `<name>/` 或 `<name>.md` 即拒绝
  （`ext.skillExists`）—— 编辑器此刻手上没有任何可读的旧内容，没有这道守卫就会静默替换既有
  `SKILL.md`（或在一个名字下留下两份）。改名撞名同样拒绝；只有「原地编辑」（`previousName === name`）
  才允许落在既有目录上，且那条路径会顺手删掉同名的扁平文件。
- **读**（`readSkillFile` / `ext:skillRead`）：只读可写根内的条目。名字存在但不在可写根（project /
  custom / agents / bundled）时以 `ext.skillReadOnly` 拒绝，而不是 `internal` —— 那是业务答案，不是异常。
- **新建**：先取名字（slug 校验走 `shared/skill.ts` 的 `SKILL_NAME_RE`），主进程用与写入
  相同的渲染器生成脚手架（占位描述可解析，直接保存即合法）。
- **删除**（`deleteSkill`）：主进程**自行解析条目**（调用方无法把可写根之外的路径传进
  来），经注入的 `shell.trashItem` 移入系统回收站。
- **ZIP 导入**（`importSkillZip` / `ext:skillImportZip`，库侧 `ext:libSkillImportZip`）：文件对话框选
  zip → 解压到临时 staging → 校验 → 统一改名落入目标根。
  - 识别规则：zip 根带 `SKILL.md` 即整个压缩包是一个 bundle；否则**任意深度**的每个
    `SKILL.md` 各是一个 skill（兼容 GitHub `repo-main/` 包装层）；嵌套在别的 skill 目录内
    的 `SKILL.md` 视为资源，不单独安装。
  - 安装目录名取 frontmatter `name`，skill 自带的资源文件整体随迁。
  - **All-or-nothing**：先解析、查重（zip 内重名 + 与目标根冲突），全部通过后才动目标根，
    任何失败不落一个文件。
  - **两趟之间的竞态由文件系统兜住**：第 2 趟复制**之前**再查一次同名（命中即 `ext.skillExists`），
    复制本身再用 `errorOnExist`（配 `force: false`）。调用方传进来的 `exists` 探针只是它自己的一次
    查询 —— 判据必须落在真正落盘的那一步，否则探针与复制之间新出现的同名条目会被静默覆盖。
  - 入口名先过 **zip-slip 守卫**（绝对路径 / 盘符 / `..` 段，含反斜杠归一化）—— adm-zip
    在写入侧会归一化恶意名，第三方包的读取路径仍需自己的守卫，故守卫单独导出做单测。

### 3.4 库总览的降级

`scanSkillInstalls` 把技能库映射到**每一个 dsh**，逐 dsh、逐条目保护地读，任何一条读不出都
**绝不失败整张总览** —— 一个坏路径不该让其它 dsh 上的所有技能一起从页面上消失。三种"读不出"
各有归属，别混为一谈：

| 读不出的东西 | 归属 | 为什么 |
|---|---|---|
| **库条目自己**（`<lib>/<name>/SKILL.md` 是目录、权限、半删） | `listSkillLibrary` 的 **issue**（带路径与错误文本），该条不进 `skills` | 两条库路由都**先**扫目录：这里一抛，`ext:libSkillList` / `ext:libSkillOverview` 一起失败，页面只剩一条错误 —— 下游那些逐副本守卫根本没机会跑。读取守卫必须在**最外层**，与 `scanRoot` 的做法一致 |
| **某个 dsh 上的副本** | 该单元格 `installed: true` + `stale: true` + `problem` | 副本确实在，只是读不出；"说不清"与"是最新的"是两个答案，只有后者不该重装 |
| **条目在扫描与比较之间**变得不可读（竞态） | 同上：单元格仍如实报告 `installed`，`stale: true` + `problem` | 是否**装着**仍然答得出，是否**最新**答不出 —— 不能因此对每个 dsh 都说"未安装" |

**`problem` 必须在页面上可见**，并且该单元格**不得**被呈现成"库有更新 + 重新安装"：重装修不好
一个读不出的东西，那个措辞是把两种状态混成一种。落点（`renderer/src/lib/skillInstallState.ts`
是唯一的状态判定）：库卡片的问题标签（tooltip 带理由）、安装弹窗的 `Alert`（理由原文）+ 主按钮改
「仍要重装」、dsh 面板行上的问题标签。

判定优先级是规格的一部分：**`problem` 压过一切**（`installed` / `stale` 的结论都不作数）。

## 4. 明确不做

- **per-profile skill**：dsh 的 user 根挂在 dshHome 而非 profile，按 profile 隔离需引入
  会话级覆盖，另行设计。
- project 根（cwd 相关）不管理；custom / agents / bundled 根只读。

## 5. 测试锚点

- `core/mcp/mcp.test.ts`：行读写的回归锁定（含缩进感知 `blockEnd`、嵌套列表行）。
- `core/mcp/mcp-secrets.test.ts`：存取 / 清除、cipher 往返、`plain:` 兜底、非法名、导出剥离。
- `core/skills/skills.test.ts`：根解析（config 行 + 默认根 + `includeDefaultRoots` +
  **四个路径字段都拒绝 `!!js` 哨兵**（`dshHome` 尤其：可写根必须还在）、**空白字段/空白 env 一律等于未配置**
  （否则 `resolve('')` 会把扫描带进 cwd）、`!!js`
  运行时根不被 `resolve` / 不被扫描）、frontmatter 接受规则（含旧键拒绝与布尔容错）、列表 +
  issue、创建 / 改名冲突 / **新建拒绝覆盖（bundle 目录与扁平文件两种形态）** / 可写根之外的名字
  以 `ext.skillReadOnly` 拒绝、回收站删除（仅可写根）、ZIP 导入（单包 / 根包 / 多包 / 包装层、
  无 `SKILL.md`、zip-slip 守卫、重名冲突、all-or-nothing、**探针与复制之间出现同名条目**、
  **探针恒说"空闲"时由文件系统拒绝覆盖**）。
- `ipc/extensions/extensions.test.ts`：`ext:mcpSave` 的 id 守卫；`ext:skill*` 的端到端契约
  （scaffold → save → read 回读、frontmatter 改名、新建拒绝覆盖、非可写名与超长文本的拒绝码、
  zip 导入落进可写根、非 zip 路径的拒绝码）。
- `renderer/src/lib/profileScope.test.ts`：页面作用域的 profile 选择规则（记住仍在的、否则首个、
  没有 profile 时是 `undefined` 这个**有意义**的答案）。作用域**带 dsh 标签**：标签对不上的作用域
  一律答 `undefined` / 空名单 —— 页面在切 dsh 时组件不重挂载，无标签的名字会活过切换、被拿去问
  另一台 dsh，而主进程**必须**拒绝它（`profile.notFound`；静默降级成"这台 dsh 没有 preset 根"更坏）。
  同一文件钉住"拒绝后是否值得重问"：名字已不在本 dsh 名单里（改名 / 删除 / home 被改）→ 重读一次再问；
  名字仍在名单里 → 那次拒绝是真的，照实报。
- `renderer/src/lib/skillInstallState.test.ts`：单元格状态判定 —— `problem` 压过 `installed`/`stale`
  的一切结论（"读不出"不是"有更新"），以及状态 → 标签/颜色的映射。
- `renderer/src/lib/skillSource.test.ts`：来源怎么读 —— **一个事实一个标签**：preset 贡献的根只戴**一个**
  带 owner 的标签（旧行为是"来自 preset"与"来自 preset「cordis」"两条同现，一个根读成两个），路径不是路径
  的运行时根额外带"由运行时解析"；每个 source 都有文案键与颜色，两页共用这一份而不是各拼一遍。
- `renderer/src/views/skillInstallRender.test.tsx`、`dshSkillCardRender.test.tsx`、
  `dshSkillsPanelRender.test.tsx`：**渲染断言**（`react-dom/server`，无 DOM、无新依赖）：
  问题标签出现在库卡片上且**不**出现"库有更新"这类结论、安装弹窗里出现理由原文与「仍要重装」；
  dsh 侧技能卡片按同一份文案显示副本来源（本 dsh / 本机 agents）、只有可写根的副本才给「编辑」、
  只有 `stale` 才给「重新安装」；未选 profile 的技能面板**明说** preset 根不列出、创作入口在位、
  **首帧是骨架**而不是空盒子或提前出现的"还没有任何 skill"、且**没有**常驻的拖放方块（面板自身就是
  拖放目标）。渲染层测试由 `vitest.config.ts` 的 `src/renderer/src/views/**/*.test.tsx` 纳入
  （coverage 仍只统计 `core`）。
  - 边界：antd 的 `Modal` 走 portal，SSR 下内容为空，所以弹窗的**主体**单独成组件
    （`InstallSkillFields`）以便断言；tooltip 内容同理只在悬停时渲染，不做断言。
  - 仍未断言：需要 effect 的行为（例如"传入 profile 时确实以它调用了 `ext:skillList`"）——
    SSR 不跑 effect，那一半由 `core/skills/preset-roots.test.ts` 与读码覆盖。**profile 作用域这一半**
    （切 dsh 后第一次请求不带外来的 profile 名）同样测不到 effect，判据放在 `profileScope.test.ts`
    的纯函数里，接线由读码 + 真机日志核对补齐（在 DSH 页反复切 dsh，`main-<DATE>.log` 不得新增
    `ipc fail: ext:skillList`）。骨架屏也没有文案，只能断言 antd 的 `ant-skeleton` class —— 少数直接
    盯标记的地方，拿不到文案时才用。
- `core/skills/preset-roots.test.ts`：preset 贡献根 —— 目录模型的 `skills/`、声明模型走自己的解析
  链、自身不带 skill 的 preset 跳过；无 profile / profile 不挂 preset 模型 / preset 包未安装均不
  产出根；rank 300 且永不 writable；profile 组合声明模型时不再认已退役的目录模型。