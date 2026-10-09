# 缺陷修复计划（2026-10 代码审查）

> 状态：**P0 已完成（4 条，含施工中新发现的 A7）；F1、B4、F9、B2、B10、B3、B1、A4、A5、B5、B6、B7、B8、B9、F3、F2、F5、F6、F7、F8 已完成，并带出施工中新发现的 F10；其余 2 条（F4、A6）待实验确证后施工**。这是一份施工计划，不是规范。
> 来源：对 `feature/preset-management` 三块功能代码的审查（preset 功能、dev 插件 pnpm pack 快照、registry/skills 修复）。
> 定位：每条修完后 —— 仍生效的规则上收 `docs/specs/` 或 `docs/presets.md`，测试进仓库，然后**从本文删掉该条**。本文清空即代表这批缺陷关闭。

审查只做了读码与定点实测，所以每条都附带「验证」一栏，说明用什么测试把它钉住。（原文此处写「本沙箱 `pnpm test` 受 esbuild `spawn EPERM` 无法运行」——**该限制已解除**：文件策略放宽后整套 `pnpm test` 在本机可跑，82 files / 1050 tests 全绿，见 §7。）

## 0. 批次与顺序

| 批次 | 条目 | 为什么是这个顺序 |
|---|---|---|
| **P0 硬后果** ✅ | ~~A2、A1、A3~~（+ 施工中新发现的 **A7**） | 会静默把 profile 指向错误的构建，或让包/文件名可控的字符串决定写入/递归删除的路径。**已完成**，见 §1 |
| **P1 正确性与信息丢失** ✅ | ~~F1、B4、F9、B2、B3、B1、A4、A5、B5、B6~~（+ 施工中新发现的 **F10**）、~~F3~~ | 守卫失效、功能做完却不可达、诊断被丢掉、选错版本、归档不可修复、清单先改后失败。**F1 / B4 / F10 见 §2.1，F9 / B2 见 §2.2，B3 / B1 见 §2.3，A4 / A5 见 §2.4，B5 / B6 见 §2.5，F3 见 §3.2** |
| **P2 一致性与性能** ✅ | ~~B10~~（见 §2.2）、~~B7、B8、B9~~（见 §3.1）、~~F2、F5、F6、F7、F8~~（见 §3.2） | 文案/范围不一致、幻影根、缓存与 i18n 瑕疵 |
| **先确证再定方案** | F4、A6 | 取决于宿主真实行为 / 数据根搬迁是否改变大小写，先做实验再改 |

**已定决策**（2026-10-02 评审）：
- **F2 → 方案 B**：home 层 declaration 在预设页**只读**，写入一律走 profile 层。连带效果是现有删除确认文案自动变正确（方案 A 才需要新增层级文案）。
- **B10 → 接线**：补齐 dsh 侧 skill 创作的 IPC 与页面入口（复用现成 UI 组件），**不删码**；同批把 F9（技能页 profile 选择）与 B2（zip 覆盖守卫）一起做，因为它们动的是同一个面板与同一条路径。

**仍待确证**：**F4**（宿主是否按声明层 base 解析相对 `file:`）、**A6**（数据根搬迁是否改变路径大小写）。这两条在拿到实验结论前不要动代码。

建议一条一个提交，提交信息写清「修的是哪一类失败」，并带上本文件的条目编号（例如 `docs/design/fixes.md A2`），这样关掉本文件后仍能从提交历史追溯到当时的判定依据。

---

## 1. P0 ✅ 已完成（2026-10-09）

四条都已在 `feature/preset-management` 上修完、带测试、三闸全绿。仍生效的规则已上收
[`specs/profile.md` §8](../specs/profile.md)（**P7** 路径段守卫 / **P8** 版本归属），本节只留账目。

| 条目 | 修法 | 测试 | 上收 |
|---|---|---|---|
| **A2** | `installSource` 成功返回带回它实际归档的 `version`（新 `InstallResult`），`snapshotDevPlugin` 用它，不再用 `latestStoreVersion` 猜「刚归档的是哪个」 | `store/dev-plugins.test.ts`「points profiles at the version it just archived」——临时还原修复即报 `expected '9.9.9' to be '0.1.0'` | P8 |
| **A1** | `installSource` 在拼 `archive/<name>/<version>` 与 `.trash` 之前对包自报版本过 `versionInvalid`（拒 `..`、分隔符、`:`、空）；`readVersion` 只接受字符串 | `store/store.test.ts`：恶意版本 7 例（`..` `../x` `1/2` `1\2` `C:evil` `a..b` `''`）全部拒绝且归档与 `.trash` 原样 + 合法版本 2 例（`2.1.0-beta.1`、`1.0.0+build.7`）+ 已存在分支也回传版本 | P7 |
| **A3** | `packDevPackage` 在拼 `<store>/.pack/<name>`（随后递归删除）之前过 `pathIdentifierInvalid` | `store/pack.test.ts`：`../evil` 拒绝且 `<store>/../evil` 不存在；`@scope/pkg` 仍落在 `.pack/@scope/pkg` | P7 |
| **A7** ★施工中新发现 | `pathIdentifierInvalid` 增加「拒绝一切纯点号 token」；`addLocalPlugin` 对 zip 文件名**去掉 `.zip` 后缀后的段**过同一守卫 | `ipc/validate.test.ts` 全点号 token 三例；`store/plugins.test.ts` 导入 `...zip` 被拒 | P7 |

**A7 现象**（原 25 条审查未发现，是在为 P7 逐点核对拼装点时实测确认的）：`addLocalPlugin` 用所选 zip 的
**文件名**拼解压目录。`basename('...zip')` 去掉 `.zip` 后缀恰好是 `..`，于是 `join(storeDir, '.import', '..')`
**就是 store 根**，紧接着的 `rmSync(dest, { recursive: true, force: true })` 会把整个插件库（所有归档版本、
`.pack` 里的 tarball、来源记录）删掉再重建为空。触发条件是用户导入一个名为 `...zip` 的文件 —— Windows
允许创建该名。实测：把守卫改成 `false` 后，`store/plugins.test.ts` 里预置的 `archive/keep.txt` 断言
`expected false to be true`，即归档确实已被删除；恢复守卫即通过。

> 同批顺带修掉一处**仓库既有的编码损坏**：`src/main/core/store/pack.test.ts` 里一个破折号在提交
> `008d8c8` 中被写成 `E2 80 3F`（UTF-8 破折号第三字节退化成 `?`），使该文件不是合法 UTF-8、工具直接
> 拒读。已按字节修复为 `E2 80 94`（全仓 1800+ 个被跟踪文件中仅此一处，`build/icon.ico` 是二进制）。


---

## 2. P1

## 2.1 ✅ 已完成（2026-10-09）：F1、F10、B4

仍生效的规则已上收 [`specs/profile.md`](../specs/profile.md)：**F1** → §5（占用判定必须与启动预检同源）、
**F10** → §4（补丁读写容忍 CRLF）、**B4** → §8 的 **P9**（registry 侧"最新"以 `dist-tags.latest` 为准）。

| 条目 | 修法 | 测试 | 上收 |
|---|---|---|---|
| **F1** | `assertDeclaredIdFree` 的裸文本搜索换成与启动预检同源的 `collectInsertIds`（结构遍历） | `ipc/presets/presets.test.ts`：同一既有行在 4 种行形态（LF / CRLF / 无尾换行 / 多一个空格）下都必须拒绝；另一例断言 `config.plugins` 名册里的同形 id **不得**误拒。反向校验：还原成文本包含后 CRLF 那例**真的写成了**（`ok:true`），即写出一个宿主拒绝启动的 profile | §5 |
| **F10** ★施工中新发现 | `patch.ts` 增加唯一的行构建器 `patchLines`（剥掉行尾 `\r`），替换 15 处 `split('\n')`；写入由此统一为 LF | `patch/patch.test.ts` 新增「CRLF patch files」3 例：与 LF 孪生的取值逐项相等、`disabled` 仍读成 true、编辑后无 `\r` 残留；IPC 侧断言 CRLF 下名册仍含源 preset。反向校验：还原后 4 例全挂，含端到端「名册只剩 `standard`」 | §4 |
| **B4** | 新增 `shared/version.ts` 的 `latestPackageVersion(info)`（`compareVersionsLoose` 一并搬到跨进程模块，按 `majorOfVersion` 的先例在主侧 re-export），四个站点改为调它：`dsh/install.ts:98,187`、`store/updates.ts:69`、`DownloadVersionModal.tsx:41`、`OfficialInstallModal.tsx:60` | `core/shared/version.test.ts` 新增 4 例：tag 优先；无 tag 时乱序 `['0.0.3','1.3.0','0.0.9']` 解出 `1.3.0`；tag 指向不在表里的版本则忽略；空包 undefined。反向校验：还原成取下标后 2 例挂 | §8 P9 |

**F10 现象**（原 25 条审查未发现，是在实现 F1 时按本文验证栏的 CRLF 用例实测出来的）：JS 的 `.` **不匹配 `\r`**，
而 `(.*)$` 的 `$` 只匹配串尾 —— 所以对一条以 `\r` 结尾的行，取值正则**整个匹配失败**，而不是多捕一个字符。
`patch.ts` 的 `directChild` / `ownKey` / `extractKeyValue` 全用这个形状，于是一份 CRLF 的 `cordis.patch.yml`：

- `name:` 读不出来 → 声明模型的**名册整份消失**（实测 `preset:list` 只剩 bundle 层那一个 preset，且无任何告警）；
- `disabled:` 读不出来 → 被禁用的行会被当成生效的行；
- `insert:` 读不出来 → `collectInsertIds` 返回空 → **`run:start` 的重复行预检静默漏报**，用户要到宿主启动失败才知道。

这同时说明 F1 的原方案**不足以**修好 CRLF 那一例：换成 `collectInsertIds` 之后，若不同时修 F10，结构遍历在 CRLF 上
同样什么都看不见。两条必须同一批做（这就是它们同一个提交的原因）。触发条件是常规操作：Windows 编辑器把 LF 文件
存成 CRLF（本机 `core.autocrlf=true` 也在放大这个面），而 Launcher 自己写的补丁是 LF。

## 2.2 ✅ 已完成（2026-10-09）：F9、B2、B10

这三条是一件事的三面：技能页上"看得见"（F9）、"做得成"（B10）、"不覆盖别人的东西"（B2）。
仍生效的规则已上收 [`specs/extensions.md`](../specs/extensions.md) §3.3，测试锚点见该文件 §5。

| 条目 | 修法 | 测试 |
|---|---|---|
| **F9** | `SkillsManagePanel` 自己管 profile 选择（`dsh.profiles` + `Select`，可清空）；`DshSection` 不再写死 `profile={null}`；未选 profile 时页面用 `Alert` 明说 preset 根不列出。选择规则抽成 `renderer/src/lib/profileScope.ts` 的 `nextProfileChoice`，与 `PresetsSection` 共用（消掉两处重复） | `renderer/src/lib/profileScope.test.ts`：记住仍在的 profile / 否则取首个 / 无 profile 时为 `undefined`（这个"机器级视图"是有意义的答案）。页面那半由 **B3/B1 那批补上的渲染断言**回填（`dshSkillsPanelRender.test.tsx`：Profile 选择器在位、未选时明说 preset 根不列出、创作入口与拖放块在位）—— 做 F9 时仓库还没有 views 测试入口，那时只能靠读码与构建；唯一仍未断言的是需要 effect 的行为（"选了 profile 后确实以它调用 `ext:skillList`"），由核心侧 `preset-roots.test.ts` 与读码覆盖 |
| **B2** | `installZipSkills` 第 2 趟复制前**再查一次** `exists(name)`（命中即 `extSkillExists`），并把 `cpSync` 改为 `errorOnExist: true, force: false` | `skills.test.ts`：探针第一次说空闲、第二次说占用 → `ext.skillExists` 且目标根没多出目录；探针**恒**说空闲但目标已存在 → 文件系统拒绝且既有 SKILL.md 未被改写。反向校验：还原任一半都返回 `(no throw)`（静默覆盖） |
| **B10** | 接通 dsh 侧创作面：core 补**新建拒绝覆盖**守卫；IPC 加 `ext:skillRead` / `ext:skillSave` / `ext:skillImportZip`（外加 `ext:skillScaffold`，让 dsh 流程不必借用库命名空间）；`shared/api.ts` + preload 各补 4 个方法；面板动作行补「新建 Skill / 从 ZIP 导入」、可写行补「编辑」、底部加可拖放的 `DropZone`（复用现成的 `SkillEditorModal` / `SkillNameModal` / `DropZone`）。顺带把可写根之外的读 / 写 / 删从 `internal` 改成 `ext.skillReadOnly` | `skills.test.ts`：新建撞既有 bundle 目录 / 既有扁平文件都拒绝且原文件未被改写；`extensions.test.ts`：scaffold→save→read 回读、frontmatter 改名、新建撞名返回 `ext.skillExists`、`../escape` 与 300 KB 文本被拒、zip 导入落进可写根、非 zip 路径返回 `ext.skillZipNotZip`。反向校验：还原守卫后 IPC 那级返回 `ok:true`（**静默覆盖**），核心两例同时挂 |

## 2.3 ✅ 已完成（2026-10-09）：B3、B1

这两条是同一条链：库扫描的**降级**（B3）决定"读不出"是一个状态，页面的**可见性**（B1）决定那个状态
能不能被用户认出来。仍生效的规则已上收 [`specs/extensions.md`](../specs/extensions.md) §3.4（三种"读不出"
的归属 + `problem` 必须可见），测试锚点见该文件 §5。

| 条目 | 修法 | 测试 |
|---|---|---|
| **B3** | `listSkillLibrary` 的两处读取统一走新的 `readSkillText`（返回 `{ok,text}` / `{ok:false,reason}`）：读不出即 push 一条 issue（路径 + 错误文本），**不再抛**。`scanSkillInstalls` 同时改为**如实报告 `installed`**：条目在扫描与比较之间变得不可读时，仍回答"装没装"，只把 `stale` 置真并带上 `problem`（旧代码对每个 dsh 都说"未安装"） | `skill-library.test.ts`：不可读条目出现在 **issues**（`listSkillLibrary()` 本身，不是绕过它调 `scanSkillInstalls`）、可读邻居保住结论；只有条目不可读而副本还在时 → `installed:true, stale:true, problem`。`extensions.test.ts` 新增「the library channels」：条目不可读时 `ext:libSkillList` / `ext:libSkillOverview` **仍 `ok:true`**。反向校验：还原守卫 → core 抛 `EISDIR`、IPC 返回 `ok:false`（整页死掉） |
| **B1** | `problem` 在三个落点可见：库卡片加问题标签（tooltip 带 `dsh: 理由`，且**不再**显示"库有更新/已是最新"这类结论）、安装弹窗用 `Alert` 给理由原文并把主按钮改成「仍要重装」、dsh 面板行上同样带问题标签。状态判定收敛到 `renderer/src/lib/skillInstallState.ts`（`problem` 压过一切），三个组件共用 | `skillInstallState.test.ts`：`problem` 压过 `installed`/`stale` 的一切组合；状态 → 标签/颜色映射。**渲染断言**（本批新开的基建）：`skillInstallRender.test.tsx` 断言卡片出现 `Unreadable (1)` 且**不**出现 `Library has updates`、弹窗出现理由原文与「仍要重装」；`dshSkillsPanelRender.test.tsx` 断言未选 profile 时面板明说 preset 根不列出、创作入口与拖放块在位。反向校验：还原优先级 → 单元格变回 `notInstalled`、弹窗显示陈旧提示；去掉卡片的问题标签 → 渲染断言失败（证明确实钉住了组件接线，不只是纯函数） |

**顺带补上的基建**：`vitest.config.ts` 的白名单加入 `src/renderer/src/views/**/*.test.tsx`，渲染断言用
`react-dom/server`（`react-dom` 已是运行时依赖，**没有新依赖、没有 DOM**），coverage 仍只统计 `core`。
约定与三条边界（`Modal` 走 portal → 拆出 `InstallSkillFields`；tooltip 悬停才渲染；effect 不跑）写进了
[`docs/TESTING.md`](../TESTING.md) §4。这条基建也**回填了 F9 的验证**（见 §2.2 那一行）。

## 2.4 ✅ 已完成（2026-10-09）：A4、A5

两条都在 store 的"先动盘、再验证"上：A4 是**产物被下一次操作删掉**（旧归档从此修不好），
A5 是**清单被写坏而没人放回**（profile 之后每次装不干净）。仍生效的规则上收
[`specs/profile.md`](../specs/profile.md)：A4 → §8 **P10**（pack 按版本分层 + 版本段守卫），
A5 → §4（改清单前先留原文，失败即恢复）。

| 条目 | 修法 | 测试 |
|---|---|---|
| **A4** | `packDir(storeDir, name, version)` → `<store>/.pack/<name>/<version>/`，`packDevPackage` 只清理该版本自己的目录；顶部注释写明「同版本=有意替换、跨版本=各自留存」。**顺带把版本也守住**：版本从此是路径段且该目录被递归删除，而它来自 dev 包自己的 manifest —— 与 A3/A7 同一类，`versionInvalid` 一并拒绝（空串会让路径塌回"所有版本"那层） | `pack.test.ts`：两个版本各 pack 一次 → `1.0.0` 的 tgz 仍在；同版本重复 pack 仍替换自己那份；版本 `..` / `../evil` / `1/2` / `''` 全部拒绝且不调用 pnpm、`.pack/@me` 与"所有版本"目录都没被碰。反向校验：还原成分版本前的目录 → 5 例挂（含 `ENOENT …/1.0.0`）；去掉版本守卫 → pack"成功"写进了 `.pack/@me\x.tgz`（版本段越出包目录，而 `rmSync` 已清掉该 scope 的家） |
| **A5** | `installIntoProfile` 进函数即留 `originalManifestText`，`restoreManifest()` 把原文逐字节写回；`pnpm install` 失败与"改写之后的任何异常"（含 bundle 层那次追加）都恢复，文案里说明「清单已恢复原样」 | `plugins.test.ts`：install 失败后 `package.json` 与调用前**逐字节相同**（原来有 `link:` 依赖的也恢复成 `link:`，不是删掉了事）；profile 不存在时目录不会被创建；成功路径**不会**误恢复（依赖照旧写入）。反向校验：注释掉恢复 → 失败后清单里留着 `"pkg-a": "file:…"`（指向不存在的包） |

> A5 的 catch 分支（改写之后的异常）是**防御网**：两次写入同一路径，第二次失败需要磁盘级故障才触发，
> 单测里造不出来 —— 这里如实记下，不假装它被覆盖。

## 2.5 ✅ 已完成（2026-10-09）：B5、B6

同一个读取路径（`readSkillFsConfig` + `skillRoots`）上的两处取值守卫，判据收敛成一个 `pathOverride`。
仍生效的规则上收 [`specs/extensions.md`](../specs/extensions.md) §3.1（四个 config 路径字段一视同仁、
空白即未配置）。

| 条目 | 修法 | 测试 |
|---|---|---|
| **B5** | `dshHome` / `agentsHome` / `bundledSkillDir` 与 `customSkillDirs` 一视同仁：命中 `isJsExpr` 即视为**未配置**，绝不 `resolve`。`dshHome` 是四个里最严重的 —— 它**替换**真实可写根，被哨兵顶掉后 `user-dsh` 从列表里消失，同时报出一个 writable 的幻影根 | `skills.test.ts`：`!!js dshHome` → `user-dsh` 仍在、`path` 就是 `<home>/skills`、`writable: true`、无哨兵字节；`!!js agentsHome` + `bundledSkillDir` → 不新增根、`user-agents` 退回默认。反向校验：还原旧行为 → 3 例挂（可写根被替掉、多出幻影根、空白字段落进 cwd） |
| **B6** | 空白（`''` 或纯空格）在 **config 与环境变量两侧**都等于未配置：`resolve('')` 是当前工作目录而它存在，扫描器会走进 Launcher 的 cwd，把那里的 `SKILL.md` / `*.md` 当成这个 dsh 的技能。`??` 不吃 `''`，所以 env 覆盖显式判空 | `skills.test.ts`：`DSH_AGENTS_HOME=''` / `DSH_BUNDLED_SKILL_DIR=''` 的解析结果与**未设置完全相同**，且没有根落在 cwd；另一例断言非空 env 覆盖仍然生效（守卫必须能区分"空白"与"已设置"）。反向校验：还原 `??` → 空白 env 多出一个根 |

### F3 —— 同一 loader 行 id 被两次 insert 时静默折叠，页面显示成健康名册

**已修**，与 P2 的五条同批：账目见 §3.2。



---
## 3. P2

## 3.1 ✅ 已完成（2026-10-09）：B7、B8、B9

都是"信息层面"的小修，但三条共享一个后果：**用户拿到的答案看起来像事实，却与他的实际处境无关** ——
旧源的更新结论、裸 code、被丢掉的 URL。仍生效的规则上收：B7 → [`specs/profile.md`](../specs/profile.md)
§8 **P11**（缓存键必须覆盖答案依赖的输入）；B8/B9 → [`ui-guidelines.md`](../ui-guidelines.md) §4/§7
（错误码是契约、每个 code 两种语言、拒绝要带上"是哪一次拒绝"）。

| 条目 | 修法 | 测试 |
|---|---|---|
| **B7** | `store/updates.ts` 的 `cacheKey` 加上 `registryBase()` —— 「最新版本」来自某个 HOST，换源会同时改变每一行的答案 | `store/updates.test.ts`（新建）：两个镜像给出不同 `latest`，先 A 后 B → 第二次拿到 **B** 的结论；另一例断言同一源**仍然命中**缓存（别把缓存修没了）。反向校验：去掉 registryBase → 第二次仍报 A 的 `1.1.0`，且全程只有一次 fetch（缓存确实命中了） |
| **B8** | 补齐 8 个缺失的 `errors.*` 键（en/zh 成对、占位一致）：`dsh.notManaged` / `dsh.upToDate` / `dsh.majorRisk` / `profile.exists` / `profile.notFound` / `npm.notFound` / `yaml.invalid` / `trash.conflict`；顺带把 `profile.notFound` 的两处调用统一到 `{ detail }`（`ipc/profile/read.ts` 原传 `profile`，会让文案里的 `{{detail}}` 渲染成占位符）。**新增全量对照测试**：`E` 的每个 code 都必须在两种语言里有 `errors.<code>` | `i18n.test.ts`：新增「每个 error code 都有两种语言文案」（全量，不留例外）+「带 `detail` 的码会把参数渲染进句子」。反向校验：两侧**同时**删掉 `errors.profile.notFound` → 对照测试点名 `zh is missing "errors.profile.notFound"`，而 key 对齐那条**不挂**（证明是这个测试在起作用） |
| **B9** | 新增 `registry.badUrl` / `registry.badScheme` 两个专用码 + 两个 locale；`settings:setRegistryUrl` 的两处拒绝改为 `fail(code, { detail: raw })`。原来复用 `name.invalid`，而 `apiErrorText` **优先**返回本地化文案，于是「名称不合法」把"哪个 URL 被拒"彻底丢掉 | `ipc/app/settings.test.ts`（新建）：坏 URL → `registry.badUrl` 且 `params.detail` 保留原文；非 http(s) → `registry.badScheme`；合法镜像仍接受并去掉尾斜杠；空值清空不算错误。反向校验：还原 `E.nameInvalid` → code 与 params 都对不上，断言失败 |

**顺带调整的落点**：错误码表从 `core/shared/errors.ts` 移到 **`src/shared/error-codes.ts`**（主侧 re-export，
导入路径不变）。原因是 `tsconfig.web.json` 拒绝渲染层引用 `src/main/**`，而上面那条对照测试**必须**同时
看到码表与译文 —— 错误码本来就跨进程（渲染层按 code 取文案），放 `src/shared/` 是它本来的位置。
另外 8 个码里有 4 个（`profile.exists` / `npm.notFound` / `yaml.invalid` / `trash.conflict`）目前没有生产
调用点，是测试里的示例码；文案照样补齐，好让"每个 code 都有文案"这条不变量**没有例外**要记。

## 3.2 ✅ 已完成（2026-10-09）：F3、F2、F5、F6、F7、F8

六条都在 preset 门面内，共享同一条判断：**页面与 core 必须是同一个判据，而且话要说到点上** ——
本页该不该写这一层、守卫失效、被折叠吃掉的启动失败、看不出来的"已占用"、说不出理由的来源。
仍生效的规则上收 [`docs/presets.md`](../presets.md) §1（`none` 模型不列来源）/ §3.2（折叠、借来的 id、
重复 insert）/ §3.3（本页只写 profile 层、两个只读原因）/ §6（各动作的口径）；
测试侧的边界与"调用次数"手法上收 [`docs/TESTING.md`](../TESTING.md) §4。

| 条目 | 修法 | 测试 |
|---|---|---|
| **F3** | `readDeclarations` 的折叠看不出"两层各 insert 同一个 loader row id"—— 那正是它存在的理由（后一层用同一 row id 替换）—— 而宿主对此以 `duplicate loader entry id` **拒绝启动整个 profile**。改为在折叠之外按 `collectInsertIds`（与启动预检 `findInsertConflicts` 同一个结构遍历）数每个 row id 被 insert 的次数，只对**本名册自己的 row id**（折叠里出现过的）报 warning，措辞用宿主那句 | `declaration.test.ts` 3 例：两层同 insert 一行 → `presets` 只剩一条而 `warnings` 点名两个文件与 `duplicate loader entry id`；只写 `- id: x` + `disabled:` 的合法覆盖 → 无 warning；两层 insert 同一个**插件**行 → 本页不说话（那是 profile 页的账）。IPC 侧：同一 profile 的 bundle 层与 profile 层各 insert `preset-standard` → 页面收到该 warning。反向校验：注释掉计数 → **只有这一例挂**（其余 25 例全过） |
| **F2** | `declarationItem` 的 `editable` 从"非 bundle"收成"就是 profile 层"，`assertEditable` 用同一判据（显示侧与后端同源，`store/refstate.ts:18-20` 那条规矩的两个方向）；home 层用**新码** `preset.homeReadOnly` 拒绝（bundle 仍 `preset.readOnly`），行上的只读原因也分成 `preset.homeReadOnlyHint` / `preset.readOnlyHint`；复制仍允许以 home 声明为**源**。连带效果：删除确认文案「声明式的会从 profile 补丁里移除」在这个口径下自动正确 | IPC：home 层声明 → `editable:false, source:'home', trust:'user'`；`preset:saveMeta` / `preset:delete` → `preset.homeReadOnly`，且 home 补丁与 profile 补丁**逐字节未变**；`preset:copy` 以它为源仍成功并落在 profile 层。渲染侧：`lib/presetRow.test.ts` 断言 home 行只剩复制、原因键取 home 那条（不是内置那条）。反向校验两条：还原 `assertEditable` → saveMeta 返回 `ok:true`（**真的写了机器级补丁**）；还原 `editable` → 该行变成可编辑 |
| **F5** | `DeclaredPreset` 增内部标记 `idFromRow`；折叠的"先到先得"只为 `config.id` 真正可用的条目登记与比较 —— 借 row id 当身份的坏行仍进名册（带自己的 `broken`）但**永不占位**。读到的 `config.id` 另过 `PRESET_ID_RE`，不合规则标 `broken`（理由写明宿主也会拒），id 按文件原样显示。**显示侧连带**（施工中新发现）：名册因此可能出现两行同 id，行 key 改成 id+来源+broken 的复合键，评级改按名册位置取（`grades` 与 `presets` 由同一个数组生成，一个 profile 一格） | `declaration.test.ts`：坏行在前 + 同名真 preset → 真 preset 的 `id/rowId/order` 完好留在名册、两条都在、`warnings` 为空；`config.id: Bad_ID` → `broken` 且 id 原样显示。反向校验：还原 `idFromRow` 判断 → 真 preset 被当重复项丢弃（该例挂）；还原正则校验 → 该例挂 |
| **F6** | `presetLocationOf` 只定位：组合一次层栈 → 声明模型查 `readDeclarations`、目录模型 `discoverPresets(presetRoots)`、`none` 仍 `preset.notFound`；不构造 `PresetListItem`、不评级。内部 helper 改收 `layers`：`declarationIn(layers, id)` / `assertDeclaredIdFree(layers, id)`，写入口各自只组合一次（原来 saveMeta 2 次、copy 3 次）。顺带 `assertDeclaredIdFree` 的 row id 改用 `declarationLoaderId()`，不再手写前缀 | `ipc/presets/presets.test.ts` 装三个计数器（`vi.mock` + `importOriginal` 委派真实现）：`composeLayerTexts` / `gradeTargets` / `resolveModule`。`preset:reveal` → 组合 1、评级 0、探测 0（目录模型：组合 1、评级 0、探测 1 —— 那次是 `presetRoots` 解析内置包，不是评级）。同一文件先用 `preset:list` 证明计数器**是活的**（组合 1、评级 1、探测 >0）。`preset:saveMeta` / `preset:copy` → 组合 1、评级 0。反向校验：还原 `presetLocationOf` 走 `presetListing` → 两个 reveal 例报组合 2；还原 saveMeta 的二次组合 → 报 2 |
| **F7** | 新建弹窗的"已占用"改由页面传入的 `takenIds` 决定，页面用 `presetTakenIds(presets, legacy)` 把名册与退役目录合并 —— core 的 `assertIdFree` 两样都拒，而名册只显示前者，所以只按名册判就会给出一个**必然失败**的创建。core 守卫不变（它才是权威） | `lib/presetCreate.test.ts`：`presetTakenIds` 把退役目录算进去（反向校验：只取名册 → `['mine']` vs `['liangshen','mine']` 挂）；`presetCreateBlock` 对占用 id 返回 `taken`、畸形 id 先返回 `badId`；`presetCreateReady` 在占用 / 空 id / 无源 / busy 下为 false。渲染：`views/presetCreateRender.test.tsx` 断言弹窗体在 `taken` 时出现「已被占用」、畸形时出现 id 规则、正常时两句都不出现。**仍未断言**：`PresetsSection` 把 `takenIds` 递给弹窗那一步（页面要跑 effect 才渲染得出行，与 §2.2 记的 F9 缺口同类） |
| **F8** | `model === 'none'` 分支返回 `places: []`（原来返回 `directoryPlaces(ctx)`：页面把 `.agent-presets` 与未挂载包的 `presets/` 当"来源"列出，与同页的 `noModel` 空状态自相矛盾）。来源面板为空时按钮禁用（此前 `places` 永不为空，所以没有这个状态）；`preset:reveal` 在该模型下仍 `preset.notFound` | IPC：`model:'none'` 的 profile → `places` 为空数组，`presets`/`grades`/`legacy`/`warnings` 也空；`preset:reveal` 指向退役目录里的 id → `preset.notFound` 且没有调用 `shell.openPath`。反向校验：还原成 `directoryPlaces(ctx)` → 该例挂 |

**施工中与计划原文不同的四处判定**（都记在此，免得回头按计划原文"复核"出假问题）：

1. **F2 用一个新错误码，而不是"仍抛 `presetReadOnly` + params 带层级"**。文案是 code 的函数
   （`lib/ipc.ts` 查 `errors.<code>`），一个 code 只对应一句话，参数**选不了句子**；照计划原文写，
   home 层会显示「内置 preset 不能修改」，原因说错。B9 刚立的规矩（不复用泛化码、拒绝要带原因）在这里同样适用。
2. **F3 用的是计划自己写的退路**（在 `readDeclarations` 内按层数 `collectInsertIds`），不是首选方案
   （在 `presetListing` 里调一次 `findInsertConflicts`）。首选会**再把层栈组合一遍**，而同一批的 F6 正在消掉
   这种重复；退路用的仍是同一套权威结构遍历 —— `collectInsertIds` 就是 `findInsertConflicts` 内部那个函数，
   所以并没有"另写一套规则"。另外报的范围收窄到本名册自己的 row id，避免与 profile 页重复报同一件事。
3. **F2 / F7 的"渲染测试"部分改为纯函数断言**（`lib/presetRow.ts` 的菜单项与原因键、`lib/presetCreate.ts`
   的占用判定与"能否提交"）。`Dropdown`（含 `ConfirmMenu`）的菜单项与 `Tooltip` 的内容在 server render 里
   都不存在，`Modal` 的 `footer` 也在 portal 里 —— 这一批据此给 `docs/TESTING.md` §4 补了第 4 条边界。
   F7 的「已被占用出现在弹窗里」仍有渲染断言（弹窗体 `PresetCreateFields`）。
4. **F5 带出一条计划没写的显示后果**：坏行借 row id 之后，名册里可能同时出现两行同 id。行 key 与评级取值
   因此不再只认 id（见上表）。



---

## 4. 先确证，再定方案

### [ ] F4 —— `file:` 相对路径被解析到盘根，评级可能误报缺行

**现象**：`rating.ts:55-63` 对 `file:` 前缀走 `fileURLToPath(new URL(row.name))`。实测 `new URL('file:./tools/x.mjs')` **不抛异常**，得到 `file:///tools/x.mjs`（当前盘根）→ `isFile` 假 → 该行报"缺失"，即使文件就在 preset/声明文件旁边。

**先做的事**：确证宿主行为 —— 宿主接受 `file:` URL 时是否按声明层的 base 解析（`rows.ts:31` 目前把 kind `file` 定义为"names one file and no base"）。做法：在临时 home 里写一个含 `name: file:./x.mjs` 的 preset/declaration 与同名文件，看运行中的 dsh 是否挂载成功（或直接读宿主 resolver 源码）。

**两种结论各自的方案**：
- 宿主按 base 解析 → `rowResolves` 的 `file:` 分支改为 `isFile(resolve(presetDir, path))`（`presetDir` 已传入，改动两行），并加测试锁定。
- 宿主也视为盘根/拒绝 → 不改代码，在 `rows.ts` 的 `classifyRowSpecifier` 注释里写明"与宿主一致地不按 base 解析"，并加一条测试把该行为钉住，同时把这条写进 `docs/specs/extensions.md`（若涉及 skill 行）或 `docs/presets.md`（preset 行判定口径）。

**验证**：结论 a → 带 `file:./x.mjs` 的 preset 评分为 `ok`；结论 b → 保持 `incomplete` 且注释/规范说明原因。

### [ ] A6 —— `profilesPointingAt` 字符串前缀比较未做大小写归一

**现象**：`uninstall.ts:178,191` 用 `ref.target === wanted || ref.target.startsWith(wanted + sep)`。两侧都过了 `resolve`（`refstate.ts:75`，分隔符与 `..` 已归一），`+ sep` 也避免了 `1.0.0` 误配 `1.0.0-beta`；但 Windows 路径大小写不敏感而字符串比较不是 —— 若 spec 记录的大小写与当前 storeDir 不同，25af010 加的"删版本前先拒绝"会静默失效。

**先做的事**：确认数据根搬迁（`dataRoot` 迁移）是否会重写 profile 里的 `file:` spec、以及是否会改变路径大小写。

**方案**：不要在两处各自补 `toLowerCase()`，而是把比较收敛成一个共享原语：
1. 在 `core/profile/name-guard.ts` 增加 `pathWithin(root, target): boolean`，内部用 `path.relative(root, target)`（win32 实现本身大小写不敏感）判是否越出，替代 `pathOutsideRoot` 里同样大小写敏感的 `startsWith`。
2. `profilesPointingAt` 用它判断"target 是不是 wanted 本身或其后代"，`pathOutsideRoot` 改为它的薄封装（保留现有导出与语义）。

**验证**：`name-guard` 单测：在 win32 上大小写不同的同一路径判为"在内"；`uninstall` 单测：spec 大小写与 storeDir 不同时仍能拒绝删除。

---

## 5. 规范与文档侧需要同步的修正

审查同时发现三处「文档说的和代码做的不一致」。它们不改变代码行为，但会让下一个人按错的规范施工：

1. ✅ **已改（F9 / B2 / B10 那批）** —— `docs/specs/extensions.md` §3.3 原写 ZIP 导入的入口是 `importSkillZip`（只有库侧可达），"写 / 重命名"根本没有入口。现在该段按两侧同形的入口重写：dsh 可写根走 `ext:skill*`（含 `ext:skillImportZip`）、库走 `ext:libSkill*`，并补上"新建拒绝覆盖既有 skill"、256 KB 上限、可写根之外以 `ext.skillReadOnly` 拒绝、以及两趟之间由 `errorOnExist` 兜住。
2. ✅ **已改（B3 / B1 那批）** —— `docs/specs/extensions.md` §3.4 原写"库条目自身读不出…标为 `stale` 并带上理由"，而代码给的是 `installed:false, stale:false`。定案：**三种"读不出"各有归属**（库条目 → issue；副本 → `stale` + `problem`；竞态 → 如实报 `installed` + `stale` + `problem`），并写明 `problem` **必须在页面上可见**、不得被呈现成"库有更新"。
3. ✅ **已改（本次）** —— `docs/design/assembly.md:58` 原写 preset 贡献的根"在静态上不可枚举"，与 `preset-roots.ts` 的约定枚举（`specs/extensions.md` §3.1）相反：改为"字面量不可枚举、只能按随包布局约定枚举"。同文件的 **P0 验收行**先被标注"未达成"指向 F9，F9 修完后已恢复为达成并写明前提（**选定 profile 后**可见）。

> 这三处里有两条是本次写作规范时新写/保留下来的（§3.4 的措辞、assembly 的 P0 验收行），所以它们同时也是写作侧的欠账，不是历史遗留。第 3 条的 P0 验收行经历了一次「标未达成 → 修复后恢复」，正好是这条规范（设计稿的验收行必须与实现同步）的自我演示。

## 6. 明确不做（本批）

- **不动 store 的 `archive/<name>/<version>/` 布局**，也不给归档引入版本锁或内容哈希 —— A4 只修"清理范围"，不改布局。
- **不加通用的文件系统竞态框架**：B2 用 `errorOnExist` + 复检就地解决。
- **不把 pnpm 接上 registry**：那是 `docs/design/egress.md` 的 P1（`dsh/pnpm.ts:196-204` 目前只注入 `--store-dir`），本次审查把它记为"已记录的未做项"，不并入本计划。
- **不顺手重构 preset 的两套模型**：F5/F6/F7/F8 都在现有门面内解决。
- **不改写历史发行说明**：涉及行为的变更写进 `docs/presets.md` / `docs/specs/`，`docs/releases/**` 保持原样。

## 7. 完成标准

- [x] **P0（含 A7）**：测试进仓库、三闸全绿、规则上收 `specs/profile.md` §8（P7 / P8），账目留在 §1。
- [x] **P1 第一批（F1 / F10 / B4）**：同上；账目在 §2.1，规则上收 `specs/profile.md` §4（CRLF）、§5（占用判定同源）、§8 **P9**（registry 最新版本）。
- [x] **P1 第二批（F9 / B2 / B10）**：账目在 §2.2，规则上收 `specs/extensions.md` §3.3 与 §5 的测试锚点（§3.4 仍待 **B3**）。**唯一缺口**：F9 的页面接线没有渲染测试（仓库无组件测试基建），该行已写明替代钉法与理由。
- [x] **P1 第三批（B3 / B1）**：账目在 §2.3，规则上收 `specs/extensions.md` §3.4（三种"读不出"的归属 + `problem` 可见）与 §5；顺带把渲染测试入口写进 `vitest.config.ts` 并落成约定（`docs/TESTING.md` §4），F9 的验证缺口据此回填。
- [x] **P1 第四批（A4 / A5）**：账目在 §2.4，规则上收 `specs/profile.md` §8 **P10**（pack 按版本分层 + 版本段守卫）与 §4（改清单前先留原文，失败即恢复）。
- [x] **P1 第五批（B5 / B6）**：账目在 §2.5，规则上收 `specs/extensions.md` §3.1（四个 config 路径字段都拒绝哨兵、空白即未配置）。
- [x] **P2 第一批（B7 / B8 / B9）**：账目在 §3.1，规则上收 `specs/profile.md` §8 **P11**（缓存键覆盖答案依赖的输入）与 `ui-guidelines.md` §4/§7（错误码是契约：每个 code 两种语言、拒绝要带原因）；顺带把错误码表移到 `src/shared/error-codes.ts`，让渲染层的对照测试成立。
- [x] **P2 第二批（F3 / F2 / F5 / F6 / F7 / F8）**：账目在 §3.2，规则上收 `docs/presets.md` §1/§3.2/§3.3/§6（`none` 模型不列来源、折叠与借来的 id、重复 insert、本页只写 profile 层）与 `docs/TESTING.md` §4（Dropdown/Tooltip/Modal footer 的 SSR 边界 + "调用次数"断言手法）。四处与计划原文不同的判定写在 §3.2 末尾。**仍未断言**：`PresetsSection` 递 `takenIds` 那一步的接线（同类缺口见 §2.2）。
- [x] `pnpm typecheck`、`pnpm test`、`pnpm run build` 三项全绿（**已可在此机直接跑**：2026-10-09 本批最新一次 = 91 files / 1130 tests 全绿，`typecheck` / `build` 亦为 0）。
- [ ] 其余每条新增的测试都进仓库，并在本文件对应条目下留一行"验证方式"。
- [x] 行为或口径有变化的条目（F2、F3、F5）已同步进 [`docs/presets.md`](../presets.md) §1/§3.2/§3.3/§6，§5 的三处修正已落地。
- [ ] **F4 的结论**落地后再同步进 `docs/presets.md`（preset 行判定口径）或 `docs/specs/extensions.md`（若涉及 skill 行）。
- [ ] 本文所有 `[ ]` 清空后，删除本文件，并从 `docs/README.md` 的"未实现的设计"表里移除对应行。
