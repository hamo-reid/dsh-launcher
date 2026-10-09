# 缺陷修复计划（2026-10 代码审查）

> 状态：**P0 已完成（4 条，含施工中新发现的 A7）；F1、B4、F9、B2、B10 已完成，并带出施工中新发现的 F10；其余 17 条未实现**。这是一份施工计划，不是规范。
> 来源：对 `feature/preset-management` 三块功能代码的审查（preset 功能、dev 插件 pnpm pack 快照、registry/skills 修复）。
> 定位：每条修完后 —— 仍生效的规则上收 `docs/specs/` 或 `docs/presets.md`，测试进仓库，然后**从本文删掉该条**。本文清空即代表这批缺陷关闭。

审查只做了读码与定点实测，所以每条都附带「验证」一栏，说明用什么测试把它钉住。（原文此处写「本沙箱 `pnpm test` 受 esbuild `spawn EPERM` 无法运行」——**该限制已解除**：文件策略放宽后整套 `pnpm test` 在本机可跑，82 files / 1050 tests 全绿，见 §7。）

## 0. 批次与顺序

| 批次 | 条目 | 为什么是这个顺序 |
|---|---|---|
| **P0 硬后果** ✅ | ~~A2、A1、A3~~（+ 施工中新发现的 **A7**） | 会静默把 profile 指向错误的构建，或让包/文件名可控的字符串决定写入/递归删除的路径。**已完成**，见 §1 |
| **P1 正确性与信息丢失** ✅ | ~~F1、B4、F9、B2~~（+ 施工中新发现的 **F10**）、F3、A4、A5、B1、B3、B5 | 守卫失效、功能做完却不可达、诊断被丢掉、选错版本、归档不可修复、清单先改后失败。**F1 / B4 / F10 见 §2.1，F9 / B2 见 §2.2** |
| **P2 一致性与性能** | ~~B10~~ ✅（见 §2.2）、F2、F5、F6、F7、F8、B6、B7、B8、B9 | 文案/范围不一致、幻影根、缓存与 i18n 瑕疵 |
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
| **F9** | `SkillsManagePanel` 自己管 profile 选择（`dsh.profiles` + `Select`，可清空）；`DshSection` 不再写死 `profile={null}`；未选 profile 时页面用 `Alert` 明说 preset 根不列出。选择规则抽成 `renderer/src/lib/profileScope.ts` 的 `nextProfileChoice`，与 `PresetsSection` 共用（消掉两处重复） | `renderer/src/lib/profileScope.test.ts`：记住仍在的 profile / 否则取首个 / 无 profile 时为 `undefined`（这个"机器级视图"是有意义的答案）。**页面那半没有渲染测试** —— 仓库没有组件测试基建（`@testing-library/react` 未装，逻辑一律抽到 `lib/`），所以这里用"抽出的纯函数 + 核心侧既有的 `preset-roots.test.ts`（有 profile 才产出 preset 根）"钉住，页面接线本身靠读码与构建验证 |
| **B2** | `installZipSkills` 第 2 趟复制前**再查一次** `exists(name)`（命中即 `extSkillExists`），并把 `cpSync` 改为 `errorOnExist: true, force: false` | `skills.test.ts`：探针第一次说空闲、第二次说占用 → `ext.skillExists` 且目标根没多出目录；探针**恒**说空闲但目标已存在 → 文件系统拒绝且既有 SKILL.md 未被改写。反向校验：还原任一半都返回 `(no throw)`（静默覆盖） |
| **B10** | 接通 dsh 侧创作面：core 补**新建拒绝覆盖**守卫；IPC 加 `ext:skillRead` / `ext:skillSave` / `ext:skillImportZip`（外加 `ext:skillScaffold`，让 dsh 流程不必借用库命名空间）；`shared/api.ts` + preload 各补 4 个方法；面板动作行补「新建 Skill / 从 ZIP 导入」、可写行补「编辑」、底部加可拖放的 `DropZone`（复用现成的 `SkillEditorModal` / `SkillNameModal` / `DropZone`）。顺带把可写根之外的读 / 写 / 删从 `internal` 改成 `ext.skillReadOnly` | `skills.test.ts`：新建撞既有 bundle 目录 / 既有扁平文件都拒绝且原文件未被改写；`extensions.test.ts`：scaffold→save→read 回读、frontmatter 改名、新建撞名返回 `ext.skillExists`、`../escape` 与 300 KB 文本被拒、zip 导入落进可写根、非 zip 路径返回 `ext.skillZipNotZip`。反向校验：还原守卫后 IPC 那级返回 `ok:true`（**静默覆盖**），核心两例同时挂 |

### [ ] F3 —— 同一 loader 行 id 被两次 insert 时静默折叠，页面显示成健康名册

**现象**：`declaration.ts:155-177` 的 fold 以 row id 为键、后者覆盖前者，`order` 只压栈一次 → 两层各 insert 一次同一 row id，只得到**一条**名册记录、**零**警告。而那是硬性启动失败（`store/combo.ts:255` 的 `findInsertConflicts`，接在 `ipc/dsh/run.ts:222` 与 `ipc/profile/read.ts:73`）。重复 preset id 的警告只在"两个不同 row id 共用同一 `config.id`"时触发。

**方案**：不要在 `readDeclarations` 里另写一套规则 —— 让页面复用权威判定。在 `presetListing`（`index.ts:171`）拿到 `ctx`/`profile` 之后调一次 `findInsertConflicts(ctx, profile)`，把其中涉及 declaration row id（即 fold 里出现过的 row id）的冲突转成 `warnings`，用宿主自己的措辞（duplicate loader entry id）。若希望 `readDeclarations` 保持纯函数，退路是在它内部按层记录 `collectInsertIds`，第二次出现同一 id 时推 warning。

**验证**：`presets/index` 单测：构造两层同时 insert `- id: preset-x`（同一 preset id），断言 `warnings` 非空、且文案点到冲突双方；再断言"后层只写 `- id: preset-x` + `disabled:`（合法的 id 覆盖）"**不**产生 warning。

### [ ] A4 —— 每次 pack 清空 `.pack/<name>`，让旧归档的 `file:<tarball>` 依赖悬空

**现象**：归档记录的依赖是 `file:<store>/.pack/<name>/<name>-<version>.tgz`（`install.ts:110` 的 `pnpm add file:<tgz>`），而 `pack.ts:102` 每次 pack 前清空整个 `.pack/<name>`。同版本重跑无妨（文件名稳定），**版本号一变**旧归档的依赖就指向已删除的 tgz —— 该版本再也无法重建/修复（`install.ts:204-215` 的 repair ladder 必然失败）。profile 侧不受影响，它指向归档内解出的包体。

**方案**：让 pack 目的地按版本分目录，并且只清理该版本自己的目录：
1. `packDir(storeDir, name, version?)` → `<store>/.pack/<name>/<version>`；`packIdentity` 已在 pack 前拿到 version，直接可用（`pnpm pack` 不会改包自己的 version）。
2. `packDevPackage` 的 `rmSync` 只作用于这个版本子目录，不再动 `<name>` 这一层 —— 于是版本升级不会带走旧 tarball。
3. 在 `pack.ts` 顶部注释里写明：**同版本**重复快照是有意替换（源码动了、版本没动），**跨版本**必须各自留存。

**验证**：`store/pack`（或 dev 快照）单测：先对 `1.0.0` 快照，再改 package.json 为 `1.1.0` 快照，断言 `1.0.0` 的 tgz 仍在、且 `1.0.0` 归档仍可 `reinstallVersion` 成功（或至少其记录的 `file:` 目标存在）。

### [ ] B1 —— `f652479` 加的 `problem` 理由在界面上从未被渲染

**现象**：`skills/library.ts:233` 把"这个副本读不出来"的理由写进 `SkillLibInstall.problem`（类型见 `shared/types.ts:1324-1343`），但全 `src/renderer/**/*.tsx` 没有任何消费者读它。用户只看到「库有更新 + 重新安装」，看不到原因 —— 而**重装修不好一个读不出来的副本**，正是这条修复要区分的两种状态。

**方案**：
1. 在 `views/LibraryModals.tsx:271-280` 的提示分支里接入 `problem`：`problem !== undefined` 时优先显示它（用 `Alert` 或 `Tooltip`，与 `PresetsSection.tsx:364-366` 处理 `preset.legacyItem.problem` 的方式保持一致）。
2. `views/SkillCard.tsx` 与 `views/SkillsManagePanel.tsx:162-176` 的 stale 标签加 tooltip 承载同一理由。
3. 新增 i18n 键（`en.ts` / `zh.ts` 成对）：`ext.skills.installProblem`（"该 dsh 上的副本读不出来：{{reason}}"），并在 `problem` 存在时改掉主按钮的语义 —— 提示"重新安装可能无法修复"或把动作换成"查看/移除该副本"。
4. `docs/specs/extensions.md` §3.4 补一句：降级单元格的 `problem` **必须在页面上可见**，否则"读不出"会被当成"是最新的"。

**验证**：`LibraryModals` 的渲染测试（或 `SkillsManagePanel` 快照）加一例：给一个 `problem` 非空的 install，断言页面出现理由文本而不是仅 stale 标签。

### [ ] A5 —— `installIntoProfile` 先改 manifest 再 install，失败不回滚

**现象**：`install.ts:347` 写 manifest（依赖、清理旧 sub-bundle 依赖），`:349` 才 `pnpm install`；`:350-353` 失败只返回错误。快照部分成功时（`dev.ts:590-598`）前面的 profile 已切换、失败那个的 manifest 也已改写，而归档路径是有 stash/restore 的。

**方案**：局部快照 + 恢复，与归档路径同构：
1. 进函数时记下 `originalManifestText`（不存在则记 `undefined`）。
2. `pnpm install` 失败时：若原来有文件则写回原文，否则删除刚创建的文件；然后再返回错误，文案里说明"清单已恢复"。
3. bundle 层那次 manifest 写入（`:370`）同样包在恢复范围内。

**验证**：`store/install` 单测：mock `runPnpm` 失败，断言 profile 的 package.json 与调用前逐字节相同（含原来就不存在的场景）。

### [ ] B3 —— `listSkillLibrary` 的读取仍未保护，`f652479` 的目标只达成一半

**现象**：`skills/library.ts:71`、`:76` 的 `parseSkillText(readFileSync(file, 'utf8'))` 没有 try/catch。`<lib>/<name>/SKILL.md` 是**目录**（或权限 / 占用问题）时 EISDIR 抛出 `listSkillLibrary`。而两条 IPC 路线（`ipc/extensions/skills.ts:65` 的 `ext:libSkillList`、`:76` 的 `ext:libSkillOverview`）都**先**调 `listSkillLibrary`，所以 `scanSkillInstalls` 里新加的库侧守卫（`library.ts:229-235`）在 IPC 路径上**不可达** —— 抛出发生在它前一步，整张库页面渲染不出来（`SkillsView.tsx:67` 直接 `message.error` 后返回）。

**根因**：修复加在"副本读不出"，没加在"库条目自身读不出"；单测 `skill-library.test.ts:312-321` 构造了那个状态却直接调 `scanSkillInstalls(entry)`，绕过了真正会抛的入口。函数自己的文档（`library.ts:53-55`"不可解析的文件作为 issue 出现而不是被丢掉"）也没覆盖"读不出"。

**方案**：
1. `listSkillLibrary` 的两次读取按 `scanRoot` 的方式保护：读不到就 push 一条 issue（理由带路径与错误文本），而不是让整个调用抛出 —— 与它的文档承诺对齐，`SkillLibIssue` 天然能承载。
2. 若确实要保留"条目存在但读不出"这一态，则改为把条目连同 `problem` 一起返回，让 `scanSkillInstalls` 的库侧分支真正可达。
3. 决策后同步 `docs/specs/extensions.md` §3.4 的措辞：规范现在说库条目读不出要标 `stale` 并带理由，而 `library.ts:232` 给的是 `installed:false, stale:false` —— 二者必居其一。

**验证**：`skill-library` 单测：`mkdirSync(join(lib,'notes','SKILL.md'))` 后调 **`listSkillLibrary()`**（不是 `scanSkillInstalls`），断言不抛、其余条目仍在、该路径出现在 issues 里；再加一条 IPC 级测试断言 `ext:libSkillOverview` 仍 `ok:true`。

### [ ] B5 —— `!!js` 只过滤了 `customSkillDirs`，三个兄弟字段仍会把哨兵当路径

**现象**：`skills/skills.ts:80-81`、`:98` 只按 `typeof === 'string'` 接受 `dshHome` / `agentsHome` / `bundledSkillDir`，随后 `:149` `resolve(config.dshHome)`、`:153` `resolve(config.agentsHome)`、`:159` `resolve(bundled)` —— 而 `!!js` 在 `patch/yaml.ts` 里是**带哨兵前缀的字符串**，会一路穿过去变成由 JS 源码拼出的路径（`customSkillDirs` 的同类问题正是 `db83573` 修的，`:83-94`）。对 `dshHome` 尤其糟：它**替换**真实可写根，于是 `user-dsh`（`<home>/skills`）从列表里消失，同时报出一个 writable 的幻影根。

**方案**：把 `isJsExpr` 判断提到这三个字段的读取处（命中即视为未配置），与 `customSkillDirs` 一致；在模块注释里把"四个 config 字段都拒绝哨兵"写成一条规则。

**验证**：`skills.test.ts` 加一例：home 层 `skill-filesystem` 行写 `dshHome: !!js …` → 断言 `user-dsh` 根仍在、没有被替换成幻影根。
（触发条件未确证：现有 shipped / fixture 配置没有对这三个键用 `!!js`；但这是同一缺陷类，修法三行且无副作用。）

---

## 3. P2

### [ ] F2 —— home 层 declaration 在本页只读（**已定：方案 B**）

**现象**：`i18n/locales/zh.ts:1196` / `en.ts:1198` 说「声明式的会从 profile 补丁里移除」；但 `index.ts:147-148` 把 home 补丁标为 `writable: true`，`:114` 用 `editable: layer !== 'bundle'` 判定，`:319-321` 写的是 `preset.sourcePath` —— home 层时即机器级 `<home>/cordis.patch.yml`，**影响所有 profile**。`saveMeta` 同理。页面标题与 `preset.desc` 又都说这是"这个 profile 的 preset"。

**方案（已定 B：在本页拒绝 home 层写入，把"影响所有 profile 的写入"留给 home 补丁自己的编辑面）**：
1. `presets/index.ts` 的 `assertEditable`：条件从 `layer === 'bundle'` 扩为 `layer !== 'profile'`，仍抛 `E.presetReadOnly`，`params` 带上 id 与层级以便文案区分。
2. 同一个判据必须同时用在显示侧：`declarationItem`（`index.ts:107-114`）的 `editable: preset.layer !== 'bundle'` 改成 `preset.layer === 'profile'`。UI 与后端不一致时界面会给出后端随后拒绝的操作 —— `store/refstate.ts:18-20` 已经把这条写成了本仓库的规矩。
3. 只读提示：行上已有来源标签（`preset.source.home` = 「home 层」），给被拒的行补一条专用提示键 `preset.homeReadOnlyHint`（en/zh）："这行在机器级 home 补丁里，改动会影响所有 profile；请直接编辑 home 补丁"。
4. 连带好处：**现有删除确认文案因此变正确** —— "声明式的会从 profile 补丁里移除"在方案 B 下只对 profile 层成立，不需要新增文案。
5. 复制（`copyIntoProfile`）仍允许以 home 层 declaration 为**源**（只读），只有编辑与删除被拒。
6. 文档：`docs/presets.md` 的写入口径里写明"本页只写 profile 层；home 层的 declaration 只读，改它请走 home 补丁"。

**验证**：IPC 单测：对 home 层 declaration 调 `preset:saveMeta` / `preset:delete` → `preset.readOnly`，且 home 补丁与 profile 补丁字节都不变；渲染测试：`source === 'home'` 的行没有「编辑详情 / 删除」菜单项，且只读提示可见。

### [ ] F5 —— 坏 declaration 借 row id 挤掉真 preset id

**现象**：`declaration.ts:98-100` 在 `config.id` 缺失时把 **loader row id** 当 id，于是 `:194-202` 的"先到先得"可能让真 preset 被当重复项丢弃。另外读入的 id 从不校验 `PRESET_ID_RE`（写入侧有守卫，无穿越风险，但显示层会把不合宿主规则的 id 当正常 preset）。

**方案**：
1. `DeclaredPreset` 增一个内部标记 `idFromRow: boolean`（`config.id` 不可用时 true）。
2. `readDeclarations` 的重复判定只为 `idFromRow === false` 的条目登记与比重复 —— 坏行永远带着 `broken`，不该有机会遮蔽一个能用的 preset；两坏行相撞时两条都留着（各带自己的 broken 理由）。
3. `toPreset` 里对读到的 id 加 `PRESET_ID_RE` 校验，不合规则直接标 `broken`（理由说明宿主也会拒），避免把不可用的 id 当成正常名册项。

**验证**：`presets/declaration` 单测加两例：`config.id` 缺失的行 + 同名真 preset → 真 preset 仍在名册且无 warning；`config.id: "Bad_ID"` → 该行 `broken` 且 id 原样显示。

### [ ] F6 —— 打开/在文件管理器显示会触发整份名册评级

**现象**：`index.ts:352-359` 的 `presetLocationOf` 调 `presetListing`，后者组合整个层栈、读全部 declaration，并跑 `gradeTargets`（逐行 `resolveModule`，无缓存）。一次"打开"= 一次全量评级。另外每个写操作会重复组合层栈 2–3 次（`index.ts:277`、`:298`、`:315` 的 `detectModel(profileLayers(...))` 再加 `declarationOf` 内部的 `profileLayers`）。

**方案**：
1. `presetLocationOf` 只做定位：组合一次层栈 → `readDeclarations` 找 id（declaration 模型）或 `discoverPresets(presetRoots(ctx))`（directory 模型），不构造 `PresetListItem`、不评级。
2. 内部 helper 收层栈参数：`declarationOf(layers, id)`、`modelOf(layers)`，让 `savePresetMetaIn`/`copyPresetIn`/`deletePresetIn` 各自只组合一次（`const layers = profileLayers(ctx, profile)`）。

**验证**：给 `module-resolve` 或 `gradeTargets` 装计数器（或 spy）的单测：调 `preset:reveal` 时 `resolveModule` 调用次数为 0；调 `preset:saveMeta` 时 `profileLayers`/`composeLayerTexts` 只被调用一次。

### [ ] F7 —— 创建对话框的"已占用"与 core 守卫不同源

**现象**：`views/presets/PresetModals.tsx:135` 的 `taken` 只看名册，而 core 的 `assertIdFree`（`index.ts:238-241`）还拒绝被退役目录占用的 id。用户会先看到"可创建"，再收到 `preset.exists`（"已经被占用"），而名册里根本看不到那个 id。

**方案**：`PresetCreateModal` 增加 `takenIds: ReadonlySet<string>`（或 `legacyIds`）prop，由 `PresetsSection` 从 `listing.legacy.map(p => p.id)` 与 `presets` 合并传入；`blocker` 判定改用它。core 的守卫保持不变（它才是权威），UI 只是不再给出必然失败的按钮。

**验证**：`PresetModals` 渲染测试：`takenIds` 含某个 id 时，输入该 id 出现"已被占用"且提交按钮禁用。

### [ ] F8 —— `model === 'none'` 时仍把退役目录根当"来源"列出

**现象**：`index.ts:203` 在没有挂载任何 preset 模型的 dsh 上返回 `places: directoryPlaces(ctx)`，Sources 面板会列出 `.agent-presets` 与未挂载包的 `presets/`，与 `PresetsSection.tsx:408` 的 `noModel` 空状态自相矛盾。

**方案**：该分支返回 `places: []`（`presets`/`grades`/`legacy`/`warnings` 已是空）。若希望仍能告诉用户"退役根在哪"，改为只列 `<home>/.agent-presets` 并带上 `exists`，但不要列未挂载包的目录。

**验证**：IPC 单测：`model === 'none'` 时 `listing.places` 为空（或只含用户根），且页面显示 `noModel` 空状态。

### [ ] B6 —— 空的 `DSH_AGENTS_HOME` / `DSH_BUNDLED_SKILL_DIR` 会变成 `process.cwd()`

**现象**：`skills/skills.ts:152-154` 用 `process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents')`，`:158-159` 用 `config.bundledSkillDir ?? process.env.DSH_BUNDLED_SKILL_DIR`。`??` 不把 `''` 当未设置，而 `resolve('') === process.cwd()`、`existsSync(cwd)` 为真 —— 扫描器会走进 launcher 的工作目录，把遇到的 `<dir>/SKILL.md` / `*.md` 当作 `user-agents` / `bundled` 技能收进目录。config 行的同名字段是有 `''` 过滤的（`:80-81`），env 这一侧没有。

**方案**：两处都改成 `.trim() !== ''` 才算有效（先取 `process.env.X?.trim()`，为空则按未设置处理），与 config 行口径一致。

**验证**：`skills.test.ts` 加一例：`DSH_AGENTS_HOME=''` 时根解析结果与未设置时相同（不出现 cwd）。

### [ ] B7 —— 插件更新缓存没有把 registry 算进键

**现象**：`store/updates.ts:104-110` 的 `cacheKey` 只含 `storeDir` 与各行的 name / versions / usage，不含 registry；TTL 5 分钟（`:101`），默认路径走 `peek`（`:123`；两个调用方 `PluginsSection.tsx:328`、`PluginUpdatesModal.tsx:41` 都不传 `refresh`）。切换 `registryUrl` 后，最多 5 分钟内仍会拿到旧源的更新结论。

**方案**：`cacheKey` 加上 `registryBase()`（`registry.ts:41` 本身不缓存，读一次即可），或把 registry 作为 `checkPluginUpdates` 的显式输入。

**验证**：单测：同一 store 先以 A 源算一次，改 `registryUrl` 为 B 源后断言不命中旧缓存。

### [ ] B8 —— `errors.profile.notFound` 两个语言都缺，用户会看到裸 profile 名

**现象**：`ipc/validate.ts:36` 返回 `E.profileNotFound` 并带 `detail`，新路径由 `ipc/extensions/skills.ts:40`（`ext:skillList` 传了不存在的 profile）到达 `SkillsManagePanel.tsx:60` 的 `message.error(apiErrorText(list))`。两个 locale 都没有 `errors.profile.notFound`，`lib/ipc.ts:12-15` 于是回退到 `params.detail` —— 用户看到的"错误信息"就是 `base-wbe` 这样的裸名字。同类缺口另有 `dsh.notManaged`、`dsh.upToDate`、`dsh.majorRisk`、`profile.exists`、`npm.notFound`、`yaml.invalid`、`trash.conflict`。

**方案**：补 `errors.profile.notFound`（en/zh 成对），并逐一确认其余缺口是否落在用户可见路径上；顺便加一条**全量对照测试**（`E.*` 的 code 是否都有 `errors.<code>` 键），以后新增错误码不会再漏。

**验证**：i18n 覆盖测试通过；`ext:skillList` 传未知 profile 时页面出现说明而不是裸名字。

### [ ] B9 —— 坏 `registryUrl` 走 `E.nameInvalid`，具体原因被丢掉

**现象**：`ipc/app/settings.ts:149`、`:152` 用 `fail(E.nameInvalid, [], 'registry URL 不合法：…')`。`E.nameInvalid = 'name.invalid'` 在两个 locale 里都有，而 `apiErrorText`（`lib/ipc.ts:12-13`）**优先**返回本地化 key，仅在 key 缺失时才回退 `error` / `detail` —— 所以用户看到「名称不合法 / Invalid name」，那句真正有用的 URL 文本被丢弃。

**方案**：新增专用错误码（如 `E.registryBadUrl`）并补两个 locale，或复用带插值的码（`fail(E.invalidUrl, { detail: raw })` 且文案含 `{{detail}}`）。

**验证**：IPC 单测断言返回的是新专用码；渲染测试断言页面出现含 URL 的具体文案。

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
2. **`docs/specs/extensions.md` §3.4** 说"库条目自身读不出…标为 `stale` 并带上理由"，而 `library.ts:232` 给的是 `installed:false, stale:false`。按 **B3** 的结论二选一（**仍待办**）。
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
- [x] `pnpm typecheck`、`pnpm test`、`pnpm run build` 三项全绿（**已可在此机直接跑**：2026-10-09 最新一次 = 83 files / 1072 tests 全绿，`typecheck` / `build` 亦为 0）。
- [ ] 其余每条新增的测试都进仓库，并在本文件对应条目下留一行"验证方式"。
- [ ] 行为或口径有变化的条目（F2、F3、F5、B1、B3，以及 F4 的结论）已同步进 `docs/presets.md` / `docs/specs/extensions.md` / `docs/specs/launch.md`，§5 的三处修正已落地。
- [ ] 本文所有 `[ ]` 清空后，删除本文件，并从 `docs/README.md` 的"未实现的设计"表里移除对应行。
