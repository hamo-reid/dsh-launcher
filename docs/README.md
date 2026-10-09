# 文档地图

本仓库的文档分三条线，**不要混着放**。

| 位置 | 性质 | 规则 |
|---|---|---|
| [`docs/specs/`](./specs) | **现行规范**：契约、不变量、校验规则 | 只写"现在必须怎样"；历史取舍、实施计划、待办一律不写 |
| [`docs/design/`](./design) | **未实现的设计** | 只放尚未落地的方案；实现后把仍生效的部分上收 `specs/`，再删掉设计稿 |
| [`docs/releases/`](./releases) | **带日期的发行记录**，文件名即 tag | 永不改写；`release.yml` 直接读 `docs/releases/<tag>.md`，缺文件即失败 |
| 根 `docs/*.md` | 流程与手册 | `BRANCHING` / `COMMITTING` / `RELEASE` / `TESTING` / `TROUBLESHOOTING` / `ui-guidelines` / `presets` |

## 现行规范

| 规范 | 管什么 |
|---|---|
| [`specs/profile.md`](./specs/profile.md) | profile 位置与所有权、清单字段、写入契约、启动前预检、编辑面 |
| [`specs/launch.md`](./specs/launch.md) | 启动命令组装、参数校验、多进程运行契约、运行页 UI 契约 |
| [`specs/extensions.md`](./specs/extensions.md) | MCP 行级读写与密钥边界、Skill 根解析与导入规则 |

## 未实现的设计

| 设计 | 内容 |
|---|---|
| [`design/assembly.md`](./design/assembly.md) | 组装面（Assembly）：让 preset 真的能被组装 |
| [`design/egress.md`](./design/egress.md) | 出网策略（Egress）：自部署 registry / 代理 / 私有 CA |
| [`design/fixes.md`](./design/fixes.md) | 缺陷修复计划：2026-10 审查发现的 preset / 快照 / registry-skills 问题（修完即删） |

> 2026-08 的一次性代码审计报告（原 `docs/audit/`）已删除：它的结论已全部落地，
> 剩下的只是过时的文件路径与行号。需要追溯当时的分析过程，看 git 历史。