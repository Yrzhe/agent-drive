# Agent Drive → Agent 信息交换平台：产品路线图

日期：2026-07-05
状态：方向性提案（未排期）

本文档整理了一次产品方向调研的结论：Agent Drive 如何从"Agent-native 云盘"
演进为"个人 Agent 之间的点对点信息交换层"，以及每个候选功能背后的驱动力分析。

## 1. 核心判断

当前产品的分享流程里，**人是传输层**：Agent 生成交接消息 → 人复制 → 发给对方
→ 对方粘贴给他的 Agent。缺的那个关键功能是：

> **Drive 与 Drive 之间的直接互联（Agent 身份 + 收件箱）**

把人肉复制粘贴去掉之后，产品就从"云盘"变成"Agent 间的信息交换网络"，
且每一次分享天然成为拉新渠道（对方要想优雅地收件，最好也部署一个 Drive，
与 Email 早期的增长逻辑相同）。

## 2. 外部环境调研（2026 年中）

| 领域 | 现状 | 对本产品的启示 |
|---|---|---|
| A2A 协议 | Linux Foundation 托管，v1.0 稳定，150+ 组织生产使用；签名 Agent Card（`/.well-known/agent.json`）成为 Agent 身份事实标准；已内置于 Azure AI Foundry、AWS Bedrock AgentCore | 不自造身份格式，直接兼容 Agent Card。A2A 解决"同步任务委派"，**持久化数据交换层是空位** |
| Moltbook | Agent 社交网络，200 万+ 注册 Agent，2026-03 被 Meta 收购；被 Wiz 查出数据库未鉴权可访问，prompt injection 风险普遍 | 证明"Agent 间公共空间"有病毒式需求；也证明纯社交无护城河、安全是致命伤。**自部署 + 点对点是反面差异化** |
| Agent 支付 | AP2（Google + Coinbase，60+ 支付伙伴）+ x402（HTTP 402 稳定币微支付，Linux Foundation x402 基金会）；AWS Bedrock 已内置 | Agent 间"有偿交换"的轨道已铺好，但对个人产品是远期选项 |
| Skill 生态 | ClawHub 44,000+ skills；安全审计显示仅约 47% 安全，800+ 恶意 skill，93% 发布者未验证身份（ClawHavoc 供应链攻击） | **分发不缺，缺可信的分发**。"从认识的人的 Drive 订阅、带版本历史和签名"是不同的信任模型 |
| 记忆服务 | Mem0 / Zep 已是独立赛道，核心卖点即"跨 session 持久上下文" | 记忆是 Agent 每天要用的东西——最强的留存驱动力。本项目 scope 系统已预留 `read:memory` / `write:memory` |
| AgentMail | 给每个 Agent 一个邮箱，主打异步、跨信任边界的 Agent 通信，已有规模化生产客户 | 验证"收件箱"是 Agent 间通信的正确原语：异步、有留痕、不要求双方同时在线 |
| 身份/发现 | NANDA（MIT，DNS for agents）、ERC-8004（链上身份注册）等仍早期；研究显示"身份注册了但经济闭环未形成" | 去中心化注册层未定局，先做点对点握手即可，不押注某个注册中心 |

主要来源：

- A2A：<https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year>
- Moltbook：<https://en.wikipedia.org/wiki/Moltbook>、<https://www.cnn.com/2026/02/03/tech/moltbook-explainer-scli-intl>
- AP2 / x402：<https://agentpaymentsprotocol.info/docs/introduction/>
- ClawHub 安全数据：<https://www.gradually.ai/en/openclaw-statistics/>
- 记忆服务：<https://mem0.ai/>、<https://vectorize.io/articles/mem0-vs-zep>
- AgentMail：<https://www.agentmail.to/>
- NANDA：<https://nanda.nexartis.com/docs/nanda>；ERC-8004：<https://arxiv.org/html/2606.12128v1>

## 3. 驱动力框架

每个功能必须回答"驱动力是什么"。按三层评估：

1. **单人价值（Day 1 有用）**：不依赖其他人，自己的 Agent 就离不开。
   → 记忆、跨设备同步、持久存储。留存的根（Dropbox 也是先做单人网盘）。
2. **双人价值（用一次就懂）**：我和一个朋友之间的交换变丝滑。
   → 现有分享链接已做到"收方零门槛"（guide endpoint），缺"发方零摩擦"。
3. **网络价值（越多人越有用）**：订阅、发现、声誉。
   → "平台"的部分，必须建立在前两层之上，否则是没有 utility 的 Moltbook。

## 4. 功能提案（按落地顺序）

### 4.1 Agent 身份 + Drive 互联（Peering）

- 每个 Drive 实例暴露一张 Agent Card。OAuth discovery 已在
  `/api/public/.well-known/*` 下，新增 `agent.json` 顺理成章。
  内容：名字、公钥、收件端点、能力声明。格式兼容 A2A Agent Card。
- 增加"联系人"概念：两个 Drive 一次握手后互相信任（类似加好友），
  之后 `adrive send bob /report.pdf` 一条命令直达对方 Drive。
- 现有 share + 交接消息保留，作为面向"没有 Drive 的陌生 Agent"的降级路径。

**驱动力**：省掉人肉复制粘贴；交接消息末尾附"部署你自己的 Drive 即可直接收件"，
形成增长飞轮。

### 4.2 收件箱（Inbox）+ 隔离区

- 对方 Agent `POST` 到本 Drive 的 inbox 端点，文件先落 `/inbox/pending/`
  （隔离区），owner 或其 Agent 按策略放行（白名单联系人自动放行）。
- 附带结构化消息（如"这是你要的数据集，schema 在 README"），
  webhook 通知收方 Agent（webhook 基础设施已存在）。

**驱动力**：异步交换的完整闭环。隔离区直接回应 Moltbook / ClawHub 暴露的
prompt injection 风险——外来内容默认不可信，是相对"公共广场"类产品的信任卖点。

### 4.3 记忆层（Memory）

- 文件之外增加结构化笔记 / 键值记忆 + 全文检索端点（D1 FTS5 足够），
  MCP 工具 `remember` / `recall`。
- Agent 每次 session 结束写结论，下次开工先查——云盘从"偶尔传文件"
  变成"每天要碰的 Agent 外脑"。

**驱动力**：使用频率从每周一次变成每天 N 次。`read:memory` / `write:memory`
scope 已在 CLI scope 白名单中预留，路径是通的。

### 4.4 订阅式 Bundle 发布

- 现有 bundle 版本机制（`/api/public/v1/bundles/*`，versionId / history /
  manifest）已是半个发布系统。增加"公开发布"开关：bundle 变成可订阅 URL，
  其他 Drive `adrive subscribe` 后自动拉更新。
- 用途：分发 skill、prompt 库、领域知识包、数据集。

**驱动力**：内容本身。ClawHub 的教训是集中式市场垃圾泛滥、信任崩坏；
"从具体的人的 Drive 订阅、有签名和版本历史"更适合小圈子高信任场景。

### 4.5 共享工作区（远期）

- 把只读 share 升级为"作用域内可读写"的工作区：一个子树 + 双方 scoped token
  + 活动流。path-scope token 与 bundle 乐观并发机制均可复用
  （`docs/audits/product-audit-2026-06-30.md` 的 here.now 对比也指向此方向）。

**驱动力**：两个人的 Agent 围绕真实任务协作（甲方 Agent 放需求、
乙方 Agent 交付迭代）。

### 4.6 付费交换（观察，暂不做）

- x402 风格的"付费下载 share"技术上不难，但当前阶段是伪需求，
  等网络起来再评估。

## 5. 定位一句话

从 "Agent-native 云盘" 演进为 **"个人 Agent 之间的点对点信息交换层"**——
像 Email 之于人：自部署、异步、有留痕、信任基于关系而不是平台。
A2A 管"Agent 实时对话"，本产品管"Agent 之间持久的东西"
（文件、记忆、知识、技能），互补而非竞争。

## 6. 风险提示

- **安全是生死线**：外来内容一律隔离 + 标注来源，manifest 签名验证。
  Moltbook 上线一周即被打穿的例子说明目标用户（尤其技术用户）对安全极其敏感；
  做好了反而是卖点。
- **别自造协议**：身份用 A2A Agent Card 格式，支付留 x402 接口位，
  最大化生态兼容。
- **顺序不能反**：先把单人价值（记忆）和双人价值（互联收件）做扎实，
  再谈网络功能。
