<p align="center">
  <img src="docs/banner.png" alt="Agent Drive Banner" width="100%" />
</p>

<h3 align="center">Agent-native Private Cloud Drive</h3>

<p align="center">
  Let your AI agents upload files, manage folders, and share with other agents via API.<br/>
  Built on <a href="https://edgespark.dev">EdgeSpark</a> (Cloudflare Workers + D1 + R2).
</p>

---

## What is Agent Drive?

Agent Drive is a private cloud drive designed for AI agents. Your agent uploads files, organizes them into folders, creates password-protected share links, and other agents download everything via API — no browser needed.

<p align="center">
  <img src="docs/diagram.png" alt="Architecture Diagram" width="700" />
</p>

### Key Features

- **File management** — Upload, list, rename, move, delete files and folders via REST API
- **Share links** — Password-protected, with download limits and expiration
- **ZIP download** — Agents download entire folders as ZIP, or pick individual files
- **Web dashboard** — Human-friendly file browser, upload zone, share management
- **Agent guide endpoint** — Receiving agents read `/api/public/guide` to learn the API automatically
- **One-click deploy** — Skill-guided setup on EdgeSpark, minimal manual steps

### How It Works

```
Your Agent                     Agent Drive                    Other Agent
    |                              |                              |
    |-- upload files ------------->|                              |
    |-- create share link -------->|                              |
    |<-- share URL + password -----|                              |
    |                              |                              |
    |  (you send the link to the other agent)                     |
    |                              |                              |
    |                              |<-- read guide --------------|
    |                              |<-- get access token ---------|
    |                              |<-- download ZIP -------------|
```

## Quick Start

### Option A: Use the Skill (Recommended)

Install the `agent-drive` skill in your Claude Code (or any agent that supports skills), then ask your agent:

> "Set up Agent Drive for me"

The skill walks through the entire deployment process. See [`skill/SKILL.md`](skill/SKILL.md) for details.

### Option B: Manual Setup

```bash
# Clone
git clone https://github.com/Yrzhe/agent-drive.git
cd agent-drive

# Initialize EdgeSpark project
edgespark init agent-drive

# Install dependencies
cd server && npm install && cd ../web && npm install && cd ..

# Set up database, storage, and deploy
edgespark db generate
edgespark db migrate
edgespark storage apply
edgespark secret set AGENT_TOKEN   # Enter token in browser
edgespark deploy
```

See [`skill/references/setup.md`](skill/references/setup.md) for the full guide.

## Usage

### Upload a File

```bash
TOKEN=$(grep AGENT_TOKEN .env | cut -d= -f2-)

# Request upload URL
curl -X POST https://your-drive.edgespark.app/api/public/v1/files/upload \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"filename":"report.pdf","contentType":"application/pdf","size":12345,"path":"/"}'

# Upload to the returned presigned URL
curl -X PUT "{uploadUrl}" -H "Content-Type: application/pdf" --data-binary @report.pdf

# Confirm upload
curl -X POST https://your-drive.edgespark.app/api/public/v1/files/upload/complete \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"fileId":"{fileId}","filename":"report.pdf","path":"/"}'
```

### Create a Share Link

```bash
curl -X POST https://your-drive.edgespark.app/api/public/v1/shares \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"fileId":"{fileId}","password":"s3cret","maxDownloads":10,"expiresIn":86400}'
```

### Share with Another Agent

After creating a share, send this to the receiving agent:

```
Please download the shared content from my Agent Drive:

  📖 Guide: https://your-drive.edgespark.app/api/public/guide
  🔗 Share: https://your-drive.edgespark.app/s/xK9mPq2n
  🔑 Password: s3cret
  ⏰ Expires: 2026-04-11T10:00:00Z
  📥 Max downloads: 10

The receiving agent should read the Guide URL first to learn the download API,
then use the Share URL to access the files.
```

### Download as Receiving Agent

```bash
# Get access token
TOKEN=$(curl -s -X POST https://their-drive.edgespark.app/api/public/s/xK9mPq2n/access \
  -H "Content-Type: application/json" \
  -d '{"password":"s3cret"}' | jq -r '.accessToken')

# Download entire share as ZIP
curl -o files.zip https://their-drive.edgespark.app/api/public/s/xK9mPq2n/download-zip \
  -H "X-Access-Token: $TOKEN"
```

## Project Structure

```
agent-drive/
├── server/                 # Hono API on Cloudflare Workers
│   └── src/
│       ├── routes/         # File, folder, share, guide endpoints
│       ├── middleware/      # Dual auth (session + bearer token)
│       ├── lib/            # Crypto, paths, file helpers
│       └── defs/           # DB schema, storage, runtime config
├── web/                    # React SPA via Vite
│   └── src/
│       ├── pages/          # Dashboard, ShareDownload, Guide
│       ├── components/     # FileTable, UploadZone, ShareModal
│       └── lib/            # API client, auth hooks
├── skill/                  # Agent Drive skill for AI agents
│   ├── SKILL.md            # Skill entry point
│   └── references/         # Detailed guides per module
├── configs/                # Auth configuration
└── edgespark.toml          # EdgeSpark project config
```

## API Reference

### Management (requires `Authorization: Bearer {TOKEN}`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/public/v1/files/upload` | Request presigned upload URL |
| POST | `/api/public/v1/files/upload/complete` | Confirm upload |
| GET | `/api/public/v1/files?path=/` | List files |
| POST | `/api/public/v1/folders` | Create folder |
| PATCH | `/api/public/v1/files/:id` | Rename / move |
| DELETE | `/api/public/v1/files/:id` | Delete |
| POST | `/api/public/v1/shares` | Create share |
| GET | `/api/public/v1/shares` | List active shares |
| DELETE | `/api/public/v1/shares/:id` | Delete share |
| GET | `/api/public/v1/stats` | Storage stats |

### Public (no auth)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/public/guide` | API guide for receiving agents |
| GET | `/api/public/s/:id` | Share info |
| POST | `/api/public/s/:id/access` | Get access token |
| GET | `/api/public/s/:id/files` | Browse shared files |
| GET | `/api/public/s/:id/download` | Download single file |
| GET | `/api/public/s/:id/download-zip` | Download folder as ZIP |

Full API docs: [`skill/references/api-reference.md`](skill/references/api-reference.md)

## Tech Stack

- **Runtime**: Cloudflare Workers (via [EdgeSpark](https://edgespark.dev))
- **API**: [Hono](https://hono.dev)
- **Database**: Cloudflare D1 (SQLite) + [Drizzle ORM](https://orm.drizzle.team)
- **Storage**: Cloudflare R2 (S3-compatible)
- **Frontend**: React + Vite + Tailwind CSS
- **Auth**: EdgeSpark built-in (email/password)
- **ZIP**: [fflate](https://github.com/101arrowz/fflate) (in-Worker ZIP creation)

## License

MIT

---

# 中文说明

## Agent Drive 是什么？

Agent Drive 是一个专为 AI Agent 设计的私有云盘。你的 Agent 通过 API 上传文件、管理文件夹、创建分享链接，其他 Agent 通过 API 直接下载 —— 完全不需要浏览器。

### 核心能力

- **文件管理** — 上传、列表、重命名、移动、删除文件和文件夹
- **分享链接** — 支持密码保护、下载次数限制、过期时间
- **ZIP 下载** — Agent 可以直接下载整个文件夹为 ZIP，或单独下载某个文件
- **Web 管理面板** — 人类也可以通过浏览器管理文件
- **Agent 指南接口** — 接收方 Agent 读 `/api/public/guide` 自动学会下载 API

### 使用场景

1. 你让 Agent 上传一个文件
2. Agent 创建分享链接（可设密码、过期时间、下载次数）
3. Agent 返回一段标准化的交接信息给你
4. 你把这段信息发给对方的 Agent
5. 对方 Agent 读 guide、获取 token、下载 ZIP —— 全自动

### 快速开始

安装 `agent-drive` skill 到你的 Claude Code，然后对 Agent 说：

> "帮我部署 Agent Drive"

Agent 会引导你完成所有步骤。详见 [`skill/SKILL.md`](skill/SKILL.md)。

### 分享时的标准交接消息

每次创建分享后，Agent 会返回这样的信息，你直接复制给对方：

```
Please download the shared content from my Agent Drive:

  📖 Guide: https://your-drive.edgespark.app/api/public/guide
  🔗 Share: https://your-drive.edgespark.app/s/xK9mPq2n
  🔑 Password: demo2024
  ⏰ Expires: 2026-04-11T10:00:00Z
  📥 Max downloads: 10

The receiving agent should read the Guide URL first to learn the download API,
then use the Share URL to access the files.
```
