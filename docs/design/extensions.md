# 扩展管理设计（Extensions：MCP + Skills）

> 状态：MCP 轨与密钥已实现；Skills 轨已实现
> 分支：`dev`（`1b81daf` 起）
> 相关文件：`src/main/core/mcp.ts`、`src/main/core/mcp-secrets.ts`、`src/main/core/skills.ts`、
> `src/main/core/yaml.ts`、`src/main/ipc/extensions.ts`、
> `src/renderer/src/views/ExtensionsSection.tsx`、`McpView.tsx`、`SkillsView.tsx`、`ExtensionsModals.tsx`

## 1. 背景与目标

dsh 有两类「扩展」能力，launcher 此前都无法管理：

- **MCP 服务器**：profile 通过 `cordis.patch.yml` 的 `insert:` 行挂载
  `@deepseek-ai/dsh-mcp-client`，其工具以 `mcp__<serverName>__<tool>` 暴露；
- **Skills**：`skill-filesystem` 从若干文件系统根发现技能目录（`<name>/SKILL.md`
  或 `<name>.md`）。

目标：顶层新增**「扩展」section**，MCP 与 Skills 作为**两条独立轨道**分步实现，
只共享该 section 的 dsh/profile 选择器。Presets（预设组合）搁置。

## 2. 已确认的需求决策

| 决策点 | 结论 |
|---|---|
| 轨道划分 | MCP 与 Skills 独立实现、独立提交；per-profile skill 可行性已研究，记入 P2 |
| MCP 写入层 | 默认写 profile 层；显式勾选「应用到所有 profile」时写 home 层（机器级，组合在 profile 层之后） |
| 编辑运行中的 profile | 允许 —— dsh 对配置行原地热重载，等价于「重连该服务器」手势 |
| bundle（随包）行 | 只读：不可编辑/删除；**可停用** —— 写 profile 层的 id-targeted override（绝不二次 insert 同一 server） |
| 凭据 | 方案 A（引用式）：patch 行写 `!!js process.env.<NAME>`，值不落盘 |
| skill 删除 | 移入 **OS 回收站**（`shell.trashItem`），可随时在系统回收站恢复 |
| skill 可写范围 | 仅 user-dsh 根（`<dshHome>/skills`）；其余根只读展示 |

## 3. MCP 轨道

### 3.1 行级读写，不做整文件 YAML 重写

`core/mcp.ts` 与 `core/patch.ts` 构成行级编辑器：

- 读：`parseNamedRows` 按 `name === '@deepseek-ai/dsh-mcp-client'` 过滤，
  `extractKeyValue` 抽取每行的 `config` 体；
- 写：`addMcpServer` / `updateMcpServer` / `removeMcpServer` 只改动目标行的行区间，
  文件内注释与手写行原样保留；
- 删光一个 `insert:` 的全部子行时，连带删掉 `- insert:` 头（`removeInsertRow`）。

`patch.ts` 的 `blockEnd` 修复为**缩进感知**：行内嵌套的 `- ` 列表不再截断块的
结束位置（这是首版实现的 bug，MCP 行的 `env:`/`headers:` 列表踩中）。

每次写入后校验回读（`commitLayer` + `findMcpServer` / `verifyDisabledState`）。

### 3.2 `!!js` 与 js-yaml

js-yaml 拒绝未知显式标签，cordis 的 `!!js` 必须注册其 **RESOLVED 名**
`tag:yaml.org,2002:js`（短名不匹配，见 `core/yaml.ts`，MCP 与 skill-filesystem
config 解析共用）。标签是 load-only：launcher 永远不把 `!!js` dump 回 js-yaml。

### 3.3 分层与诊断

`combo.ts` 的 `listMcpServers(ctx, profile)` 按 **bundle → profile → home** 顺序
读取并汇总。诊断（`diagnoseMcpServers`）在启动前点名问题：

- 同名 `serverName` 冲突（dsh 会因 duplicate loader entry 直接 abort，launcher
  提前报出冲突双方）；
- `serverName`/`transport`/endpoint 缺失或非法；
- `config` 无法解析的行保留原文（`rawConfig`），只读展示。

## 4. 密钥（方案 A：引用式）

`!!js process.env.<NAME>` 让密钥不进 patch 文件（因此也不进 profile 导出/备份），
但 dsh 在 spawn MCP 子进程前会**清洗环境变量形状的凭据**，OS 级环境变量传不进
子进程 —— 值必须出现在 **dsh 进程自身**的环境里。补齐的另一半：

- **存储**：`core/mcp-secrets.ts`，name → value，经注入的 safeStorage cipher
  （同 GitHub token，`main/index.ts` 接线）静态加密落 `app.sqlite`；
  无 OS 密钥环时以 `plain:` 前缀明文兜底（诚实降级，不假装加密）。
- **注入**：`ipc/run.ts` 组装 `buildDshLaunch` 时把 `mcpSecretsEnv()` 并入子进程
  env；用户在启动面板 env 编辑器里显式设置的值优先生效。
- **边界**：renderer 只见名字（`ext:mcpSecrets` 返回 names，值单向保存、永不回读）；
  `exportSettings` 剥离整张表；导入设置时保留本机密钥（同 token 的处理）；
  日志只打动作与名字。

UI：MCP 视图顶部「Launcher 密钥」折叠面板（增删名字）；env 编辑器对已存值的
引用显示「已保存」标记。

## 5. Skills 轨道

### 5.1 根解析（镜像 dsh 的 `skill-filesystem`）

`core/skills.ts` 复刻 provider 的根序（rank 越小越优先）：

| rank | 来源 | 路径 | launcher 视角 |
|---|---|---|---|
| 100/200 | project-dsh / project-agents | `<cwd>/.dsh/skills` 等 | 不管理（cwd 相关，属会话范畴） |
| 300 | custom | home 层 `skill-filesystem` 行的 `customSkillDirs` | 只读 |
| 400 | user-dsh | `<dshHome>/skills`（`DSH_HOME` = `entry.home`） | **可写** |
| 500 | user-agents | `$DSH_AGENTS_HOME` 或 `~/.agents/skills` | 只读 |
| 600 | bundled | config `bundledSkillDir` / `$DSH_BUNDLED_SKILL_DIR` | 只读 |

config 行（`- id: … / name: '@deepseek-ai/dsh-skill-filesystem'`）从 home 层读取，
`includeDefaultRoots`、`dshHome`、`agentsHome` 覆盖均被尊重。

### 5.2 接受规则（与 dsh 逐条一致）

文件被识别为 skill，当且仅当：以 `---` 围栏 frontmatter 开头且正确闭合；
`name` 为非空小写 kebab-case（`[a-z0-9]+(?:-[a-z0-9]+)*`）；`description` 非空；
`disable-model-invocation` / `user-invocable` 为布尔值（camelCase 旧键与 dsh 一样
拒绝）。**dsh 静默忽略**不合格文件，launcher 则以 issue 形式点名文件与原因 ——
这是两处唯一的行为差异，且只差在「可见性」上。

### 5.3 写入、重命名、删除

- **写**（`writeSkill`）：整文件文本编辑，frontmatter `name` 是权威名称；改名时
  先重命名 bundle 目录（同根内 rename），拒绝覆盖既有 skill；写后校验回读。
- **新建**：先取名字（slug 校验走 `shared/skill.ts` 的 `SKILL_NAME_RE`），主进程
  用与写入相同的渲染器生成脚手架（占位描述可解析，直接保存即合法）。
- **删除**（`deleteSkill`）：由主进程自行解析条目（调用方无法把可写根之外的路径
  传进来），经注入的 `shell.trashItem` 移入系统回收站。注入模式与 cipher 一致，
  测试用 fake（rename 进临时目录）。

## 6. 明确不做 / 后续

- **per-profile skill**（P2）：dsh 的 user 根挂在 dshHome 而非 profile，按 profile
  隔离需引入会话级覆盖，另行设计；
- **Presets**（预设组合）：搁置；
- project 根（cwd 相关）不管理；custom / agents / bundled 根只读。

## 7. 测试

- `core/mcp.test.ts`：行读写的回归锁定（含缩进感知 blockEnd、嵌套列表行）；
- `core/mcp-secrets.test.ts`：存取/清除、cipher 往返、`plain:` 兜底、非法名、
  导出剥离；
- `core/skills.test.ts`：根解析（config 行 + 默认根 + includeDefaultRoots）、
  frontmatter 接受规则（含旧键拒绝与布尔容错）、列表 + issue、创建/改名冲突/
  回收站删除（仅可写根）。
