# 组装（Assembly）：让 preset 真的能被组装

> 状态：**P1–P3 未开始** —— 本文描述的组装面本身一行未实现
> 前置的四个 skill 侧缺陷（与组装解耦）已发货：`6b80b84` / `db83573` / `f652479` / `4fe1e65`；
> 它们仍然生效的规则已上收为规范 —— [specs/extensions.md](../specs/extensions.md) §3.1、§3.4 与
> [specs/profile.md](../specs/profile.md) P6 —— 本文不再复述。
> 相关文件：`src/main/core/presets/`、`src/main/core/skills/`、`src/main/core/patch/patch.ts`、
> `src/main/core/store/module-resolve.ts`、`src/main/ipc/presets/presets.ts`、
> `src/renderer/src/views/PresetsSection.tsx`
> 取代：`docs/presets.md` §7 第 1 条（"不写 `plugins` 列表"）

## 1. 问题不是"skill 进 preset"

Launcher 现在有**五条内容轨**，每条各自实现了一套「来源 → 落地 → 校验」：

| 轨 | 来源 | 落地 | 宿主机制 | 能否被组装 |
|---|---|---|---|---|
| 插件（库装） | npm / github | profile `dependencies` → pnpm | cordis loader | 能 |
| 插件（开发） | 本地目录 | profile `dependencies` = `link:` | cordis loader | 能 |
| 插件（快照） | 本地包 | 归档 + `dependencies` | cordis loader | 能 |
| MCP | launcher 设置 | profile / home 补丁行 | `dsh-mcp-client` | 能 |
| Skill | 技能库 | `<dshHome>/skills` | `skill-filesystem` 根 | 能 |
| **Preset** | **宿主** | **组合层的一行 / 一个目录** | `dsh-agent-preset` | **不能** |

Preset 是唯一一条 launcher 不能组装的轨，**而它恰恰是"组合"本身** —— 其它五条都是为它准备零件的。所以"把 skill 库导入 preset"这个提法本身把因果说反了：真正缺的是**一个组装面（assembly surface）**，skill 只是它要处理的零件之一。

现在四套并行的"能不能跑"判定已经各写了一遍：`preSnapshotChecks`（开发插件）、`diagnoseMcpServers`、`gradeTargets`（preset）、`diagnoseDevPlugin`。它们各自复算了一遍 profile 的组合与解析链。这是重复，也是漂移的来源。

## 2. 宿主已经给了形状，不要另发明

三份实测（`0.2.0-rc.1` 的包从 npm 取回后读的源码与随包补丁）：

**(1) preset 没有 skills 字段。** `@deepseek-ai/dsh-agent-preset@0.2.0-rc.1` 的 schema 是
`z.object({ id: required, name, description, order, plugins: required })` —— 没有任何 skill 相关的键。

**(2) preset 的 skill 由两行插件挂载。** 随包的
`@deepseek-ai/dsh-web-app@0.2.0-rc.1/presets/cordis.patch.yml`：

```yaml
- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    customSkillDirs:
      - !!js "…createRequire(baseUrl).resolve('@deepseek-ai/dsh-agent-preset/package.json') → dirname → join('skills')"
- id: tool-skill
  name: '@deepseek-ai/dsh-tool-skill'
```

目录模型里同一个位置写的是 `new URL('skills/', baseUrl)`。两者都在 `preset` 的组合里，都在**preset 自己的行**里。

**(3) 路径必须是包相对的。** 官方那条 `!!js` 走的是 `require.resolve('<包>/package.json')`，不是绝对路径。这不是风格，是
`docs/specs/profile.md` §4 写入契约：机器相关的路径不得进 profile 补丁。绝对路径会跟着 profile 导出跑到别的机器上。

**由此得到三条硬约束，设计的全部取舍都由它们决定：**

- skill 只能表达成「两行标准插件 + 一个可解析的根」，不能是 preset 的新字段；
- 那个根必须锚在**一个包**上，不能锚在 launcher 的目录上；
- launcher 求不了 `!!js`（`patch/yaml.ts` 只把它存成带哨兵前缀的字符串），所以 preset 贡献的 skill 根**在字面量上不可枚举**，只能按随包布局的**约定**枚举（[specs/extensions.md](../specs/extensions.md) §3.1 已落成规则）—— preset 把根指到别处时界面看不到，这一点要说明，不能假装列全了。

## 3. 词汇

```
Part      = { kind, id, version? }
            kind ∈ 'bundle' | 'plugin' | 'dev' | 'mcp' | 'skill'

Assembly  = { id, name?, description?, order?, parts: Part[] }

Target    = { dsh, profile }          // 解析链的锚，profile 不能省

Verdict   = 'satisfied' | 'stale' | 'missing' | 'blocked'

Plan      = { target, rows: PartPlan[], blockers[], warnings[] }
PartPlan  = { part, verdict, why, action }
```

三条划分理由：

- **`skills` 不并进 `parts`。** skill 是文件不是组合行，宿主靠 `skill-filesystem` 的根发现它，不靠行。塞进同一个数组会让 `parts` 变成"两种东西的并集"，`renderDeclarationRow` 也就没法逐字渲染 `plugins` 块了。它是一个平行的 `skills: string[]`，记的是**库条目名**，不是路径。
- **`version` 只对插件有意义**，skill 与 mcp 不带。宁可字段可空，也不要给所有 kind 造一个假的版本空间。
- **`Target` 必须是 `(dsh, profile)` 而不是 dsh。** 这不是新概念，是 `preSnapshotChecks` 刚踩过的坑：脱离 profile 判定会把 27 个正常的 `id:` 覆盖行报成未知（`4fe1e65`；规范见 [specs/profile.md](../specs/profile.md) P6）。

## 4. 三段式

```
声明 spec（launcher 私有，<dataRoot>/assemblies/<id>/assembly.yml）
      │
      ▼  resolve(spec, target)  ── 纯读：不写盘、不联网、对每个部件给判定与理由
    plan
      │
      ▼  materialize(plan)       ── 唯一写路径：逐部件落地 + 回读校验
```

**`resolve` 必须是纯函数且全函数。** 它不写、不联网，每个部件都有判定和理由，永远返回 plan。这正是整个 app 现在缺的东西：所有写操作都是"点了就跑"，没有"点了先看"。`preSnapshotChecks` 是一个部件的退化情形 —— 设计要把它**吸收**进来，而不是让它继续独立存在。

**每种 kind 一个 writer**，且都已经存在：

| kind | 现有 writer | 判定依据 |
|---|---|---|
| `plugin` | `core/store/install.ts` `installSource` | 归档版本 / profile `dependencies` |
| `dev` | 同上 + `linkDevToProfile` | `plugins:devList` 的 usage |
| `mcp` | `core/mcp/mcp.ts` | `listMcpServers(ctx, profile)` |
| `skill` | `core/skills/library.ts` `installSkillToDsh` | `scanSkillInstalls` 三态 |
| `bundle` | 写 `dsh.profile.bundles` | `listComboPlugins` |

`resolve` 与 `materialize` 都不认识 preset 模型 —— 和 `rating.ts` 一样模型无关。模型只出现在编码那一步。

## 5. 编码：preset 是两种编码器之一

`core/presets/index.ts` 现有的 `xxxIn(ctx, profile, …)` 形状（`detectModel` 分派到 `declaration.ts` / `roots.ts`）就是这条缝，设计沿用它，不另起炉灶。

**但组装层不能再添一处 fork。** 两套模型现在的分叉有 12 处（两套行整形、两套"是不是我的"、三套"id 空闲吗"、两套复制、两套删除、两套元数据校验、两套 `broken` 措辞……，详见 `docs/presets.md` 与 `core/presets/` 各自的注释）。分叉本身不全是坏事 —— 目录模型删目录进回收站、声明模型改文本，两者的安全姿态本来就不同。规矩是：**分叉只留在 `presets/` 内部，出这个目录的一切都是模型中立的。**

`rating.ts` 与 `rows.ts` 已经是模型中立的，`PresetListing` / `PresetPlace` 已经是模型中立的行类型。组装层因此只消费 `index.ts` 的门面与 `shared/types.ts` 的行类型，**不得**再读 `detectModel`、不得再分叉。

**声明模型。** 一个 `Assembly` 编码成一行声明：

```
config.id          ← assembly.id
config.name/…      ← assembly 的显示元数据
config.plugins     ← parts 里所有 kind ∈ {bundle, plugin, dev, mcp} 的行，逐字渲染
                  + skills 非空时补两行标准行（skill-filesystem + tool-skill）
```

**目录模型。** 编码成 `<dshHome>/.agent-presets/<id>/`：`agent.cordis.yml` + `preset.yml` +（若目录模型仍然可达）`skills/`。

**skills 部件两条路都能走通，编码器各自选：**

- 目录模型有目录 → `customSkillDirs: [new URL('skills/', baseUrl)]`，和官方 cordis preset 完全一致；
- 声明模型没有可依附的包 → **不写 `customSkillDirs`**，改为在落地阶段把库里的 skill 装进 `<dshHome>/skills`，preset 只要带上那两行标准行让目录挂上。

后一条是本文对"skill 怎么进 preset"的正面回答，理由有三条且互相独立：

1. 声明模型下 launcher 没有包可以让 `require.resolve` 指向，硬造一个（比如在 dataRoot 下摆个伪包）是把 launcher 的目录泄漏进宿主契约，比写绝对路径更糟；
2. `<dshHome>/skills` 是**已有的、唯一可写**的 skill 根，落地直接调 `installSkillToDsh`，不新增任何写路径；
3. 换机器时 `assembly.yml` 里只有 skill **名**，可导出、可 diff、跨机器有效 —— 这正是 §2 第 (3) 条要的。

代价要说清楚：**同一个 assembly 在两台 dsh 上的 skill 副本是两份拷贝，`scanSkillInstalls` 的文本比对仍然有效，drift 依然可见。** 不引入版本锁，也不假装有。

## 6. 落地后 preset 页会多出什么

- 「组装」视图：选 target（dsh + profile）→ 得到 plan → 逐部件显示 satisfied / stale / missing / blocked 与理由 → 「落地」按钮只做非 satisfied 的部分；
- preset 卡片上多一条「它需要的 skill」：已装 / 待更新 / 未装，后两个直接给出装到当前 dsh 的动作（复用 `InstallSkillModal`，不新写弹窗）；
- `blocked` 的判定直接复用 `preSnapshotChecks` 的两条 blocker 文案，**不产生第二套措辞**。

> **不要和「preset 内容」混为一谈**：preset 页已经可以点开一行、只读地列出这份 preset 由哪些行组成（四态 + 类别，见 [presets.md](../presets.md) §6）。那是**读**一个已有 preset 的组合行；本文的 `Part` / `Plan` / `materialize` 是**写**一个 assembly 的落地判定（哪些零件齐了、缺的该装什么）。两者会共用 `PresetListing` 的行类型，但一个是报告、一个是计划 —— 组装视图不要做进那个弹窗里。

## 7. 落点与不变式

`assembly.yml` 放 `<dataRoot>/assemblies/<id>/assembly.yml`，与 `plugins/`、`skill-library/`、`dsh/` 同级。

遵守 `docs/specs/profile.md`：

1. 任何 profile 路径由 `DshContext.home` 派生；
2. 写进 profile 的只有宿主规范字段（`package.json` / `cordis.patch.yml` / `pnpm-workspace.yaml`）；
3. **机器相关路径不进 profile** —— 这条直接决定了 §5 里"skill 记名不记路径"；
4. `dataRoot` 只覆盖 launcher 私有目录。

## 8. 分期

每一期都能独立发布、独立测试，不需要任何后续期的半成品。

| 期 | 内容 | 验收 |
|---|---|---|
| ~~P0~~ ✅ 已完成（与组装解耦的前置缺陷） | 四个 skill 侧缺陷的修复，规则已上收 [specs/extensions.md](../specs/extensions.md) §3.1、§3.4 | 四个 preset 自带 skill 在技能页可见（**选定 profile 后**；未选时页面明说 preset 根不列出）；`!!js` 不再生成幻影根；坏路径不炸总览（`6b80b84` / `db83573` / `f652479` / `4fe1e65`；技能页那一半在 `d907843`，判据见 [specs/extensions.md](../specs/extensions.md) §3.3） |
| P1 | `Assembly` / `Part` / `Verdict` / `Plan` 类型 + `resolve()`（纯读），先只覆盖 `skill` 与 `mcp` | 一个 assembly × 一个 target 的 plan 有完整判定与理由；无写、无网 |
| P2 | `materialize()`：把 `installSkillToDsh` 与 mcp 写路径接到 plan 上；`preSnapshotChecks` 改为 `resolve` 的一个特例 | 落地后回读校验；plan 里 satisfied 的部件不再动盘 |
| P3 | preset 编码器（两模型）+ 组装视图 | 目录模型编码出 `customSkillDirs: new URL('skills/', baseUrl)`；声明模型编码出两行标准行；`plugins` 块逐字保留 |

## 9. 明确不做

- **不写 preset 的选择 / 挂载。** launcher 今天没有 `preset:select` 之类的通道，也刻意不写 `<home>/settings.yaml` 里的默认 preset（`docs/presets.md` §7 最后一条）。会话选哪个 preset 是会话的事；组装层只负责"这个 preset 需要的东西齐不齐"。
- **不给 preset 加 skills 字段** —— 宿主 schema 没有，加了会被忽略或炸掉。
- **不把 skill 塞进声明模型的 preset** —— 没有可依附的包，见 §5。
- **不做 launcher 全局 preset 库 / 商店 / 跨 dsh 汇总** —— 沿用 `docs/presets.md` §7 后三条。
- **不引入 skill 版本锁或内容哈希** —— `scanSkillInstalls` 的文本比对够用，且它已经在页面上了。
- **不自动改写任何 profile manifest** —— 启动时静默改别人的清单，风险比悬空引用本身大。

## 10. 真机核对记录

| 结论 | 依据 |
|---|---|
| 声明模型 preset 无 skills 字段 | `@deepseek-ai/dsh-agent-preset@0.2.0-rc.1` 的 `lib/index.js`，`Config = z.object({id, name, description, order, plugins})` |
| preset 自带 skill 由两行插件挂载 | `@deepseek-ai/dsh-web-app@0.2.0-rc.1/presets/cordis.patch.yml` 第 143–149 行；目录模型对应 `presets/cordis/agent.cordis.yml` |
| 官方用包相对路径而非绝对路径 | 同上，`createRequire(baseUrl).resolve('@deepseek-ai/dsh-agent-preset/package.json')` |
| 判定必须带 profile | `4fe1e65`：带 `hamo-studio` 判定 0 blocker，不带则 2 blocker |
