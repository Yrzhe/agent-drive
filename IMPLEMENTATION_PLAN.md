# Agent Drive — 详细设计文档

## 定位

Agent-native 的私有云盘。让你的 Agent 能通过 API 上传文件、管理文件夹、生成分享链接、发给其他 Agent 或人类。

**不是**多用户 SaaS，而是每个人部署自己的实例，给自己的 Agent 用。

## 产品愿景（两步走）

1. **Phase 0 — 自用版**：为自己的 Agent 构建完整的云盘能力
2. **Phase 1 — 模板 + Skill**：打包成 EdgeSpark 模板 + Skill，别人一键部署自己的 Agent Drive

---

## 架构总览

```
┌──────────────┐   ┌──────────────┐
│  人类 (Web)   │   │  Agent (API)  │
│  拖拽上传      │   │  Bearer Token │
│  文件管理      │   │  curl / SDK   │
└──────┬───────┘   └──────┬───────┘
       │                   │
       │   EdgeSpark Auth  │   Authorization: Bearer <TOKEN>
       │   (session cookie)│
       ▼                   ▼
┌─────────────────────────────────────┐
│         Hono API (Workers)           │
│                                      │
│  /api/public/v1/*  ← 双重鉴权中间件  │
│    (session OR bearer token)         │
│                                      │
│  /api/public/s/*   ← 公开端点        │
│    (分享链接、下载、guide)            │
└──────────┬──────────┬───────────────┘
           │          │
          D1         R2
       (元数据)     (文件)
```

## 鉴权设计

### 双重鉴权模型

所有管理类 API 放在 `/api/public/v1/*`（EdgeSpark 的 public 路径不强制登录，但会注入 session 信息），通过自定义中间件实现双重鉴权：

```
请求进入 /api/public/v1/*
    │
    ├─ auth.user 存在？ → 通过（Web 登录用户）
    │
    ├─ Authorization: Bearer <token> 匹配 AGENT_TOKEN？ → 通过（Agent）
    │
    └─ 都没有 → 401 Unauthorized
```

**为什么用 `/api/public/v1/*` 而不是 `/api/v1/*`？**
- `/api/*` 路径 EdgeSpark 强制要求 session，Agent 用 bearer token 访问会被拦截
- `/api/public/*` 允许可选登录，我们在上层加自定义鉴权，同时兼容两种方式

### Token 管理

- `AGENT_TOKEN` 通过 `edgespark secret set` 配置（值不经过 LLM）
- Web 登录使用 EdgeSpark 内置的 email/password auth
- 部署时 owner 注册一个账号即可，无需多用户

### 公开端点

`/api/public/s/*` 完全公开，用于：
- 查看分享信息
- 验证密码
- 获取下载链接

---

## 数据模型

### files 表

```sql
CREATE TABLE files (
  id            TEXT PRIMARY KEY,         -- nanoid (21 chars)
  name          TEXT NOT NULL,            -- 文件名或文件夹名
  path          TEXT NOT NULL UNIQUE,     -- 完整路径 "/docs/readme.md"
  parent_path   TEXT NOT NULL DEFAULT '/',-- 父路径 "/docs"（索引，用于列表查询）
  is_folder     INTEGER NOT NULL DEFAULT 0, -- 1=文件夹, 0=文件
  size          INTEGER NOT NULL DEFAULT 0, -- 文件大小 bytes（文件夹=0）
  content_type  TEXT,                     -- MIME type（文件夹=NULL）
  s3_uri        TEXT,                     -- R2 存储路径（文件夹=NULL）
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 索引
CREATE INDEX idx_files_parent_path ON files(parent_path);
CREATE INDEX idx_files_is_folder ON files(is_folder);
```

**设计决策：**
- 文件夹是一等公民（有自己的 D1 记录），支持空文件夹、文件夹重命名
- `path` 是唯一的，防止同路径重复
- `parent_path` 建索引，支持高效的文件夹内容查询
- 不设 `expires_at`——这是云盘，手动删除

### shares 表

```sql
CREATE TABLE shares (
  id              TEXT PRIMARY KEY,       -- 短 code (8 chars nanoid)
  file_id         TEXT,                   -- 单文件分享 → files.id
  folder_path     TEXT,                   -- 文件夹分享 → files.path
  password_hash   TEXT,                   -- SHA-256 hash（NULL=无密码）
  max_downloads   INTEGER,               -- NULL=无限制
  download_count  INTEGER NOT NULL DEFAULT 0,
  expires_at      TEXT,                   -- 链接过期时间（NULL=永不过期）
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);

-- 约束：file_id 和 folder_path 二选一
-- 应用层检查：NOT (file_id IS NOT NULL AND folder_path IS NOT NULL)

CREATE INDEX idx_shares_file_id ON shares(file_id);
CREATE INDEX idx_shares_folder_path ON shares(folder_path);
```

**设计决策：**
- `file_id` 和 `folder_path` 二选一：单文件分享用 `file_id`，文件夹分享用 `folder_path`
- `password_hash` 用 SHA-256（Workers 原生 `crypto.subtle` 支持，无需第三方库）
- `expires_at` 是分享链接的过期，不是文件的过期（文件永不自动过期）
- `ON DELETE CASCADE`：文件删除时自动清理关联的分享
- share ID 用 8 字符 nanoid，URL 友好且足够唯一

### Drizzle Schema 定义

```typescript
// server/src/defs/db_schema.ts

import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

export const files = sqliteTable("files", {
  id:          text("id").primaryKey(),
  name:        text("name").notNull(),
  path:        text("path").notNull().unique(),
  parentPath:  text("parent_path").notNull().default("/"),
  isFolder:    integer("is_folder").notNull().default(0),
  size:        integer("size").notNull().default(0),
  contentType: text("content_type"),
  s3Uri:       text("s3_uri"),
  createdAt:   text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt:   text("updated_at").notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index("idx_files_parent_path").on(table.parentPath),
]);

export const shares = sqliteTable("shares", {
  id:            text("id").primaryKey(),
  fileId:        text("file_id").references(() => files.id, { onDelete: "cascade" }),
  folderPath:    text("folder_path"),
  passwordHash:  text("password_hash"),
  maxDownloads:  integer("max_downloads"),
  downloadCount: integer("download_count").notNull().default(0),
  expiresAt:     text("expires_at"),
  createdAt:     text("created_at").notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index("idx_shares_file_id").on(table.fileId),
  index("idx_shares_folder_path").on(table.folderPath),
]);
```

### Storage Schema

```typescript
// server/src/defs/storage_schema.ts

import type { BucketDef } from "@sdk/server-types";

export const drive: BucketDef<"drive"> = {
  bucket_name: "drive",
  description: "Agent Drive file storage",
};
```

### Runtime Keys

```typescript
// server/src/defs/runtime.ts

export type VarKey = never;

export type SecretKey =
  | "AGENT_TOKEN";  // Bearer token for agent API access
```

---

## API 设计

### 管理端点 — `/api/public/v1/*`

> 所有管理端点均需通过双重鉴权中间件（session OR bearer token）

#### 文件操作

```
POST   /api/public/v1/files/upload
       请求 presigned PUT URL
       Body: { filename: string, contentType: string, size: number, path?: string }
       - path 默认 "/"，示例 "/projects/demo"
       - 自动创建父文件夹（如不存在）
       返回: {
         fileId: string,
         uploadUrl: string,
         requiredHeaders: Record<string, string>,
         expiresAt: string
       }

POST   /api/public/v1/files/upload/complete
       确认上传完成，创建 D1 记录
       Body: { fileId: string }
       - 服务端通过 storage.head() 验证文件已到达 R2
       - 从 R2 元数据读取实际 size 和 contentType
       返回: { file: FileObject }

GET    /api/public/v1/files
       列出指定路径下的文件和文件夹
       Query: ?path=/docs&recursive=false
       - path 默认 "/"
       - recursive=true 返回所有子文件（扁平列表）
       返回: {
         files: FileObject[],
         path: string
       }

GET    /api/public/v1/files/:id
       获取单个文件/文件夹详情
       返回: { file: FileObject }

PATCH  /api/public/v1/files/:id
       重命名或移动文件/文件夹
       Body: { name?: string, parentPath?: string }
       - 重命名：更新 name + path
       - 移动：更新 parentPath + path
       - 如果是文件夹，级联更新所有子项的 path 和 parentPath
       返回: { file: FileObject }

DELETE /api/public/v1/files/:id
       删除文件或文件夹
       - 文件：删除 D1 记录 + R2 对象
       - 文件夹：递归删除所有子项 + R2 对象
       - 关联 shares 通过 CASCADE 自动清理
       返回: { deleted: number }  (删除的文件数)
```

#### 文件夹操作

```
POST   /api/public/v1/folders
       创建文件夹
       Body: { name: string, path?: string }
       - path 是父路径，默认 "/"
       - 自动创建父文件夹（如不存在）
       返回: { folder: FileObject }
```

#### 分享操作

```
POST   /api/public/v1/shares
       创建分享链接
       Body: {
         fileId?: string,        // 单文件分享
         folderPath?: string,    // 文件夹分享（二选一）
         password?: string,      // 可选密码（明文传入，服务端 hash）
         maxDownloads?: number,  // 最大下载次数
         expiresIn?: number      // 过期秒数（NULL=永不过期）
       }
       返回: {
         share: ShareObject,
         shareUrl: string,       // 完整分享 URL
         guideUrl: string        // guide 页面 URL
       }

GET    /api/public/v1/shares
       列出所有分享链接
       返回: { shares: ShareObject[] }

GET    /api/public/v1/shares/:id
       获取分享详情（含统计）
       返回: { share: ShareObject }

DELETE /api/public/v1/shares/:id
       删除分享链接
       返回: { success: true }
```

#### 统计

```
GET    /api/public/v1/stats
       获取云盘使用统计
       返回: {
         totalFiles: number,
         totalFolders: number,
         totalSize: number,      // bytes
         totalShares: number,
         totalDownloads: number
       }
```

### 公开端点 — `/api/public/s/*`

> 完全公开，无需任何鉴权

```
GET    /api/public/s/:shareId
       获取分享信息（不含敏感内容）
       返回: {
         id: string,
         type: "file" | "folder",
         name: string,             // 文件名或文件夹名
         size: number,             // 总大小
         fileCount: number,        // 文件数（文件夹分享时）
         hasPassword: boolean,
         maxDownloads: number | null,
         downloadCount: number,
         expiresAt: string | null,
         expired: boolean,
         exhausted: boolean,       // download_count >= max_downloads
         createdAt: string
       }

POST   /api/public/s/:shareId/access
       验证密码并获取访问令牌
       Body: { password?: string }
       - 无密码的分享：password 可省略
       - 有密码的分享：验证 SHA-256(password) === password_hash
       - 检查是否过期、是否超过下载次数
       返回: {
         accessToken: string,      // 临时令牌（HMAC签名，含 shareId + 时间戳，15分钟有效）
         expiresAt: string
       }
       错误: 403 密码错误, 410 已过期, 429 下载次数已用完

GET    /api/public/s/:shareId/files
       列出分享中的文件（文件夹分享时）
       Header: X-Access-Token: <accessToken>
       返回: { files: PublicFileObject[] }

GET    /api/public/s/:shareId/download
       获取 presigned 下载 URL
       Header: X-Access-Token: <accessToken>
       Query: ?fileId=xxx (文件夹分享时指定要下载的文件)
       - 验证 accessToken 有效性
       - 递增 download_count
       - 生成 presigned GET URL（1小时有效）
       返回: {
         downloadUrl: string,
         filename: string,
         size: number,
         expiresAt: string
       }
```

### Guide 端点

```
GET    /api/public/guide
       返回 Agent 使用指南（JSON 格式）
       返回: {
         name: "Agent Drive",
         version: "1.0",
         description: "...",
         howToDownload: {
           step1: "GET /api/public/s/:shareId — 获取分享信息",
           step2: "POST /api/public/s/:shareId/access — 获取访问令牌（如有密码需提供）",
           step3: "GET /api/public/s/:shareId/download — 获取下载链接",
           step4: "GET <downloadUrl> — 下载文件"
         },
         example: { ... }
       }
```

---

## 数据对象类型

```typescript
interface FileObject {
  id: string;
  name: string;
  path: string;
  parentPath: string;
  isFolder: boolean;
  size: number;
  contentType: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ShareObject {
  id: string;
  fileId: string | null;
  folderPath: string | null;
  type: "file" | "folder";
  targetName: string;         // 分享的文件名或文件夹名
  hasPassword: boolean;
  maxDownloads: number | null;
  downloadCount: number;
  expiresAt: string | null;
  createdAt: string;
  shareUrl: string;
}

interface PublicFileObject {
  id: string;
  name: string;
  path: string;               // 相对于分享根目录的路径
  isFolder: boolean;
  size: number;
  contentType: string | null;
}
```

---

## 上传流程详解

### Agent 上传流程

```
Agent                          API                           R2
  │                             │                             │
  ├─ POST /v1/files/upload ────►│                             │
  │  { filename, contentType,   │                             │
  │    size, path }             │── createPresignedPutUrl() ──►│
  │                             │◄── { uploadUrl, headers } ──│
  │◄─ { fileId, uploadUrl,      │                             │
  │    requiredHeaders } ───────│                             │
  │                             │                             │
  ├─ PUT uploadUrl ─────────────┼────────────────────────────►│
  │  (直接上传到 R2)             │                             │
  │◄─ 200 OK ──────────────────┼─────────────────────────────│
  │                             │                             │
  ├─ POST /v1/files/upload/     │                             │
  │  complete { fileId } ──────►│── head() 验证文件存在 ──────►│
  │                             │◄── metadata ────────────────│
  │                             │── INSERT files (D1) ────────│
  │◄─ { file } ────────────────│                             │
```

### Web 拖拽上传流程

同样的 API，前端封装为：
1. 用户拖拽文件到页面
2. JS 调用 `/v1/files/upload` 获取 presigned URL
3. JS 直接 PUT 到 R2（显示进度条）
4. 完成后调用 `/v1/files/upload/complete`
5. UI 刷新文件列表

---

## 分享与下载流程详解

### 发送方 Agent 的流程

```
1. 上传文件
2. POST /v1/shares { fileId, password: "abc123", maxDownloads: 5 }
3. 收到 { shareUrl, guideUrl }
4. 返回给用户：
   ---
   文件已上传并生成分享链接。
   请将以下信息发给接收方的 Agent：

   📖 使用指南: https://your-drive.example.com/api/public/guide
   🔗 分享链接: https://your-drive.example.com/s/abc12345
   🔑 密码: abc123
   ---
```

### 接收方 Agent 的流程

```
1. 先访问 guide URL，学习如何使用 API
2. GET /api/public/s/abc12345 → 了解分享信息（需要密码）
3. POST /api/public/s/abc12345/access { password: "abc123" } → 获取 accessToken
4. GET /api/public/s/abc12345/download (Header: X-Access-Token: ...) → 获取 downloadUrl
5. GET downloadUrl → 下载文件
```

---

## Access Token 设计

分享下载使用临时 access token（不是 Agent bearer token），防止链接被无限次传播：

```typescript
// 生成
const payload = `${shareId}:${Date.now()}`;
const signature = await hmacSHA256(payload, AGENT_TOKEN);
const token = btoa(`${payload}:${signature}`);

// 验证
const [shareId, timestamp, signature] = atob(token).split(":");
// 1. 验证签名
// 2. 验证 shareId 匹配
// 3. 验证未超过 15 分钟
```

用 `AGENT_TOKEN` 作为 HMAC 密钥，无需额外 secret。

---

## 前端页面

### 1. 管理页面（`/` — 需登录）

```
┌─────────────────────────────────────────┐
│  Agent Drive           [stats] [logout]  │
├─────────────────────────────────────────┤
│  / > docs >                              │
│                                          │
│  📁 projects/          2 files   —       │
│  📁 skills/            5 files   —       │
│  📄 readme.md          4.2 KB    [⤴][🗑] │
│  📄 config.json        1.1 KB    [⤴][🗑] │
│                                          │
│  ┌─────────────────────────────────┐     │
│  │  拖拽文件到此处上传              │     │
│  │  或点击选择文件                  │     │
│  └─────────────────────────────────┘     │
│                                          │
│  ── 分享链接 ──                          │
│  abc12345  readme.md   🔒  3/5 下载      │
│  def67890  projects/   🔓  12 下载       │
└─────────────────────────────────────────┘
```

- 面包屑导航（路径）
- 文件列表（名称、大小、操作按钮）
- 右键/按钮：重命名、移动、分享、删除
- 拖拽上传区域
- 底部分享链接列表

### 2. 下载页面（`/s/:shareId` — 公开）

```
┌─────────────────────────────────────────┐
│          Agent Drive                     │
│                                          │
│          📄 readme.md                    │
│          4.2 KB                          │
│                                          │
│     ┌─────────────────────────┐          │
│     │ 请输入密码              │          │
│     │ [••••••••] [确认]       │          │
│     └─────────────────────────┘          │
│                                          │
│          [ ⬇ 下载文件 ]                  │
│                                          │
│          已下载 3/5 次                    │
└─────────────────────────────────────────┘
```

### 3. Guide 页面（`/guide` — 公开）

纯文本/Markdown 页面，面向 Agent，说明如何通过 API 下载分享的文件。

---

## R2 存储路径规范

```
drive/                          ← R2 bucket
  {fileId}/{originalFilename}   ← 实际文件
```

示例：
```
drive/V1StGXR8_Z5jdHi6B-myT/readme.md
drive/Uakgb_J5m9g-0JDMbcJqLJ/report.pdf
```

用 `fileId` 作为前缀而非用户路径，避免重命名/移动时需要同步 R2 路径。D1 的 `path` 字段管理逻辑路径，R2 只管物理存储。

---

## 错误码设计

```typescript
// 标准响应格式
interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

// 错误码
const ErrorCodes = {
  // 鉴权
  UNAUTHORIZED:        "unauthorized",           // 401
  INVALID_TOKEN:       "invalid_token",          // 401

  // 文件
  FILE_NOT_FOUND:      "file_not_found",         // 404
  PATH_CONFLICT:       "path_conflict",          // 409 (路径已存在)
  UPLOAD_NOT_FOUND:    "upload_not_found",        // 404 (R2 中找不到上传的文件)

  // 分享
  SHARE_NOT_FOUND:     "share_not_found",        // 404
  SHARE_EXPIRED:       "share_expired",          // 410
  SHARE_EXHAUSTED:     "share_exhausted",        // 429 (下载次数用完)
  WRONG_PASSWORD:      "wrong_password",         // 403
  INVALID_ACCESS_TOKEN:"invalid_access_token",   // 401

  // 通用
  VALIDATION_ERROR:    "validation_error",       // 400
  INTERNAL_ERROR:      "internal_error",         // 500
};
```

---

## 实现阶段

### Stage 1：基础设施
**Goal**: D1 表 + R2 bucket + secret 就绪
**Files**:
- `server/src/defs/db_schema.ts`
- `server/src/defs/storage_schema.ts`
- `server/src/defs/runtime.ts`
**Commands**: `edgespark db generate` → `edgespark db migrate` → `edgespark storage apply` → `edgespark secret set`
**Status**: Not Started

### Stage 2：鉴权中间件 + 文件 CRUD API
**Goal**: 双重鉴权中间件，文件上传/列表/重命名/删除
**Files**:
- `server/src/index.ts`
**验证**: curl 完成上传→列表→重命名→删除
**Status**: Not Started

### Stage 3：文件夹 + 分享 API
**Goal**: 文件夹 CRUD，分享链接创建/列表/删除
**Files**:
- `server/src/index.ts`
**验证**: curl 创建文件夹、分享文件、分享文件夹
**Status**: Not Started

### Stage 4：公开下载端点
**Goal**: 分享信息查看、密码验证、access token、presigned 下载
**Files**:
- `server/src/index.ts`
**验证**: curl 完成 查看分享→验证密码→获取下载链接→下载 全流程
**Status**: Not Started

### Stage 5：Guide 端点
**Goal**: Agent 使用指南 API
**Files**:
- `server/src/index.ts`
**Status**: Not Started

### Stage 6：前端 — 管理界面
**Goal**: 登录、文件列表、拖拽上传、文件夹管理、分享管理
**Files**:
- `web/src/App.tsx`
- `web/src/pages/Dashboard.tsx`
- `web/src/components/*`
**Status**: Not Started

### Stage 7：前端 — 下载页 + Guide 页
**Goal**: 公开下载页面、Agent Guide 页面
**Files**:
- `web/src/pages/ShareDownload.tsx`
- `web/src/pages/Guide.tsx`
**Status**: Not Started

### Stage 8：部署 + 端到端测试
**Goal**: 完整部署到 EdgeSpark，线上全流程验证
**Commands**: `edgespark deploy`
**Status**: Not Started

---

## Phase 1：模板 + Skill（自用版完成后）

### EdgeSpark 模板
将代码整理为可复用模板，`edgespark init` 时可选。

### Skill 文件
三部分内容：
1. **安装引导**：教 Agent 帮用户部署自己的 Agent Drive
2. **发送指南**：教 Agent 如何上传文件并创建分享链接
3. **接收指南**：教接收方 Agent 如何通过 API 下载文件

### 自举分发
用 Agent Drive 本身分发 Skill 文件 → 对方 Agent 下载 Skill → 引导部署自己的 Agent Drive。
