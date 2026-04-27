# AGENTS.md - Astro Blog SkyRain

## 项目简介

**名称**: astro-blog-skyrain  
**类型**: 个人博客  
**技术栈**: Astro 5 + Pure 主题 + Cloudflare Pages  
**特色**: 自建评论系统（Pages Functions + D1 + Turnstile）

**本地路径**: `/root/.openclaw/workspace/astro-blog-skyrain`  
**GitHub**: `KamijoToma/astro-blog-skyrain`  
**部署地址**: `https://1d2419bd.astro-blog-skyrain.pages.dev`

---

## 项目结构

```
astro-blog-skyrain/
├── .github/workflows/deploy.yml    # GitHub Actions 自动部署
├── functions/api/comments/         # Pages Functions
│   └── index.ts                    # 评论 API（GET/POST）
├── migrations/
│   └── 0001_init_comments.sql      # D1 数据库迁移文件
├── src/
│   ├── components/comments/
│   │   └── CommentWidget.astro     # 评论组件
│   ├── layouts/
│   │   └── BlogPost.astro          # 文章布局（含评论）
│   ├── content/blog/               # 博客文章（Markdown）
│   └── site.config.ts              # 站点配置
├── wrangler.jsonc                  # Cloudflare 配置
└── package.json
```

---

## 开发规范

### ⚠️ 强制规则

**1. 推送前必须本地验证**

- 所有更改必须先本地构建验证
- 命令: `bun run build`
- 要求: 0 errors，退出码 0
- **严禁未经验证直接 push**

**2. Git 身份**

```bash
git config user.name "Kimi Claw"
git config user.email "kimi.claw@openclaw.ai"
```

**3. 构建命令**

- 使用 `bun run build`，不是 `npm run build`
- 输出目录: `dist/`
- 兼容性日期: `2025-03-21`（不能是未来日期）

---

## 本地开发

### 启动本地服务器

**纯静态（无 Functions）:**

```bash
bun run build
python3 -m http.server 4321 --directory dist
```

**完整功能（含 Functions + D1）:**

```bash
bunx wrangler pages dev dist --port 8080 --ip 0.0.0.0 --d1 BLOG_DB
```

**访问地址:**

- http://10.188.96.8:8080
- http://100.111.93.8:8080 (Tailscale)

### 端口冲突处理

如果提示 `Address already in use`：

```bash
# 查找占用端口的进程
lsof -i :8080
ss -tlnp | grep 8080

# 杀死 workerd 进程
pkill -9 workerd

# 或换端口
bunx wrangler pages dev dist --port 3000 --ip 0.0.0.0 --d1 BLOG_DB
```

---

## D1 数据库

### 本地数据库位置

```bash
# 数据库文件目录
.wrangler/state/v3/d1/miniflare-D1DatabaseObject/

# 可能有多个 .sqlite 文件，都执行迁移
sqlite3 .wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite ".tables"
```

### 手动创建表（如果迁移失败）

```bash
sqlite3 .wrangler/state/v3/d1/miniflare-D1DatabaseObject/[文件名].sqlite < migrations/0001_init_comments.sql
```

### 查看/审核评论

```bash
# 查看所有评论
sqlite3 [数据库文件] "SELECT * FROM comments;"

# 查看待审核评论
sqlite3 [数据库文件] "SELECT * FROM comments WHERE status='pending';"

# 审核通过
sqlite3 [数据库文件] "UPDATE comments SET status='approved' WHERE id=1;"
```

### 应用迁移

```bash
# 本地
bunx wrangler d1 migrations apply astro-blog-comments --local

# 生产环境
bunx wrangler d1 migrations apply astro-blog-comments --remote
```

---

## 关键配置

### D1 数据库 ID

| 环境       | 数据库名                    | ID                                     |
| ---------- | --------------------------- | -------------------------------------- |
| Production | astro-blog-comments         | `9faddd83-cc4d-4e36-8c61-69a343ac1a2e` |
| Preview    | astro-blog-comments-preview | `62edddd2-cd36-4b49-a240-b0ea71069d4d` |
| Binding    | BLOG_DB                     | -                                      |

### Turnstile Keys

- **Site Key**: `0x4AAAAAACuN1mqNqDeEKv0e`
- **Secret Key**: (在 Cloudflare Dashboard Secrets 中)

### 兼容性日期

wrangler.jsonc 中必须设置为 `2025-03-21`，不能是未来日期。

---

## 已知问题

### 类型错误处理

如果遇到 `posts` 类型不匹配：

```typescript
// src/pages/blog/[...id].astro
const posts = sortMDByDate(await getBlogCollection()) as CollectionEntry<'blog'>[]
const { post, posts } = Astro.props as Props
```

### 评论 API 500 错误

检查：

1. D1 表是否创建（comments, comment_rate_limits）
2. 本地数据库文件是否正确（可能有多个 .sqlite 文件）
3. 使用 `wrangler pages dev` 而非纯静态服务器

---

## 部署流程

```
1. 本地修改代码
2. bun run build 验证
3. bunx wrangler pages dev 预览（可选）
4. git add + commit + push
5. GitHub Actions 自动部署
6. 访问线上地址验证
```

---

## 资源链接

- **Cloudflare Dashboard**: https://dash.cloudflare.com/
- **GitHub Actions**: https://github.com/KamijoToma/astro-blog-skyrain/actions
- **部署地址**: https://1d2419bd.astro-blog-skyrain.pages.dev
- **详细笔记**: `obsidian-notebook/04-Resources/astro-blog-setup-guide.md`

---

**最后更新**: 2026-03-22
