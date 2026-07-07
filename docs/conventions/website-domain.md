# 网站与域名规范

日期：2026-07-05
状态：生效中的约定 + 换域名 checklist

本文档规定域名相关的代码约定，记录一次全库域名审计的结果，
并给出未来换域名 / 上 landing page 时的操作清单。

## 1. 代码约定（必须遵守）

1. **服务端生成 URL 时，一律从当前请求推导 origin**：
   `new URL(c.req.url).origin`。禁止写死域名。
   现有示例：`server/src/routes/shares.ts`、`mcp.ts`、`guide.ts`。
2. **OAuth issuer 使用 `vars.get("ALLOWED_ORIGIN") ?? 请求 origin`**
   （`server/src/routes/oauth.ts`、`oauth-discovery.ts`）。
   `ALLOWED_ORIGIN` 是唯一允许"固定"域名的地方，且必须是环境变量而非代码。
3. **前端一律用 `window.location.origin`**
   （示例：`web/src/pages/ShareDownloadPage.tsx`、`ConnectSetupPage.tsx`）。
   MCP 配置片段生成（`web/src/lib/mcp-snippets.ts`）从页面 origin 取值。
4. **CLI 不得内置默认域名**：base URL 由用户登录时传入，
   存于 `~/.agent-drive/config.json`。
5. **文档与示例中的域名用占位符**：`<YOUR_AGENT_DRIVE_URL>` 或
   `https://your-drive.example.com` 风格。避免把真实部署实例的 URL
   写进对外文档（历史遗留见下文 §2.2）。
6. 新增代码涉及回调 / 跳转 / 生成链接时，PR review 需检查是否符合以上约定。

## 2. 审计结果（2026-07-05）

### 2.1 运行时：全部动态检测，无写死域名 ✅

- 分享链接、guide、MCP discovery：请求 origin 推导。
- OAuth issuer：`ALLOWED_ORIGIN` 变量优先，缺省跟随请求 origin。
- 前端与 CLI：均为运行时取值。

### 2.2 存在硬编码但非运行时的位置

| 位置 | 内容 | 处理建议 |
|---|---|---|
| `metadata.json` | `production_url` 指向当前 EdgeSpark 实例 | 信息性字段，换域名时更新 |
| `docs/setup/mcp-*.md`、`docs/implementation/2026-05-08-mcp-endpoint.md`、`docs/api/README.md` | 以真实实例 `<YOUR_AGENT_DRIVE_URL>` 作为示例 | 换品牌域名 / 对外开源前替换为占位符 |
| `skill/drive.json.example`、`skill/references/*`、`README.md` | `your-drive.edgespark.app` 类占位符 | 合规，保留 |
| `web/src/pages/ConnectSetupPage.tsx`、`web/src/pages/BundlesPage.tsx` | GitHub 仓库文档链接 | 与域名无关，仓库改名时才需要动 |

## 3. 换域名 Checklist

代码零改动（见 §2.1），操作集中在运营层面：

1. [ ] 新域名绑定到部署平台（EdgeSpark 自定义域名或 Cloudflare 自定义域名）。
2. [ ] 若设置过 `ALLOWED_ORIGIN` 环境变量，更新为新 origin；
       未设置则自动跟随，无需操作。
3. [ ] 旧域名保留一段时间做 301 重定向。存量指向旧域名的东西：
   - 已发出去的分享链接；
   - 他人 MCP 客户端里已注册的 OAuth 配置（issuer 变更后客户端需重新
     走 discovery / 重新授权）;
   - CLI 用户本地 `~/.agent-drive/config.json`（需重新 `adrive login`
     或手动改 URL）；
   - skill 用户本地的 `drive.json`。
4. [ ] 替换 §2.2 中文档里的真实实例 URL。
5. [ ] 更新 `metadata.json` 的 `production_url`。
6. [ ] R2 presigned URL 对存储端点签名、与应用域名无关，**不受影响**，
       无需操作。

## 4. Landing Page 规划

现状：SPA 的 `/` 直接是登录后的 Dashboard，没有面向公众的首页。

两个方案：

| 方案 | 结构 | 优劣 |
|---|---|---|
| **A. 独立营销站（推荐）** | 根域 `example.com` 放静态 landing；应用放 `app.example.com` | SEO 好、首屏快；后续加 docs / blog 从容；多一个部署单元 |
| B. SPA 内置公开首页 | 未登录访问 `/` 显示 landing，登录后进 Dashboard | 改动小；SEO 与首屏性能弱 |

方案 A 的补充约定：

- 营销站独立目录（如 `landing/`）或独立仓库，静态生成
  （Astro / 纯静态均可），部署为另一个 Workers Assets 站点。
- 应用侧代码不感知营销域名；所有"回到官网"类链接用相对配置注入，
  不写死。
- landing 上的 CTA 指向 `app.` 子域与 GitHub 仓库；
  `/guide`（Agent 可读指南）保留在应用域名下，因为它是 API 的一部分。

## 5. 相关文档

- 部署迁移：`docs/migration/cloudflare-migration.md`
- 产品路线图：`docs/product/agent-exchange-roadmap.md`
