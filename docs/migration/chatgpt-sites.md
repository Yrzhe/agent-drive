# Agent Drive：ChatGPT Sites / 原生 Cloudflare 版本

此版本在同一仓库中增加 Sites 部署目标，保留 EdgeSpark 部署方式，共享业务层。
原仓库是 `Yrzhe/agent-drive`；评估基线为 main `0c37177`（2026-07-20）。

## 功能及适配

| 原有功能 | Sites 实现 |
|---|---|
| 文件、文件夹、搜索、预览、重命名、移动、批量操作 | 共用原业务路由；原生 D1 元数据与 R2 对象 |
| 大文件上传、下载 | 8–64 MiB 动态 R2 multipart 分块；上传/下载流式响应、短期签名同源 URL、HEAD、Range |
| 回收站、恢复、永久删除、30 天清理、配额 | 原有规则保留；新增过期 multipart 会话清理 |
| 密码、过期、次数限制的文件/目录/root 分享、ZIP | 原有分享处理器保留；私有 Sites 还要求平台访问权限 |
| 文件版本历史、恢复、上传二进制新版本 | Sites 新增不可变 R2 对象与 D1 版本记录；并发更新返回 409；历史计入配额 |
| 固定 A / 跟随最新 B 的稳定分享 | REST 与 MCP 支持固定版本或最新内容；打开/下载时解析最新指针 |
| 持久记忆、key 更新、标签、FTS、重建索引 | 原生 D1，迁移创建 FTS5 虚拟表 |
| 多用户隔离、审批、allowlist、封禁 | ChatGPT 身份按 Site-scoped subject 映射；原有审批和 ownerId 隔离 |
| Shared Spaces、引用分享、角色、公共 commons | 共用业务；public commons 仍只向 active 用户开放 |
| Remote MCP：16 个工具 | 原生 `/mcp` 使用 Sites OAuth；`/api/public/mcp` 保留应用 bearer 兼容 |
| OAuth、scope、路径权限、可撤销 token | 原有应用 OAuth 保留供外部/CLI；原生入口独立使用平台 OAuth |
| CLI push/pull/history/rollback、stdio bridge | 保留；新增按明确 origin 发送环境中的平台服务凭证 |
| 发布 bundle、Ed25519 签名订阅、contacts、signed inbox | 处理器保留；私有 Site 的外部订阅/跨 Drive 投递受平台边界限制 |
| 活动、应用 webhooks、注册意图、guide、llms、skill、Agent Card | 保留并补充 Sites 协议和限制 |

## 代码结构与构建

- `server/src/platform/types.ts`：业务需要的运行时接口。
- `server/src/platform/edgespark.ts`：原 SDK 适配器；默认 TS/Vitest 仍使用它。
- `server/src/platform/sites/`：请求上下文、可信身份、原生 D1/R2、传输和 Worker 入口。
- `web/src/lib/sites.ts`：同源 API 与顶层 ChatGPT 登录链接；Vite `VITE_PLATFORM=sites` 选择它。
- `platforms/chatgpt-sites/drizzle/`：Sites 独立的 Drizzle 迁移链，不创建 EdgeSpark 系统表。
- `platforms/chatgpt-sites/.openai/hosting.json`：逻辑 DB、BUCKET 及 MCP 能力模板，没有具体 Site ID。
- `server/scripts/build-sites.mjs`：输出 `dist/server/index.js`、SPA、hosting manifest 和迁移。

```bash
npm ci --prefix server
npm ci --prefix web
npm run build:sites
cd server
npm run typecheck
npm test
npm run test:sites  # 需要本机 loopback；使用实际 workerd/D1/R2
```

EdgeSpark 继续使用原 `edgespark.toml`、生成 SDK 和 CLI 部署流程。
业务接口只在请求期间读取，Sites 身份不通过进程级全局变量传递。
浏览器新增 feature-detected WebMCP `read_visible_drive`，只读取当前界面；它与 Remote MCP 不同。

## Sites 部署

在独立 Sites checkout 中复制当前仓库源码及逻辑 manifest，注册一次并将返回的
`project_id` 写入该 checkout 的 `.openai/hosting.json`。产品仓库的 origin 保持 GitHub。
Sites 保存的是源码快照；产品仓库更新不会自动部署到 Site。

通过 Sites 环境变量配置 `OWNER_EMAIL`、强随机 secret `AGENT_TOKEN`、`ALLOWED_ORIGIN`，
以及可选 `MCP_ALLOWED_ORIGINS`、`MAX_FILE_BYTES`、`MAX_TOTAL_BYTES`。
真实邮箱和 token 不写入公开源码。Sites 入口在缺少绑定、管理员或 secret 时返回 503，
避免使用旧版未配置管理员时的 trust-any 行为。不会自动将第一个访客设为管理员。

Sites 默认单文件限制 625 GiB（671088640000 字节），总配额 1 TiB（1099511627776 字节）。
分片按声明大小动态选择 8–64 MiB，始终不超过 R2 的 10,000 片。
这两个数是应用配置，不代表 Sites 官方配额；625 GiB 是当前上传方式的支持上限。
EdgeSpark 默认值仍是 500 MiB / 5 GiB。MCP 文本读写 5 MiB、inbox 5 MiB、
ZIP 30 MiB / 400 个文件的现有限制保留。
R2 binding 不需要、也不能生成 S3 presign 凭证；上传分块与短期下载 grant 均由 Worker 管理。

推送准确源码快照，构建并打包 Worker/静态文件/迁移，再保存并部署私有版本。
部署返回成功并不等于用户已在 Developer Mode 完成连接；OAuth 授权需要使用者登录。

## 在 ChatGPT Developer Mode 调试

1. 使用管理员的 ChatGPT 账号打开 Site，确认 Connect / Admin 可访问。
2. ChatGPT 设置中启用 Developer Mode，创建 Remote MCP / plugin。
3. 使用 Sites 返回的 `mcp_connection.mcp_url`（站点原生 `/mcp`），选择 OAuth，完成 ChatGPT 授权。
4. 刷新工具元数据并开始新聊天；先测试 `list_files`、`write_file`、`read_file`，再测记忆和空间。
5. 若账户 pending / suspended，先处理应用审批；平台登录成功不自动授予应用访问权。

MCP 2.0 使用 `2026-07-28`：`server/discover`、每请求 namespaced `_meta`、匹配的
`MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name`，无会话 ID。
旧版 initialize 协商保留。工具有读写/破坏性/幂等/外部副作用标注。
完整报文与 multipart 顺序见 [Sites skill](../../skill/references/sites.md)。

## 必须理解的边界

- 私有 Site 的平台访问控制适用于所有应用路径。分享 token、signed inbox、published bundle
  本身不会绕过平台边界。本版本没有擅自把 Site 公开。
- CLI 的 `ADRIVE_SITES_URL` / `ADRIVE_SITES_AUTHORIZATION` 从安全环境读取；
  服务凭证只对指定 origin 发送，拒绝带凭证的重定向。应用 token 仍决定主体、scope 和路径权限。
- 旧 EdgeSpark 数据没有自动搬迁。线上数据转移需要单独备份/导出，复制 R2、映射每个旧用户
  到新 subject 后重写所有用户引用、重建 FTS、核对 bundle 与分享签名。不能按邮箱自动合并。
- 未在允许的浏览器上下文中验证 WebMCP 时，只报告该验证不可用；不能声称浏览器执行已通过。

## 原生 Cloudflare 后续完善顺序

目前 Sites 的公开配置入口提供 Workers、D1、R2 和原生 MCP/OAuth，尚未找到
Durable Objects、KV、Queues、Cron 的绑定声明或资源创建入口。因此当前不依赖这些服务。
D1 本身串行执行并会排队，但不能将其视为可供应用使用的 Durable Object 实例。
KV 的最终一致性也不适合版本指针、权限和配额；这些继续保存在 D1。

Cloudflare 公布的底层限制与 Sites 套餐额度应分别核对：Workers 每 isolate 128 MB 内存；
常见账户的单请求 body 为 100 MB 起，所以当前分片最多 64 MiB；R2 单对象 5 TiB、
multipart 上传约 4.995 TiB、最多 10,000 片、桶存储无限（不等于免费或 Sites 承诺无限）。
D1 每库为 Free 500 MB / Paid 10 GB，行大小 2 MB、每查询最多 100 个参数。
Sites 没有在当前接口中公开实际 Cloudflare 套餐、CPU/请求/存储计费额度；不能把 Paid 上限
当作本 Site 已获额度。大文件接近上限的实际上传仍需生产端验证。

1. 支持平台提供的绑定后，将 multipart/回收站清理和 quota 聚合接入 Cron；高并发写入可用
   Durable Objects 排队，减少 D1/R2 跨资源竞争。当前使用有界请求内操作和机会性后台清理。
2. 用持久 outbox + Queues 做 webhook 投递、重试、死信和 activity 游标，而不是仅 waitUntil。
3. 可选异步内容提取、预览、Workers AI / Vectorize 语义检索；保持当前 FTS、权限和配额为基础。
4. 再实现 MCP Events：`events/list` / `subscribe` / `unsubscribe`、D1 订阅与过期/撤销、
   callback challenge 验证、Standard Webhooks 签名、HTTPS/DNS 固定和禁止重定向、
   稳定 event ID 与有界重试。先从 `file.uploaded`、`memory.updated`、空间变化开始。

这些是后续能力建议，当前没有声明 Events、Queues、DO、AI 或 Vectorize 已上线。
既有应用 webhooks 与 MCP Events 的协议不同，不能将 SSE 连接直接当作 Events。

版本历史现已实现，入口在文件列表的 Versions 按钮；创建分享时可选 Follow latest 或 Fixed version。
最新链接在重新打开或请求下载时指向 B，固定链接始终指向选定的 A。
已经签发的短期下载 URL 仍只授权原对象；已经打开的页面暂时没有实时推送。
后续若 Sites 开放 DO，可按分享 ID 建立 WebSocket hub：D1 提交版本后发出版本变更事件，
hub 推送给在线订阅者，前端按版本 ID 拉取一次新元数据；断线重连时核对最新版本。
不能用 Worker 全局内存广播保证跨实例一致性，KV 最终一致性也不能替代这个 hub。

## 官方资料（2026-10-01 核对）

- [ChatGPT Developer Mode](https://developers.openai.com/api/docs/guides/developer-mode)
- [连接 ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [MCP Events](https://developers.openai.com/plugins/build/mcp-events)
- [MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28)
- [MCP transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [R2 limits](https://developers.cloudflare.com/r2/platform/limits/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
