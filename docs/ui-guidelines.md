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

### 3.4 ActionCard(`ActionCard.tsx`) 与 ScrollModal(`ScrollModal.tsx`)
- **`ActionCard`**:块状可点 / 可选中 / 可悬停 / 可选 `disabled` 的卡片,取代手写的 `Card` 入口卡与行条目。`selected` 显示主色左侧指示条,`hoverable` 悬停提升底色。
- **`ScrollModal`**:带滚动体的 Modal,`bodyMax: 'md' | 'lg' | px` 封装各处重复的 `maxHeight + overflowY:auto` 弹窗;宽度传 `MODAL.wide` / `MODAL.narrow`。

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
- 危险操作(软删、卸载、移除)用 `ConfirmMenu` 的 `confirmText` 做二次确认,**不做裸删除按钮**。

### 3.7 状态反馈
成功 / 失败统一走 antd `message`:`message.success('已保存')`、`message.error(res.error)`。不要用 alert、console 或裸 toast 自造。

---

## 4. 三态规范(loading / empty / error)

每个异步 View 必须显式处理:

| 状态 | 标准做法 |
|---|---|
| **loading** | `NavList` 传 `loading`,或用 `Loadable` 包一层骨架屏;禁止整页白屏等数据 |
| **empty** | `EmptyState`(标题 + 一句说明 + 可选 CTA 按钮);文案要能指导下一步 |
| **error** | 操作失败 `message.error(res.error)`,错误字符串来自主进程 `IpcResult.error`;不允许静默失败 |
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
- 报错不是技术 dump——主进程 `IpcResult.error` 通常是可读文案,直接上浮即可,不要二次加工。
- 空态文案要能指导下一步,如「为当前 DSH 创建一个 Profile」。

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

---

## 10. 后续阶段路线

以下本轮已完成、但刻意放后推进的深化项,标记为后续:

- **插件管理页 / 设置页完整重构** —— 本轮仅做了轻量对齐(套 `AppShell` + token 化、统一状态 Tag);完整重构(下载中心卡片化、安装向导、表格分页体验)留待下一批。
- **更多共享组件** —— 本轮已新增 `ActionCard` / `ScrollModal`,并升级 `NavList`(块状)、`SectionHeading`(`sticky`),同时清掉 `PluginsSection` 的硬编码弹窗宽度;仍待抽 `DataTable`(统一表格+加载+空态)、`ModalForm`(表单弹窗统一)、`InlineConfirm`(行内二次确认)。
- **可视化 design-system 页面** —— 如需要可生成交互式样式参观页(artifactory),供设计与评审对齐。
- **补齐 `cssVars()` 的暗色 chrome 变量** —— 注入 `--pm-text` / `--pm-selection` / `--pm-scrollbar-hover` 的暗色值(见 §5.1 已知缺口)。
- **主色 / 品牌** —— 当前深蓝是中性预设,若 dsh 有正式品牌色,仅在 `theme.ts` `BRAND` 一处替换即可全量生效。

