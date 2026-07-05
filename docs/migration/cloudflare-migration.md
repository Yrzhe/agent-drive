# 部署迁移方案：EdgeSpark → Cloudflare 原生

日期：2026-07-05
状态：评估完成，未排期

本文档记录一次架构可移植性评估的结论：当前技术栈能否以及如何迁移到
Cloudflare 原生部署（Workers + D1 + R2 + wrangler）。

**结论：可以迁，成本可控。** 这套技术栈本来就跑在 Cloudflare 上
（EdgeSpark 底层即 Workers + D1 + R2），真正绑定平台的只有一层很薄的 SDK。

## 1. 完全不用动的部分（占绝大多数）

| 组件 | 说明 |
|---|---|
| Hono | Workers 上最主流的框架，原生支持 |
| Drizzle ORM | SQLite 方言，Cloudflare 原生即 `drizzle-orm/d1`；`db.batch()` 是 D1 原生能力 |
| 迁移文件 | `server/drizzle/` 下是纯 SQL，可直接用 `wrangler d1 migrations apply` 重放 |
| 前端 | React + Vite SPA；EdgeSpark 用 Workers Static Assets 托管，迁移后托管方式一致，SPA fallback 在 `wrangler.toml` 配一行 |
| 业务逻辑 | `server/src/routes/`、`lib/`、`middleware/` 是纯 TypeScript，零平台依赖 |
| CLI 与 skill | `adrive` 只认 base URL（登录时传入，存于 `~/.agent-drive/config.json`），对部署平台无感知 |
| 纯 JS 依赖 | `fflate`、`nanoid` 等无平台绑定 |

## 2. EdgeSpark 耦合面清单

全项目对 `edgespark` SDK 的调用点约 **55 处，分布在 15 个文件**，
且全部是 handler 内部的 `await import("edgespark")` 动态导入，耦合面很窄。
只用了 5 个原语：

| EdgeSpark 原语 | Cloudflare 原生替代 | 工作量 |
|---|---|---|
| `db`（Drizzle D1 客户端） | `drizzle(env.DB)`（D1 binding），接口几乎 1:1 | 机械替换 |
| `storage` presigned URL（`createPresignedPutUrl` / `createPresignedGetUrl`，约 10 处） | R2 binding 本身不支持 presigned URL；用 R2 的 S3 兼容 API + `aws4fetch` 自行签名（社区标准做法），或改为经 Worker 中转下载 | **第二大项**，可用一个工具函数封装 |
| `auth`（EdgeSpark 内置登录，Better Auth 兼容形态） | 换成 Better Auth（官方支持 Workers + D1）。`server/src/__generated__/sys_schema.ts` 中的 `esSystemAuthUser` / `esSystemAuthAccount` / `esSystemAuthSession` 与 Better Auth schema 对应 | **最大的一项**：服务端中间件（`server/src/middleware/auth.ts` 的 `auth.isAuthenticated()`）+ 前端 `@edgespark/web` 的 `authUI.mount()` 需换成自建登录 UI |
| `secret.get` / `vars.get` | Workers `env` + `wrangler secret put`。当前仅 3 个 key（见 `server/src/defs/runtime.ts`）：secret `AGENT_TOKEN`；vars `ALLOWED_ORIGIN`、`AGENT_TOKEN_SCOPES` | 琐碎 |
| `ctx.runInBackground` | `executionCtx.waitUntil` | 琐碎 |

调用点分布（`await import("edgespark")` 计数）：
`routes/files.ts` 14、`routes/oauth.ts` 7、`routes/shares.ts` 6、
`routes/bundles.ts` 6、`routes/public-shares.ts` 5、`routes/webhooks.ts` 4、
`lib/activity.ts` 3、`middleware/auth.ts` 2、`lib/mcp-tools.ts` 2，
其余文件各 1。

## 3. 推荐迁移策略：先抽 platform 适配层

因为所有 SDK 访问都是运行时动态 import，可以先建
`server/src/lib/platform.ts` 适配层，统一导出
`{ db, storage, secret, vars, ctx, auth }`，把 55 处调用点指向它。

好处：

- 之后切换平台只改这一个文件，业务代码零改动；
- 这一步现在就可以做，不影响 EdgeSpark 部署；
- 单测更好写（适配层可 mock）。

## 4. 迁移步骤 Checklist

1. **准备**
   - [ ] 抽出 `platform.ts` 适配层（可提前在 EdgeSpark 上完成并验证）
   - [ ] 新建 `wrangler.toml`：Worker 入口、D1 binding、R2 binding、
         Static Assets（`web/dist`，SPA fallback）、vars
2. **数据库**
   - [ ] `wrangler d1 create` 新库
   - [ ] 用 `server/drizzle/*.sql` 重放迁移（`wrangler d1 migrations apply`）
   - [ ] Better Auth 的用户/会话表迁移（生成其 schema 并导入既有用户，
         密码 hash 兼容性需验证；不兼容则走"首次登录重置密码"路径）
   - [ ] 存量数据导出导入：`wrangler d1 export` / import，或走 SQL dump
3. **存储**
   - [ ] 创建 R2 bucket，配置 S3 API 访问密钥（供 presigned URL 签名）
   - [ ] 存量对象迁移：`rclone` 同步（R2 → R2 可用 S3 协议对拷）
   - [ ] 实现 `aws4fetch` 签名的 presigned PUT / GET 工具函数，替换适配层实现
4. **鉴权**
   - [ ] 服务端：Better Auth 初始化，`requireDualAuth` 中间件改为
         Better Auth session 查询（bearer token 路径不变，走
         `lib/mcp-auth.ts`，无平台依赖）
   - [ ] 前端：`web/src/lib/edgespark.ts` 替换为 Better Auth client；
         登录 UI 自建（当前 `authUI.mount()` 为托管 UI）
   - [ ] `configs/auth-config.yaml` 的语义（禁注册、邮箱密码、密码最短长度）
         迁到 Better Auth 配置
5. **secrets / vars**
   - [ ] `wrangler secret put AGENT_TOKEN`
   - [ ] vars：`ALLOWED_ORIGIN`（如需）、`AGENT_TOKEN_SCOPES`（如需）
6. **验证**
   - [ ] `server`：`npm run typecheck && npm test`
   - [ ] `web`：`npm run lint && npm run build && npm test`
   - [ ] `cli`：`npm run check && npm test`
   - [ ] 端到端：上传 → 分享 → 接收方下载 ZIP；MCP OAuth 全流程；
         `adrive sync push/pull`；webhook 投递
7. **切流**
   - [ ] 新域名指向 Workers（见 `docs/conventions/website-domain.md`）
   - [ ] 旧域名 301 重定向保留一段时间（存量分享链接、OAuth 客户端配置、
         CLI 本地配置都指向旧域名）

## 5. 已知注意点

- EdgeSpark 的路由约定（`/api/public/*` 可选注入 session、`/api/*` 强制登录）
  是平台行为；迁移后路由完全自控，双重鉴权中间件直接用 Better Auth
  session 查询即可，反而更简单。
- OAuth discovery 路径当前放在 `/api/public/.well-known/*`
  （EdgeSpark 要求服务端路由都在 `/api/*` 下）；迁移后可以把
  `/.well-known/*` 挂到标准根路径，并保留旧路径做兼容。
- R2 presigned URL 是对 R2 存储端点签名的，与应用域名无关，
  换域名/换平台不影响已签发链接的机制（但有效期内旧链接指向旧 bucket 端点，
  切流时注意窗口期）。
- `server/src/__generated__/` 是 EdgeSpark 生成物；迁移后
  `edgespark.d.ts` / `server-types.d.ts` 不再需要，
  由适配层的自有类型替代。
