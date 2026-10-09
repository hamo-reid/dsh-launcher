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

**`!!js` 根**：`customSkillDirs` 里写成 `!!js` 的项由 dsh 在加载该行时求值，Launcher 求不了，因此按
「由运行时解析」上报（`runtime: true` / `exists: false`，`path` 是表达式源码而非文件路径），
**不参与 `resolve`，也不进任何扫描**。它在 `loadYaml` 之后仍是**带哨兵前缀的字符串**，所以
`typeof value === 'string'` 过滤不住它 —— 必须显式过 `isJsExpr`（标签本身见 §2.2）。
随包 preset 写的正是这一形式，所以这是常态而非边角。

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

- **写**（`writeSkill`）：整文件文本编辑，frontmatter `name` 是权威名称；改名时先在同根内
  rename bundle 目录，**拒绝覆盖**既有 skill；写后校验回读。
- **新建**：先取名字（slug 校验走 `shared/skill.ts` 的 `SKILL_NAME_RE`），主进程用与写入
  相同的渲染器生成脚手架（占位描述可解析，直接保存即合法）。
- **删除**（`deleteSkill`）：主进程**自行解析条目**（调用方无法把可写根之外的路径传进
  来），经注入的 `shell.trashItem` 移入系统回收站。
- **ZIP 导入**（`importSkillZip`）：文件对话框选 zip → 解压到临时 staging → 校验 → 统一
  改名落入可写根。
  - 识别规则：zip 根带 `SKILL.md` 即整个压缩包是一个 bundle；否则**任意深度**的每个
    `SKILL.md` 各是一个 skill（兼容 GitHub `repo-main/` 包装层）；嵌套在别的 skill 目录内
    的 `SKILL.md` 视为资源，不单独安装。
  - 安装目录名取 frontmatter `name`，skill 自带的资源文件整体随迁。
  - **All-or-nothing**：先解析、查重（zip 内重名 + 与可写根冲突），全部通过后才动可写根，
    任何失败不落一个文件。
  - 入口名先过 **zip-slip 守卫**（绝对路径 / 盘符 / `..` 段，含反斜杠归一化）—— adm-zip
    在写入侧会归一化恶意名，第三方包的读取路径仍需自己的守卫，故守卫单独导出做单测。

### 3.4 库总览的降级

`scanSkillInstalls` 把技能库映射到**每一个 dsh**，所以逐 dsh、逐条目保护地读：库条目自身读不出，
或某个副本读不出（半删、权限变化、扫描与读取之间根消失），只把该条标为 `stale` 并带上理由
（`problem`），**绝不失败整张总览** —— 一个坏路径不该让其它 dsh 上的所有技能一起从页面上消失。
「读不出」与「是最新的」是两个答案，只有后者不该重装。

## 4. 明确不做

- **per-profile skill**：dsh 的 user 根挂在 dshHome 而非 profile，按 profile 隔离需引入
  会话级覆盖，另行设计。
- project 根（cwd 相关）不管理；custom / agents / bundled 根只读。

## 5. 测试锚点

- `core/mcp/mcp.test.ts`：行读写的回归锁定（含缩进感知 `blockEnd`、嵌套列表行）。
- `core/mcp/mcp-secrets.test.ts`：存取 / 清除、cipher 往返、`plain:` 兜底、非法名、导出剥离。
- `core/skills/skills.test.ts`：根解析（config 行 + 默认根 + `includeDefaultRoots` + `!!js`
  运行时根不被 `resolve` / 不被扫描）、frontmatter 接受规则（含旧键拒绝与布尔容错）、列表 +
  issue、创建 / 改名冲突 / 回收站删除（仅可写根）、ZIP 导入（单包 / 根包 / 多包 / 包装层、
  无 `SKILL.md`、zip-slip 守卫、重名冲突、all-or-nothing）。
- `core/skills/preset-roots.test.ts`：preset 贡献根 —— 目录模型的 `skills/`、声明模型走自己的解析
  链、自身不带 skill 的 preset 跳过；无 profile / profile 不挂 preset 模型 / preset 包未安装均不
  产出根；rank 300 且永不 writable；profile 组合声明模型时不再认已退役的目录模型。