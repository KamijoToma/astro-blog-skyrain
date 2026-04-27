# AI 辅助创作声明徽章 — 设计文档

日期：2026-04-27

## 概述

在博客文章详情页的 Hero 元数据区域添加 AI 辅助创作声明徽章，通过 frontmatter 逐篇控制，支持两个级别。

## Frontmatter 设计

在 `src/content.config.ts` 的 blog schema 中新增可选字段：

```ts
ai: z.enum(['polish', 'create']).optional()
```

- `"polish"` — AI 辅助润色：人工撰写为主，AI 参与润色/优化
- `"create"` — AI 创作：大部分内容由 AI 生成，作者审核校对
- 不设置 = 不显示声明

## 视觉设计

### 位置

嵌入 Hero 组件的元数据行（`<div class='flex flex-wrap gap-x-4 gap-y-2 ...'>`），与日期、阅读时间、语言、标签并列，作为行内胶囊徽章。

### 样式

胶囊形（`rounded-full`），内含 emoji 图标 + 文字，两种级别用颜色区分：

| 级别 | emoji | 文字 | 背景色 | 文字色 |
|------|-------|------|--------|--------|
| `polish` | 🤖 | AI 辅助润色 | 蓝色系 | 深蓝 |
| `create` | 🤖 | AI 创作 | 紫色系 | 深紫 |

### CSS 自定义属性

在 `src/assets/styles/global.css` 中新增 4 个变量，亮色/暗色分别定义：

**亮色模式（`:root`）：**
```css
--ai-polish-bg: 220 89% 96%;    /* #dbeafe */
--ai-polish-fg: 221 83% 53%;    /* #1d4ed8 */
--ai-create-bg: 263 70% 96%;    /* #ede9fe */
--ai-create-fg: 263 70% 50%;    /* #6d28d9 */
```

**暗色模式（`.dark`）：**
```css
--ai-polish-bg: 220 70% 18%;
--ai-polish-fg: 210 100% 75%;
--ai-create-bg: 260 50% 18%;
--ai-create-fg: 250 95% 75%;
```

### HTML 结构

```html
<span class="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium"
      style={`background: hsl(var(--ai-${ai}-bg)); color: hsl(var(--ai-${ai}-fg));`}>
  🤖 {label}
</span>
```

其中 `ai` 为 `"polish"` 或 `"create"`，`label` 为对应中文文字。

## 涉及文件

### 1. `src/content.config.ts`
新增 `ai` 字段到 blog collection schema。

### 2. `src/assets/styles/global.css`
在 `:root` 和 `.dark` 块中各添加 4 个 CSS 自定义属性。

### 3. `src/layouts/BlogPost.astro`
将 `post.data.ai` 传递给 Hero 组件。

### 4. `packages/pure/components/pages/Hero.astro`
- Props 接口新增 `ai?: 'polish' | 'create'`
- 在元数据行中，tags 渲染之后、`<slot name='info' />` 之前，条件渲染 AI 徽章

## 不涉及

- 文章列表页（PostPreview）不显示
- RSS feed 不输出
- 不影响 SEO meta
- 无可交互元素（不可关闭/展开）
