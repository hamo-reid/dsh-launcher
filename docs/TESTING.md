# 测试约定与踩坑（TESTING）

单元测试用 **vitest**，覆盖**非渲染层核心**（`src/main/core/**`）、**IPC 边界**（`src/main/ipc/**`）、
`renderer/src/lib` 的纯逻辑、i18n 资源，以及**少量渲染断言**（`renderer/src/views/**/*.test.tsx`）。
真机交互（启动、下载、装 dsh）仍靠 `pnpm dev` 验证。测试入口是 `vitest.config.ts` 里的**显式白名单**
—— 新目录要写测试，先在那里加一条（不要靠默认 glob 兜）。

## 运行命令

```bash
pnpm test                 # vitest run，跑全部
pnpm run test:coverage    # 带覆盖率门禁（>70%，不符则退非零）
pnpm vitest run <file>    # 单跑某个文件，快速迭代
pnpm run typecheck        # 另需过的门禁（tsconfig.node + tsconfig.web）
```

覆盖率配置在 `vitest.config.ts`：`provider: v8`，只统计 `src/main/core/**`，整体阈值 `lines/statements/functions ≥70%、branches ≥60%`，**不设 per-file 阈值**（避免单文件红线卡整体）。

## 测试模式（核心必需的三板斧）

### 1. 纯逻辑 / 只读 FS —— 用 `mkdtempSync` 临时目录
core 大量函数是"读真实文件、不联网"。统一做法：

```ts
let root: string
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'pm-xxx-')) })
afterAll(() => rmSync(root, { recursive: true, force: true }))
beforeEach(() => { rmSync(root, { recursive: true, force: true }); mkdirSync(join(root, ...)) })
```
一个文件一个独立 tmp 根，`beforeEach` 清空重建，避免用例间串数据。

### 2. 依赖 settings 的模块 —— 打开临时 sqlite + 设 active dsh
`home`/`manifest`/`combo`/`plugins` 等的目录解析走"当前 active dsh"。让它生效：

```ts
await openDatabase(join(root, 'app.sqlite'))          // 模块级单例，beforeAll 一次
beforeEach(() => saveSettings({ dshes, activeDshId, pluginDir: store() }))  // 关键：重置基线
```
⚠️ **settings 数据库是模块级单例**，一个用例里 `saveSettings({...})` 会污染后续用例。**每个 `beforeEach` 必须把 settings 重置回基线**，否则前一个用例写坏的值（如 active 版本）会泄漏导致后续断言失败——这是最容易踩的坑。

### 3. 带副作用交互 —— mock
- **pnpm**：`vi.mock('./pnpm.ts', async (ia) => ({ ...(await ia()), runPnpm: vi.fn() }))`，保留纯函数（`installSucceeded`），把 `runPnpm` 变可控。
- **插件安装**：`installIntoProfile`/`addPlugin`（会读 store、调 pnpm）同样 mock，返回 `{ ok: true, ... }`。
- **npm 网络**：`vi.stubGlobal('fetch', vi.fn(...))`，`afterEach(() => vi.unstubAllGlobals())`。
- **`spawnSync`（系统 node 探测）**：`vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }))`，配 `vi.resetModules()` + 动态 `await import()` 测多分支。

约定：**被测文件保持真实，交互边界用 mock**；HTTP/子进程绝不真跑。

### 4. 渲染层 —— `react-dom/server` 静态渲染（无 DOM、无新依赖）

组件里"用户到底看到了什么"用 `renderToStaticMarkup` 断言，不引入 testing-library / jsdom
（`react-dom` 已是运行时依赖）。i18n 单例自己初始化，断言才能落在**用户读到的文案**而不是 key 上：

```tsx
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
beforeAll(async () => {
  await i18next.use(initReactI18next).init({ resources: { en }, lng: 'en', fallbackLng: 'en', interpolation: { escapeValue: false } })
})
const html = renderToStaticMarkup(<I18nextProvider i18n={i18next}><SkillCard … /></I18nextProvider>)
expect(html).toContain('Unreadable (1)')
```

三条边界（都是踩过的）：

1. **antd 的 `Modal` 走 portal，SSR 下渲染为空** —— 要断言弹窗内容，就把**主体**拆成独立展示组件
   （如 `InstallSkillFields`、`PresetCreateFields`）再渲染它。注意 `Modal` 的 `footer` 也在 portal 里：
   按钮在静态产物里根本不出现，"提交按钮禁用与否"只能靠 `lib/` 里的纯函数钉（`presetCreateReady`）。
2. **tooltip 内容只在悬停时渲染**，静态产物里没有 —— 别断言 tooltip 文案，改为断言那个可见的标签。
3. **effect 不跑** —— 初始态（未选中的 scope、空列表）可以断言；"点一下就发 IPC"这类要真机验证，
   或在 `lib/` 里把决策抽成纯函数单测。
4. **`Dropdown`（含 `ConfirmMenu`）的菜单项同样只在展开时进 portal** —— "这一行少了哪两项菜单"在静态
   产物里断言不到。把**菜单项的决策**抽成纯函数（如 `lib/presetRow.ts` 的 `presetRowActions` /
   `presetReadOnlyHintKey`）单测，比渲染断言更直接；组件只负责把 key 映射成文案。

**"调用次数"类断言**（"点一次不该评级整份名册"）：用 `vi.mock(spec, async (importOriginal) => ...)`
包住真实现并计数 —— 委派给 `importOriginal()` 的那份，行为不变：

```ts
const counters = vi.hoisted(() => ({ compose: 0 }))
vi.mock('../../core/store/combo.ts', async (ia) => {
  const actual = await ia<typeof import('../../core/store/combo.ts')>()
  return { ...actual, composeLayerTexts: (...a: Parameters<typeof actual.composeLayerTexts>) => {
    counters.compose += 1; return actual.composeLayerTexts(...a)
  } }
})
```

计数为 0 的断言必须配一个"计数器是活的"的反例（同一个文件里先跑一次会调用它的操作），否则一个永远
不生效的 mock 也能让测试通过。

覆盖率的统计范围**不变**（仍然只算 `src/main/core/**`），渲染测试只提供断言，不参与阈值。

## Windows / 路径 / 内容踩坑清单（都有血泪）

1. **大小写不敏感**：Windows 上 `README.md` 与 `readme.md` 同名，若先建了个 `readme.md` 目录再写 `README.md` 会 `EISDIR`。写文件路径要一致，别大小写混用。
2. **patch YAML 的 row id 不带引号**：`parsePatchRows` 解析 `- id: "a.b"` 得不到 `a.b`；写测试示例用 `- id: a.b`（无引号）。
3. **不要在测试里用全局 `require`**：vitest 是 ESM，`require` 未定义；一律顶部 `import`。
4. **路径写法**：测试/node 代码里用 `join('C:/...')`（正斜杠）可靠；bash 的 `/c/...` 传给 node 会拼成 `C:\c\...` 而读不到——用 `C:/`。
5. **校验 pnpm `node_modules` 不要靠 `ls`**：Windows bash 对 pnpm 的 junction/目录 `ls` 会显示 0 条或失灵，改用 `node` 的 `readdirSync`/`readlinkSync`/`require` 验证。
6. **隔离与单例**：vitest 默认 per-file isolate（`settings` 单例跨文件不会漏）；但**文件内跨用例**会因 `settings`/`db` 单例而漏——靠 `beforeEach` 重置（见上）。
7. **测多分支 helper**（如 `nodeEnvironment(preference)`）用 `vi.resetModules()` + 动态 import 重置模块缓存，再分别给 mock 返回不同值。

## 维护原则
- 覆盖率是门槛不是累赘：gate 设在总量（>70%），个别难测分支（如 `installOfficialDsh` 真装 dsh）允许不覆盖，别为此写脆弱的"假通过"测试。
- 新 core 模块补测试时，优先覆盖"决策/纯函数分支 + 真实 FS 读路径"，交互边界补 mock。