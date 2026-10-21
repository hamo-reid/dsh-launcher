# profile-manager 界面规范(UI / UX Guidelines)

> 本文件的权威参考。新增或改动界面**必须**遵循本文;冲突时以本文为准,并同步修订 `src/renderer/src/theme.ts` 的 Design Token。适用范围:profile-manager 渲染层(`src/renderer`)。

---

## 1. 设计原则

1. **Token 优先,禁止魔法值** —— 颜色、圆角、间距、字号一律来自 `theme` token(antd `theme.useToken()` / `theme.ts` 常量),杜绝散落的 `#777`、`#f0f0f0`、`12px` 等硬编码。
2. **用一个基座搭所有页面** —— 所有 Section 用统一的 `AppShell`(侧栏 + 内容区)与 `SectionHeading`(页头),视觉骨架一致。
3. **三态齐备** —— 任何异步视图都要有 loading(加载)、empty(空)、error/success(反馈)三种状态,不许出现白屏、闪屏、"无提示失败"。
4. **双主题一次到位** —— 颜色必须同时满足亮/暗两套 token;改动颜色时默认两种都核对。
5. **可访问性不是加分项** —— 对比度、表单 label、键盘可达、焦点可见是默认要求(见 §6)。
6. **中文优先** —— 用户界面文案用中文;术语、包名、错误信息保持原文。

---

## 2. Design Token(单一事实源)

定义于 `src/renderer/src/theme.ts`。亮 / 暗两套,`ThemeProvider` 通过 antd `ConfigProvider` 注入。

### 2.1 颜色

**亮色(默认)**

| Token / 语义 | 值 | 用途 |
|---|---|---|
| `colorPrimary` 主色 | `#2b5cd9` 深蓝 | 主操作按钮、选中、Focus 环、链接 |
| `colorText` 主文字 | `#1f2430` | 标题、正文 |
| `colorTextSecondary` 次要 | `#565e74` | 说明文字、次要信息 |
| `colorTextTertiary` 辅助 | `#8a91a8` | 补白、占位、元信息 |
| `colorTextQuaternary` 禁用 | `#c9cdd6` | 不可用文字 |
| `colorBorder` 边框 | `#e4e7f0` | 分隔、控件描边 |
| `colorBorderSecondary`/`colorSplit` 弱分隔 | `#eef0f6` | 列表分隔线、table 行线 |
| `colorBgLayout` 画布 | `#eaeef6` | 内容区背景 |
| `colorBgContainer` 容器 | `#ffffff` | 卡片、侧栏、弹窗 |
| `colorPrimaryBg` 选中底 | `#e6f0ff` | 列表选中态 |
| `colorPrimaryBgHover` 悬停底 | `#d8e8ff` | 列表 hover |

**暗色** — 基于 antd `darkAlgorithm` 覆盖:文字用白色 alpha 渐变(`0.92 / 0.72 / 0.56 / 0.38`),边框用 `rgba(255,255,255,0.16 / 0.10)`,主色亮化为 `#4f7bff`,选中底用 `rgba(79,123,255, 0.16/0.24)`。

> 命名的坑:不要再写 `#e6f4ff`(旧选中底)、`#f0f0f0`(旧边框)、`#777/#888/#999`(旧次要文字)——它们在亮色下尚可,暗色下失去对比,必须用 token。

### 2.2 尺寸、间距、字号

| Token | 值 | 用途 |
|---|---|---|
| `borderRadius` | 8 | 默认控件圆角 |
| `borderRadiusLG` | 12 | 卡片、弹窗、分组 |
| `fontSize` | 14 | 正文 |
| `LAYOUT.sidebarWidth` | 280 | **统一侧栏宽度** |
| `LAYOUT.pagePadding` | 16 | 紧凑内边距 |
| `LAYOUT.pagePaddingLG` | 24 | 页面级内容内边距 |
| `MODAL.wide` | `min(1040px, 94vw)` | 宽弹窗(列表 / 详情 / 编辑器对话框) |
| `MODAL.narrow` | `min(620px, 94vw)` | 窄弹窗(小型表单) |

> 侧栏宽度统一 280。尺寸、间距、字号优先复用现有 token / 常量(`MODAL`、`LAYOUT`、antd `padding / paddingLG / paddingSM`)。个别紧凑布局确需字面间距时,只用离散的小档位(`4 / 8 / 12 / 16px`)并保持全文一致。
>
> 弹窗宽度一律用 `MODAL.wide` 或 `MODAL.narrow`,不要另写 `min(…)` 数值。

---

## 3. 组件规范

所有共享组件在 `src/renderer/src/components/`。**优先复用,不要在每个 View 里重新拼。**

### 3.1 AppShell(`AppShell.tsx`)
统一两栏外壳。用法:

```tsx
<AppShell sider={<NavList … />}>
  {/* 内容区 */}
</AppShell>
```

约定:侧栏承载导航与列表;内容区承载详情与主操作。侧栏宽度用 `LAYOUT.sidebarWidth`,确有需要再 `siderWidth` 覆盖。

### 3.2 SectionHeading(`SectionHeading.tsx`)
页头:标题 + 可选说明 + 右对齐操作区。一个内容区**只允许一个**页头;作为 Main Header 自带一条细的底部界定线(`borderBottom`),把它从画布内容中「界定」出来,不再是浮在背景上的裸文字。加上 `sticky` 会把页头钉在滚动区顶部(用于固定工具栏,如 Profile 的启动/中止条),并换成实心底色。

`title` 是名词短语（栏目的名字，不带当前选中项 —— 那是侧栏的活）；`description` 是**一行数据**：计数、范围、这一页此刻的状态，用 ` · ` 连成一句（见 Skills / MCP / 预设）。**它不是这一页的说明书**：栏目怎么读、某个术语是什么意思、哪些来源被读，属于参考信息，走该控件自己的 `Tooltip` 或页面上按需展开的说明层（`PresetsSection` 的「说明」是范例），不常年占版面。没有数据可说时传 `undefined`，别留一句套话。

```tsx
<SectionHeading title="Profile" description="管理 dsh 的 profile 实例" extra={<Button>新建</Button>} />
```

### 3.3 NavList(`NavList.tsx`)
块状导航列表(Profile / DSH 复用)。条目是**独立圆角块**:画布底(`colorBgLayout`)在白 sider 上浮起;选中=主色左侧指示条 + `colorPrimaryBg` 底 + 标题加粗,悬停=`colorPrimaryBgHover`;内置 `loading` 骨架、空态、右侧操作槽。props 与旧版兼容。

```tsx
<NavList
  items={items}
  keyOf={i => i.id}
  selectedKey={selected}
  onSelect={i => select(i)}
  renderTitle={i => i.name}
  renderMeta={i => `${i.count} 项`}
  actions={i => <ConfirmMenu actions={actions(i)} onAction={k => act(i, k)} />}
  empty={<EmptyState title="没有数据" />}
/>
```

### 3.4 ActionCard(`ActionCard.tsx`)、ClickRegion(`ClickRegion.tsx`) 与 ScrollModal(`ScrollModal.tsx`)
- **`ActionCard`**:块状可点 / 可选中 / 可悬停 / 可选 `disabled` 的卡片,取代手写的 `Card` 入口卡与行条目。`selected` 显示主色左侧指示条,`hoverable` 悬停提升底色。它自带外壳,整张卡就是落点,**尾部槽(`extra`)里的节点在可点父节点内** —— 要塞控件就用 `ClickRegion`,或把控件放在卡片外面做兄弟。
- **`ClickRegion`**:「这块可点、点开的是某个东西」的**契约**,给自带外壳的面用(卡片的上半区、列表行里那段身份信息)。它只负责三件事:鼠标可点、Enter/Space 可点(`role="button"` + `tabIndex`,与按钮一致)、**不放任何自己的控件**。同一行的按钮必须是它的**兄弟节点**,否则一次点击会同时触发两者(`PluginCard` 的注释最早写了这条)。聚焦轮廓**不要**关掉(antd 的控件自己画,而一个没有轮廓的可点区域会让键盘用户不知道自己在哪)。要悬停底色就加 `className="pm-click-region"`(颜色走 `--pm-hover`,见 §5.1)。现在两个消费方:`views/PluginCard.tsx`、`views/PresetsSection.tsx`。
- **`ScrollModal`**:带滚动体的 Modal,`bodyMax: 'md' | 'lg' | px` 封装各处重复的 `maxHeight + overflowY:auto` 弹窗;宽度传 `MODAL.wide` / `MODAL.narrow`。长表单优先用它而不是裸 `Modal`,让 footer 常驻、内容在弹窗内滚动。
- **`useFileDrop` / `DropOverlay`**（`DropZone.tsx`）：文件拖拽导入。hook 只挂容器（hook 与可见提示分离，一次落点只触发一次）；**可见提示是覆盖层**，只在拖拽中或导入进行时出现，并带 `pointerEvents: none` —— 否则覆盖层自己会变成第二个落点，落不到容器的 handler 上。**不要**再做一个常驻的虚线方块：拖拽是瞬时手势，而常驻方块要占掉近百像素版面（dsh 技能面板与技能库两处都按覆盖层改过）。`dragover` 必须 `preventDefault`（否则浏览器把文件导航成页面）；`dragleave` 用计数配对防闪烁；`App.tsx` 另有全局守卫，落在非拖拽区的文件不会导航走应用。

### 3.5 Panel(`Panel.tsx`)
白底面板容器:把平铺的功能块(描述、表格、表单、列表)装进一块浮在画布(`colorBgLayout`)上的白色面板,让内容区读作一叠可分辨的块。可选 `title`/`extra` 头部行,`pad` 控制内边距。

```tsx
<Panel title="基本信息">
  <Descriptions …/>
</Panel>
```

### 3.6 表单与模态
- 表单字段一律配 `FieldLabel`(含必填星标),建立稳定可访问的 label。
- 弹窗内字段输入后,Enter 应可提交;提交按钮 `loading` 防重复提交。
- 危险操作(软删、卸载、移除)用 `ConfirmMenu` 的 `confirmText` 做二次确认,**不做裸删除按钮**。行操作少(≤2 项)时用显式按钮 + `confirmDanger`(`ConfirmMenu.tsx` 导出),别塞进 kebab——藏起来的操作等于不存在。
- 长表单可提供 表单/JSON 双模式(用 `Segmented` 切换,`CodeEditor` 做 JSON  pane):结构化输入是唯一真相源,JSON 是它的投影;JSON 非法时禁用提交,绝不在 JSON 模式下把输入反序列化回文本(会打乱光标)。
- 诊断/探测类操作(「测试」)失败是**结果**不是错误:IPC 返回 `value.ok:false` 并在原处内联展示成因与耗时,不要弹 `message.error`;异步结果行加 `role="status" aria-live="polite"`,否则读屏器对文字变化完全静默。
- **「打开」是欠定的一个动作**:目的地有两个(目录 / 文件),所以一律是**一个按钮 + 下拉两项**(在文件管理器中显示 / 用 VS Code 打开),不拆成并排两个图标,也不塞进 kebab —— 打开是条目的常规动作,藏起来等于不存在。preset 行与 skill 卡片共用这一形态(skill 侧收在 `views/SkillOpenMenu.tsx`);**两项都指向那个「东西」本身**:「在文件管理器中显示」给的是**目录**;「用 VS Code 打开」在 skill 上给的是**这个 skill 自己** —— bundle 是它的目录(编辑器按文件夹打开成工作区,脚本与素材就在树里),扁平单文件才是那个文件(它的"目录"是整个根,打开根等于打开别的 skill)。

### 3.7 状态反馈
成功 / 失败统一走 antd `message`:`message.success('已保存')`、`message.error(res.error)`。不要用 alert、console 或裸 toast 自造。

---

## 4. 三态规范(loading / empty / error)

每个异步 View 必须显式处理:

| 状态 | 标准做法 |
|---|---|
| **loading** | `NavList` 传 `loading`,或用 `Loadable` 包一层骨架屏;禁止整页白屏等数据 |
| **empty** | `EmptyState`(标题 + 一句说明 + 可选 CTA 按钮);文案要能指导下一步 |
| **error** | 操作失败 `message.error(apiErrorText(res))` —— 文案由 **`errors.<code>`** 在两种语言里给出，`params` 参与插值；**绝不**把裸 code 或裸参数当文案给用户。带原因的拒绝要把原因作为 `detail` 参数传下去（见 §7）。不允许静默失败 |
| **success** | 关键变更给 `message.success('<动词>成功')`,如「已保存」「已软删」 |

---

## 5. 主题与暗色

- 主题状态由 `ThemeProvider` 统一管理(亮 / 暗 / 跟随系统,持久化到 `localStorage`),切换见 App 顶栏 `Segmented`。
- 任何页面改动后,都切到**暗色**核对一遍:对比度、选中态、边框、阴影。
- 非 antd 的“页面级 chrome”(body 背景、滚动条)用 `theme.ts` 的 CSS 变量,不要另写固定色。

### 5.1 当前 CSS 变量清单(`cssVars()`)

`ThemeProvider` 目前向 `<html>` 注入以下变量(`theme.ts` → `global.css` 消费):

| 变量 | 亮色 | 暗色 | 消费方 |
|---|---|---|---|
| `--pm-bg` | `#eaeef6` | `rgba(0,0,0,0.28)` | `global.css` body 背景 |
| `--pm-surface-border` | `#e4e7f0` | `rgba(255,255,255,0.16)` | 预留(当前无消费方) |
| `--pm-scrollbar` | `rgba(0,0,0,0.22)` | `rgba(255,255,255,0.24)` | `global.css` 滚动条 thumb |
| `--pm-hover` | `rgba(0,0,0,0.03)` | `rgba(255,255,255,0.06)` | `global.css` `.pm-click-region:hover`(见 §3.4) |

> **已知缺口**:`global.css` 还使用了 `--pm-text`、`--pm-selection`、`--pm-scrollbar-hover`,但 `cssVars()` 尚未提供,目前走 fallback(亮色值)。其中 **`--pm-text` 在暗色下会回落深色 `#1f2430`**,导致 body 直接文字在暗色下对比度不足。新增页面 chrome 前,先在 `cssVars()` 补齐这三个变量的暗色值,再引用,而不是直接叠加新的 fallback 使用。

### 5.2 固定色豁免(刻意不随主题)

除下表外,颜色一律走 token:

| 位置 | 原因 | 现状 |
|---|---|---|
| `RunConsole.tsx` | 固定暗色终端 | 终端惯例统一深色;自带 ANSI 16 色板(`ANSI_FG` / `ANSI_FG_BRIGHT`)与运行态绿 `#7bd6a0`、链接蓝 `#7ec8ff`、状态圆点红黄绿 |
| `ProfileDetail.tsx` | diff 差异行高亮 | 临时直观红 `rgba(255,77,79,0.16)` 表示「与默认不同」;后续建议收拢到 `token.colorError` |

---

## 6. 可访问性检查清单(提交前逐项过)

- [ ] **对比度**:正文文字与背景满足 WCAG AA(≥ 4.5:1);主色按钮白字与主色对比达标(亮/暗都测)。
- [ ] **表单**:每个可输入控件有可见 label(用 `FieldLabel`);placeholder 不作为唯一提示。
- [ ] **焦点**:tab 键能走到所有可交互控件,焦点环清晰可见(antd focus 由 token 派生)。
- [ ] **键盘**:列表项可回车触发选中;`onSelect` 所在容器有 `role="option"` / `aria-selected`(NavList 已内置)。
- [ ] **非文本**:图标按钮(如 kebab)有 `aria-label`(`ConfirmMenu` 已内置「更多操作」)。
- [ ] **语言**:`<html lang="zh">`(已设)。

---

## 7. 内容与文案规范

- 界面文案中文;页面/区块标题用名词短语(「Profile」「插件总览」)。
- 中文括号用全角 ``()’’``,数字与单位(如 `bundle 30`)之间保留空格。
- 术语与包名保持原文:`bundle`、`profile`、`cordis.patch.yml`、`@deepseek-ai/dsh`。
- 报错不是技术 dump——**错误码是契约的一部分**：`core/shared/errors.ts` 的 `E` 是唯一来源（纯数据，落在
  `src/shared/error-codes.ts`，渲染层也读它），每个 code **必须**有两个语言的 `errors.<code>` 文案，
  否则用户看到的是裸 code 或裸参数。这条由 `i18n.test.ts` 的「每个 code 都有两种语言文案」全量对照强制。
- **拒绝要说明是哪一次拒绝**：同一个 code 往往有多条拒绝路径，具体原因走 `params`（约定 `detail`），
  文案里用 `{{detail}}` 插值。不要复用像 `name.invalid` 这种泛化 code —— `apiErrorText` **优先**返回
  本地化文案，泛化 code 会把真正有用的那句（eg. 哪个 URL 不合法）丢掉。
- 不要二次加工主进程给的文案：直接 `apiErrorText(res)` 上浮，别自己拼接。
- 空态文案要能指导下一步,如「为当前 DSH 创建一个 Profile」。
- 页头说明只报数据,不解释栏目(见 §3.2);解释性文字按需展开,**同一段解释只留一处** —— 页头说过的,面板头里不再重复一遍。
- **长时间的操作要在发起它的地方留下痕迹**。点了不等返回值、结果只在别处(顶栏下载中心)出现,用户看到的
  就是「按了没反应」。发起下载的页面要就地显示这条会话的状态、失败原因与取消入口(同一份 `useDownloads`
  数据,措辞与图标与下载中心一致);输入框在提交成功后清空,免得同一份来源被误点两次。**不要因为别处的
  任务在跑就禁掉发起按钮** —— 并行是这套会话模型的本来目的,该拦的只有「同一来源重复提交」。
- **失败给原因,细节留给「详情」,而详情里必须有真东西**。一行放不下 pnpm 的输出,所以在**失败点**就把
  它分类(`core/store/failure.ts`:找不到 / 需要认证 / 连不上 / 不是包 / 版本不存在 / 权限 / 脚本 ……),
  列表与提示条只显示**一句话的原因加一句可执行的下一步**;点开详情才是全量:分类结论、判定依据(原始报错行)、
  可复制的执行命令、**未经截断的完整日志**。三条硬要求:①失败时保留**完整** log,不能只留最后几行 ——
  「为什么」常常在开头(解析到哪一步失败);②分类必须能说「不知道」(`unknown` + 尾部证据),不许硬套一个
  像真相的猜测;③同一段日志里往往同时命中多个规则(git 认证失败同时也是网络错误),**按特征性排序**取最具体的。
- **控制台输出也算用户可见内容**。终端在拿不准编码时会把**整段**写入按另一套编码解释(启动横幅的 `█ ╔ ═ ╗`
  就这么变成了 `鈻堚枅`),所以:每条写入自成一个批次(横幅末尾自带换行,不和下一条日志粘在一起),并且
  经 `core/shared/console.ts` 的封装输出 —— 由它决定 BOM 与字节写法,**不要在别处再写一份**。

---

## 8. 代码规范

- 渲染层只通过 `window.api`(preload 白名单)访问主进程;不要出现 `require('electron')`、`ipcRenderer` 直连。
- 颜色 / 圆角 / 间距一律 token 化;`views/` 内不应再新增业务魔法值(操作控件的固定宽度如 `width: 220` 属布局,允许但克制)。例外的固定色豁免集中在 `RunConsole` 与 diff 高亮,见 §5.2。
- 共享物放 `components/`;新共享能力先判断是否已可用,勿在 View 内闭门自造。
- 组件命名:文件大写驼峰,默认导出;组件内部不用未使用的 import(CI noUnusedLocals)。
- 新增 View 必须:`AppShell` + `SectionHeading` + 三态齐备 + 分阶段套用。

---

## 9. 使用示例(拿来即用)

```tsx
export default function ExampleSection() {
  const { token } = theme.useToken()
  const [list, setList] = useState<Item[]>([])
  const [loading, setLoading] = useState(true)
  return (
    <AppShell sider={
      <NavList
        items={list} keyOf={i => i.id} loading={loading}
        renderTitle={i => i.name}
        onSelect={i => void act(i.id)}
      />
    }>
      <SectionHeading title="示例" description="一个规范化的 Section" />
      <EmptyState title="还没有数据" description="从左侧接入数据" />
    </AppShell>
  )
}
```


