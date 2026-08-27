# 提交（Commit）约定 · DSH Launcher

本文件固化本项目 Git 提交的历史风格与流程，作为新增提交的准绳。分支模型与发版流程见
[BRANCHING.md](./BRANCHING.md) 与 [RELEASE.md](./RELEASE.md)。

取值依据：仓库现存约 30 条非 merge 提交的标题与正文统计分析。

## 总则

- **提交信息一律用英文**（标题与正文皆然），面向可公开历史与协作。
- 采用 **Conventional Commits** 结构：`type(scope): summary`，小写、无句末句号。
- **原子提交**：一次提交只承载一个逻辑变更，可独立应用、可独立回滚；不要混合无改动的
  调试残留与主题无关的改动。
- 日常工作只在 `dev` 上提交并推送；`release`/`main` 不发版不直推（详见 BRANCHING.md）。

## 标题：type(scope): summary

### type —— 必须小写，固定选一

| type    | 含义                     | 历史占比 | 典型示例 |
|---|---|---|---|
| `feat`  | 新功能 / 新能力           | 最多    | `feat(about): check for launcher updates against GitHub releases` |
| `fix`   | 缺陷修复                 | 次多    | `fix(store): order archived versions by semver, not dictionary` |
| `chore` | 非功能改动的维护（bump、依赖、构建琐事） | 中 | `chore(release): bump version to 0.2.0-beta1` |
| `docs`  | 文档（docs/、README、releases changelog） | 中 | `docs(readme): sync v0.1.4 features and tech stack` |
| `refactor` | 行为不变的重构（清理、合并、收敛） | 少 | `refactor: collapse duplicated contract types, dead code and stale legacy shims` |
| `test`  | 测试相关                 | 少    | `test(coverage): raise failure-branch coverage…` |
| `style` | 样式 / UI 打磨（不改逻辑）| 少    | `style(market): polish the source picker + detail modal` |
| `ci`    | 流水线 / 工作流          | 少    | `fix(ci): publish release via gh CLI with notes-file…` |
| `build` | 构建配置 / 打包          | 少    | `build(renderer): code-split vendor chunks + lazy-load views` |

不使用 `merge:`（避免工作区产生 merge 提交，保持直线历史）。

### scope —— 可选，优先用「功能域名」

- 用**领域/模块名**而非笼统词，例如：`store`、`plugins`、`dsh`、`profile`、`download`、
  `market`、`security`、`settings`、`logging`、`about`、`shared`、`main`、`renderer`、
  `pack`、`ci`、`release`。
- 单一领域改动：`fix(store): …`；跨领域才考虑省略 scope。
- **`refactor` 与 `build` 历史倾向省略 scope**：`refactor: …`、`build(renderer)`。
- 发版专用固定 scope：`chore(release)`（bump 版本）、`docs(release)`（changelog）。

### summary —— 动词短语、小写、无句末句号

- 以一个小写动词开头，直接陈述做什么；用 `+` 并列多个动作。
- 参考措辞：`check …`、`show …`、`load … reliably`、`unify … in shared`、`migrate … by copying … not …`、
  `add …`、`remove …`、`raise … coverage in …`。
- 结尾**不加句点**、不加结束语气。

## 正文 body —— 有则叙事，简单则省

- **有意义的改动应带正文**：一段（或两段）核心讲述**做了什么 + 为什么**，而非罗列改动点。
- **不使用 Markdown 强调（反引号、星号、列表）**，body 是平铺叙述文。
- 可引用文件名 / 模块名用于定位，但不加代码字体。
- 典型长度一到三句；如 `feat(about)` 的 body：
  > About page detects a newer release than the installed version via the GitHub
  > releases API. Prerelease-aware… errors surface as retryable rather than a wrong
  > 'up to date'.
- 微小 / 自明的改动（如一行文档、一次 bump）可**省略 body**，仅标题即可。

## 提交流程（衔接 BRANCHING.md）

1. 在 `dev` 上完成改动，本地跑通门禁：`pnpm run typecheck` + `pnpm test`（含覆盖率门禁 `test:coverage`），必要时 `pnpm run build`。
2. 提交一条原子 commit（信息遵循本文档）；如与 `origin/dev` 一致之前已 push，用 `commit --amend` 修信息**仅限未 push 时**。
3. `git push origin dev`，让远程 dev 与本次一致。
4. 发版时：`chore(release)` bump 版本 + `docs(release)` 写 changelog 之后，才走 RELEASE.md 切 `release`、打 tag、对齐三分支。

## 提交前自查清单

- [ ] 标题 `type(scope): summary`，type 合法、小写、无句末句号
- [ ] scope 用功能域名；`refactor`/跨领域可省
- [ ] body 为无反引号的叙事段（有实质内容时）；简单改动可无 body
- [ ] 提交信息纯英文
- [ ] 一个提交一个逻辑变更
- [ ] 本地门禁通过后再提交