# Docs 索引

| 目录 / 文件 | 内容 |
|---|---|
| [`product/agent-exchange-roadmap.md`](product/agent-exchange-roadmap.md) | 产品路线图：从云盘到 Agent 信息交换平台的方向调研、驱动力分析、功能提案与落地顺序 |
| [`migration/cloudflare-migration.md`](migration/cloudflare-migration.md) | 部署迁移：EdgeSpark → Cloudflare 原生的可移植性评估、耦合面清单与迁移 checklist |
| [`conventions/website-domain.md`](conventions/website-domain.md) | 网站与域名规范：动态 origin 约定、域名审计结果、换域名 checklist、landing page 规划 |
| [`api/`](api/) | API 文档：REST、MCP、OAuth、bundles |
| [`setup/`](setup/) | 各 MCP 客户端（Claude / Cursor / Codex / Gemini / Windsurf）接入指南与兼容性 |
| [`audits/`](audits/) | 历史产品审计（含 here.now 对比） |
| [`implementation/`](implementation/) | 实现记录（按日期） |

新增文档约定：

- 方向性 / 未排期的提案放 `product/`，注明日期与状态。
- 一次性的评估或方案放对应主题目录（如 `migration/`），完成后保留作为决策记录。
- 长期生效的工程约定放 `conventions/`，代码 review 时可直接引用。
