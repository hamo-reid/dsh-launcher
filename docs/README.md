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

> 2026-08 的一次性代码审计报告（原 `docs/audit/`）已删除：它的结论已全部落地，
> 剩下的只是过时的文件路径与行号。需要追溯当时的分析过程，看 git 历史。
>
> 2026-10 的缺陷修复计划（原 `docs/design/fixes.md`，27 条）同样已删除：**每条都已修完或已确证不必改**，
> 仍生效的规则按性质上收 —— profile 侧进 [`specs/profile.md`](./specs/profile.md)（§4 CRLF、§5 占用判定同源、
> §8 **P7–P12**），扩展侧进 [`specs/extensions.md`](./specs/extensions.md)（§3.1 / §3.3 / §3.4），
> preset 判定口径进 [`presets.md`](./presets.md)，错误码契约进 [`ui-guidelines.md`](./ui-guidelines.md) §4/§7，
> 测试约定进 [`TESTING.md`](./TESTING.md) §4。计划本身连同各批的账目表在历史里：
> `git log --diff-filter=D --oneline -- docs/design/fixes.md` 找到删除它的那次提交，
> 再 `git show <该提交>^:docs/design/fixes.md` 读全文；每条修复的提交信息里都写着它关掉的是哪个编号。