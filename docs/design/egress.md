# 出网策略（Egress Policy）：自部署 registry / 代理 / 私有 CA

> 状态：**P0 已落地**（设置项 `registryUrl` → `core/store/registry.ts` 的 `registryBase()`）；P1–P3 未开始
> 相关文件：`src/main/core/store/npm.ts`、`src/main/core/store/market.ts`、`src/main/core/store/updates.ts`、
> `src/main/core/dsh/install.ts`、`src/main/core/dsh/pnpm.ts`、`src/main/core/profile/launch-spec.ts`、
> `src/main/core/settings/secret-at-rest.ts`、`src/main/core/github/auth.ts`、`src/main/core/settings/normalize.ts`

## 1. 问题：一次操作，两个 registry

> **落地进度**：launcher 自己 `fetch` 的那半**已修**（两处都走 `registryBase()`，见 §4）；pnpm 那半、TLS / 代理**一行没动**。
> 下表保留设计当初记录的现状，URL 列已按当前代码标注。

`src/main` 里一共 **8 处 `fetch`**，其中原先写死 npm 公共源的 **2 处**现在都走 `store/registry.ts` 的 `registryBase()`：

| 位置 | 用途 | URL |
|---|---|---|
| `store/npm.ts:60` `npmSearch` | 插件市场搜索 | ✅ `registryBase()`（原写死 `https://registry.npmjs.org/-/v1/search`） |
| `store/npm.ts:72` `fetchPackageVersions` | 版本下拉、插件更新检查、**dsh `latest`/`next` 解析** | ✅ `registryBase()`（原写死 `https://registry.npmjs.org/<name>`） |
| `store/market.ts:153` | 社区市场目录 | 官方常量，**已支持用户镜像**（`marketSource`/`marketUrl`） |
| `store/updates.ts:81` | github 源插件的最新 tag | `api.github.com` |
| `github/updates.ts:56` | launcher 自身更新检查 | `api.github.com` |
| `github/auth.ts:126,138` | token 有效性 / 限流探测 | `api.github.com` |
| `mcp/probe.ts:280` | MCP 握手探测 | 用户 URL |

**装包本身**全部走 `pnpm add <spec>`。而 `runPnpm`（`dsh/pnpm.ts:194`）给 pnpm 的环境是
`childEnv(node.bundled, {})` = `{...process.env}` 全量继承，**launcher 不注入任何 registry 配置**：
全仓库没有 `.npmrc`，没有 `--registry`，没有 `npm_config_*`（`launch-spec.ts:152` 那个 `extra` 传的就是 `{}`）—— **这一条至今未变**。

于是同一件事被劈成两半，各问各的：

```
用户点「安装 dsh 0.2.0-rc.1」
  → fetchPackageVersions('@deepseek-ai/dsh')   ← registry.npmjs.org   ← launcher 自己 fetch
  → pnpm add @deepseek-ai/dsh@0.2.0-rc.1        ← 用户的 ~/.npmrc      ← pnpm
```

三个后果：

1. **air-gapped 装不了 dsh。** 私有网里 `registry.npmjs.org` 不可达，第一步就抛，`pnpm` 根本没被调用 —— 即使私有源里镜像齐全。
2. **私有源与公共源的 `latest` 可以不一致。** 选版本按公共源，取包按私有源；装出来的不是用户要的那个。
3. **搜索永远搜不到内部包**，而且不报错，表现为"这个包不存在"。

**仍未消掉的部分**：第 1 条里「第一步就抛」已消除（`registryUrl` 让版本查询能到达私有源），但 pnpm 仍读用户的 `.npmrc`；第 2、3 条完整保留。

另外两条独立的缺口（**至今成立**）：

- **TLS / 代理：全仓库零支持。** `NODE_EXTRA_CA_CERTS`、`NODE_TLS_REJECT_UNAUTHORIZED`、`rejectUnauthorized`、`HTTP_PROXY` 全部 0 次出现，没有 `node:https` 导入。launcher 自己的 fetch 用 Node 原生 undici，只认系统信任库 —— 自签 CA 的私有源对 pnpm（读 `.npmrc`）可能能通，对 launcher 的 fetch 一定失败。
- **launch-options 的保留键挡不住这些。** `core/profile/launch-options.ts:25-27` 只挡 `ELECTRON_RUN_AS_NODE` / `DSH_HOME` / `NODE_OPTIONS` / `NODE_PATH` / `PATH`。用户今天已经能通过启动面板把 `HTTP_PROXY`、`NODE_EXTRA_CA_CERTS`、`npm_config_*` 塞进 dsh 子进程，只是没有校验、也进不了 pnpm。

## 2. 一条不变式

> **任何一次"选版本 / 选包"，和随后的"取包"，必须问同一个 registry。**

这条把 8 处 fetch 和所有 `pnpm add` 收成一个策略对象，而不是给每个调用点加一个设置项。

## 3. 策略对象

```ts
EgressPolicy {
  registries: { default?: string; scopes: Record<string, string> }
  auth:       { default?: string; scopes: Record<string, string> }   // 明文只在内存
  tls:         { caFile?: string; insecure?: boolean }
}
```

> **落地形态与上面不同（现状）**：实际实现的是一个更窄的 `core/store/registry.ts` —— 只有 `registryUrl` 一个字符串设置，导出 `registryBase()`（校验 URL、去尾斜杠、不可用时告警并回退 `PUBLIC_REGISTRY`），**没有** `EgressPolicy` 对象，也没有 scopes / auth / tls 段。下表是「待做的形状」。

设置项沿用仓库已有的两个先例：

| 字段 | 形态 | 先例 |
|---|---|---|
| `registryUrl?` | 普通字符串 | `marketUrl`（`normalize.ts:47`） |
| `registryScopes?` | `Record<string,string>` | `mcpLibrary` 的记录型先例 |
| `registryTokenEnc?` | secret-at-rest | `githubTokenEnc`（`normalize.ts:50`） |
| `registryScopeTokensEnc?` | `Record<string,string>` secret | `mcpSecrets`（`normalize.ts:55`） |

**secret 段直接复用 `settings/secret-at-rest.ts` 的 `createSecretCodec`**：`plain:` 前缀诚实降级、`exportSettings` 剥离、`importSettings` 保留本机值。三条规矩一条不改。

`marketSource/marketUrl` 与 `githubTokenEnc` **保持独立**：它们是不同种类的出口（目录服务 / 代码托管），硬塞进一个策略只会让语义变糊。但它们共用"用户把自己的端点指给 app"这个模式。

## 4. 消费者一：launcher 的 fetch

`npm.ts` 不再拼常量，改成从一个纯函数取 URL：

```
resolveRegistryUrl(policy, packageName) →
  policy.registries.scopes[scopeOf(name)] ?? policy.registries.default ?? 'https://registry.npmjs.org'
```

**已落地**：两处都改为 `registryBase()`（`store/npm.ts:60` / `:72`），dsh 的安装与更新检查一并受益；落地名是 `registryBase()`，不是设计里的 `resolveRegistryUrl(policy, …)`。
**未落地**：`npmSearch` 的「该源不支持搜索」降级、Bearer 认证。

- **`fetchPackageVersions` 必须无条件走策略。** 它是 dsh 安装/更新的前置（`dsh/install.ts:97`、`:186`），不修这一条，air-gapped 场景无解。
- **`npmSearch` 要能降级。** `/-/v1/search` 不是 npm 协议的一部分：Verdaccio 有，Artifactory / Nexus 常只给 404 或 501。策略要允许"这个源不支持搜索"，此时 UI 明说「该源不支持搜索，请直接输入包名」，而不是把 404 报成"搜索失败"。**这是私有源适配里最容易踩的一脚。**
- **认证。** npm 兼容私有源用 `Authorization: Bearer <token>`，scope 表优先于 default。

## 5. 消费者二：pnpm

### 5.1 先把"谁拥有这个工程"说清楚

> **未落地（现状）**：`skipStoreDir` 仍在（`dsh/pnpm.ts:196` / `:199`、`store/dev.ts:473` / `:485`、`dsh/pnpm.test.ts:211`），`project: 'launcher' | 'user'` 尚未引入。

今天 launcher 判断"这是用户的仓库还是我的"用的是 `skipStoreDir`，判据散在 `pack.ts:106`、`dev.ts:473`、`dev.ts:485` 三处。写 `.npmrc` 需要**同一个**判据，所以把它升成一个显式概念：

```
runPnpm(cwd, args, signal, { project: 'launcher' | 'user', storeDir? })
  project: 'launcher' → 注入 --store-dir 与 launcher 的 registry 策略
  project: 'user'     → 两者都不注入（今天就是 skipStoreDir: true）
```

`pack`（造 tarball）与 `pnpm run <script>` 天然是 `'user'`；`installDevDeps` 也是 `'user'` —— 用户在自己仓库里 `pnpm install`，用的是那个仓库自己的 `.npmrc`，launcher 不该插手。archive 的 `.staging`、archive 版本目录、profile 目录是 `'launcher'`。

这一步同时消掉 `skipStoreDir` 这个名字与用途不符的问题：它现在其实表达的是"工程归属"，而不是"要不要 store 目录"。

### 5.2 URL 与凭据走两条不同的路

| 内容 | 载体 | 理由 |
|---|---|---|
| `registry` / `@scope:registry` / `strict-ssl` / `ca` | **写 `.npmrc`** | 与已经写在同一批目录里的 `PNPM_WORKSPACE_YAML`（`pnpm.ts:25`，4 个写点：`store/install.ts` ×2、`profile/lifecycle.ts`、`profile/export.ts`）是同一批写点、同一批生命周期；用户调试时直接看得见 |
| `registry` / `@scope:registry`（**同时**） | **注入 pnpm 子进程 env** | 见下：**env 的优先级高于文件**，只写文件会被机器上遗留的环境变量静默压过 |
| `_authToken` | **只走 env** | 落到文件里的凭据必然明文。token 不进磁盘是这个设计里唯一不能妥协的一条 |

### 5.2a 实测：载体是 `.npmrc`，而且 env 会盖过文件

三个 spike，同一套 harness（本地 tarball 依赖真实 registry 包，装进指向 `127.0.0.1:9` 的工程），带**反向对照**：

| 载体 | 结果 |
|---|---|
| env `npm_config_registry`（对照组） | ✅ 生效：`ERR_PNPM_META_FETCH_FAIL … ECONNREFUSED 127.0.0.1:9` |
| `pnpm-workspace.yaml` 的 `registry:` | ❌ **静默忽略**：安装照常从公共源成功，无警告 |
| `.npmrc` 的 `registry=` | ✅ 生效：同样的 `ECONNREFUSED` |

两点结论，都与本文早先的写法相反：

1. **`pnpm-workspace.yaml` 不读 `registry`。** 早先只验证了它被当作设置文件读（`autoInstallPeers` / `onlyBuiltDependencies` 生效），据此推断 `registry` 也在其中 —— **推断错了**。载体是 `.npmrc`。
2. **env 优先级高于两个文件。** 这台机器的环境里就带着 `npm_config_registry=https://registry.npmmirror.com`，而 `runPnpm` 原样透传 `process.env`。所以**只写文件是不够的**：一个自部署源会被机器上遗留的环境变量悄悄压过去，而这正是本文要消灭的那类 bug。两个载体必须一起写。

（第一轮 spike 因为没清掉环境变量而测错了东西 —— 两次都"成功"，看起来像两个载体都不生效。`pnpm config get registry` 直接暴露了原因。反向对照就是为了防止把"harness 没测到"读成"机制不成立"。）

`_authToken` 的 env key `npm_config_//<host>/:_authToken`（key 含 `:` 与 `/`）已在 Windows 上实测通过，`spawn` 原样传递，无需退路。

env 形式：`npm_config_//<host>/:_authToken`。**这一条需要在 Windows 上实测** —— key 里含 `:` 与 `/`，Node 的 `spawn` 接受任意字符串 key，但 Windows 的环境块对 key 字符集历来更严。若不可用，退路是 `npm_config_@<scope>:_authToken`（不含 `//`），或退回"token 明文写 `.npmrc` 且在 UI 上明说"。

### 5.3 凭据不进 pnpm 之外的地方

GitHub token 今天只做 HTTP header，从不进任何子进程环境；MCP 密钥则明确注入 dsh 子进程（`ipc/dsh/run.ts:258`）。**registry token 归前者**：它只服务 launcher 自己的 fetch 和 pnpm 的 auth，两者都是"工具"而不是"用户进程"。不需要进 dsh 子进程。

## 6. 消费者三：证书与代理

- **CA。** `NODE_EXTRA_CA_CERTS` 由 undici 在**进程启动时**读取一次。所以 launcher 要支持自签 CA，只能在 `main/index.ts` 最早的时机（`app.whenReady` 之前）把设置里的 CA 路径写进自己的 `process.env`。这是一个边界清楚的做法，写进文档与代码注释。pnpm 侧则写进 `.npmrc` 的 `ca=`。
- **`insecure`（`strict-ssl=false`）。** 只写 `.npmrc`；launcher 自己的 fetch **不做** —— 它对应的是 `NODE_TLS_REJECT_UNAUTHORIZED=0`，全局关掉校验对一个桌面应用来说代价太大。
- **代理。** launcher 的 fetch 不读 `HTTP_PROXY`，要支持只能引 undici 的 `ProxyAgent`（新依赖）。**本期明确不做**，在文档里写清"launcher 的搜索与版本查询不走代理；pnpm 走"。

## 7. 不变式

1. **只对 launcher 拥有的工程写 registry 配置。** 用户仓库的 `.npmrc` 永远赢。
2. **profile 目录里的 registry 配置属于 launcher 拥有的工程**，这不是 launcher 私有状态：`DSH_HOME=<home> dsh --profile x` 直接启动时读的是同一份，行为一致（符合 `docs/specs/profile.md` §4 写入契约与 P4）。
3. `token` 永不进磁盘`，secret 段与 `githubTokenEnc` 同构。
4. **解析与获取同源**（§2）。
5. 设置是纯增字段，`normalize.ts` 不需要数据迁移步骤；但 `CURRENT_SCHEMA_VERSION` 要随之递增 —— `importSettings` 靠版本号拒绝更新的导出，否则新字段会被静静默丢掉。**已发生**：`registryUrl` 落地时版本 2 → 3（`normalize.ts:101` 的迁移注释）。

## 8. 分期

| 期 | 内容 | 验收 |
|---|---|---|
| ~~P0~~ ✅ 已完成 | `registryUrl` 进 `npm.ts` 的两处 + `dsh/install.ts` 的版本解析 | 私有源可达时能查版本、能装 dsh；**pnpm 侧仍读用户的 `.npmrc`**（见 §5） |
| P1 | `runPnpm` 的 `project` 概念（取代 `skipStoreDir`）+ `.npmrc` 写点 + env 注入（只 URL / CA / strict-ssl） | 用户仓库里的 `pnpm install` 不受 launcher 设置影响；archive 与 profile 走私有源；机器上遗留的 `npm_config_registry` 不再压过 launcher 的设置 |
| P2 | token：secret-at-rest 存、`npm_config_…:_authToken` 注入 pnpm、Bearer 进 launcher 的 fetch；`npmSearch` 的降级 | 磁盘上 grep 不到凭据；不支持搜索的源给出明确文案 |
| P3 | scope 表 + `tls.caFile` 在 main 入口最早时机生效 + 文档 | 多源共存；自签 CA 下 launcher 与 pnpm 行为一致 |

## 9. 实测与待实测

**已实测（见 §5.2a）**

1. `pnpm-workspace.yaml` **不读** `registry` —— 静默忽略，无警告。反向对照证明 harness 有效。
2. `.npmrc` 的 `registry=` **生效**。
3. env 的优先级**高于**这两个文件；这台机器的环境里就带着 `npm_config_registry`，`runPnpm` 原样透传。
4. `npm_config_//<host>/:_authToken`（key 含 `:` 与 `/`）在 Windows `spawn` 上原样传递成功，无需退路。

**待实测**

5. 目标私有源对 `/-/v1/search` 的支持情况（决定 P2 降级文案是"常见情况"还是"个别情况"）。
6. `NODE_EXTRA_CA_CERTS` 在 Electron main 进程启动早期设置是否被 undici 采纳（P3 的整个 CA 支持都挂在这上面；不通过则删除该部分，不留半成品）。

## 10. 明确不做

- 不做 launcher 自己 fetch 的代理支持（§6）。
- 不做 `registry.insecure` 对 launcher 自己 fetch 的对应项（§6）。
- 不把 `marketUrl` 与 `githubTokenEnc` 并进同一个策略对象（§3）。
- 不动 profile 的 `package.json` 契约；`.npmrc` 是 pnpm 的文件，不是 profile 清单的字段。
