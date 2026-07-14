import React, { useEffect, useRef, useState } from 'react';
const DOMAIN = 'large-gator-9215.edgespark.app';
const TOOLS: {
  name: string;
  desc: string;
}[] = [{
  name: 'list_files',
  desc: 'Browse any folder'
}, {
  name: 'read_file',
  desc: 'Fetch file contents'
}, {
  name: 'write_file',
  desc: 'Upload & version'
}, {
  name: 'search_files',
  desc: 'Full-text over the drive'
}, {
  name: 'create_share',
  desc: 'Password + expiry links'
}, {
  name: 'remember',
  desc: 'Persist a memory'
}, {
  name: 'recall',
  desc: 'FTS5 search memory'
}, {
  name: 'list_memories',
  desc: 'Enumerate the brain'
}, {
  name: 'forget',
  desc: 'Drop a memory'
}, {
  name: 'send_file',
  desc: 'Hand off to a peer drive'
}];
const ICON_PATHS: Record<string, string[]> = {
  list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3.5 6h.01', 'M3.5 12h.01', 'M3.5 18h.01'],
  file: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6'],
  upload: ['M12 15V3', 'M7 8l5-5 5 5', 'M5 21h14'],
  search: ['M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0-14 0', 'M21 21l-6-6'],
  link: ['M9 15l6-6', 'M11 7l1-1a4 4 0 0 1 6 6l-1 1', 'M13 17l-1 1a4 4 0 0 1-6-6l1-1'],
  save: ['M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z', 'M17 21v-8H7v8', 'M7 3v5h8'],
  trash: ['M3 6h18', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2', 'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6'],
  send: ['M22 2L11 13', 'M22 2l-7 20-4-9-9-4z'],
  folder: ['M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z'],
  chip: ['M6 6h12v12H6z', 'M9 9h6v6H9z', 'M9 2v2', 'M15 2v2', 'M9 20v2', 'M15 20v2', 'M2 9h2', 'M2 15h2', 'M20 9h2', 'M20 15h2'],
  exchange: ['M7 10l-4 4 4 4', 'M3 14h13', 'M17 14l4-4-4-4', 'M21 10H8']
};
function Ti({
  name,
  size = 15
}: {
  name: string;
  size?: number;
}) {
  const p = ICON_PATHS[name] || [];
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">{p.map((d, i) => <path key={i} d={d} />)}</svg>;
}
const TOOL_GROUPS: {
  label: string;
  icon: string;
  note?: string;
  tools: {
    name: string;
    desc: string;
    icon: string;
  }[];
}[] = [{
  label: 'Files',
  icon: 'folder',
  note: 'REST: /api/public/v1/files/*',
  tools: [{
    name: 'list_files',
    desc: 'Walk any folder tree',
    icon: 'list'
  }, {
    name: 'read_file',
    desc: 'Fetch file contents',
    icon: 'file'
  }, {
    name: 'write_file',
    desc: 'Create or update, versioned',
    icon: 'upload'
  }, {
    name: 'search_files',
    desc: 'Full-text over the drive',
    icon: 'search'
  }, {
    name: 'create_share',
    desc: 'Password + expiry links',
    icon: 'link'
  }]
}, {
  label: 'Memory',
  icon: 'chip',
  note: 'FTS5 · self-healing index',
  tools: [{
    name: 'remember',
    desc: 'Persist a memory · key + tags',
    icon: 'save'
  }, {
    name: 'recall',
    desc: 'Ranked full-text search',
    icon: 'search'
  }, {
    name: 'list_memories',
    desc: 'Enumerate the brain',
    icon: 'list'
  }, {
    name: 'forget',
    desc: 'Drop a memory',
    icon: 'trash'
  }]
}, {
  label: 'Hand-off',
  icon: 'exchange',
  note: 'Ed25519 signed · /inbox quarantine',
  tools: [{
    name: 'send_file',
    desc: 'Signed delivery to a peer drive',
    icon: 'send'
  }]
}];
const TOOL_CALLS: Record<string, {
  req: string;
  resp: string[];
  ms: number;
  scope: string;
}> = {
  list_files: {
    req: '{ "path": "/reports" }',
    resp: ['[', '  { "name": "q3-audit.md", "size": 24576 },', '  { "name": "q2-audit.md", "size": 20132 }', ']'],
    ms: 38,
    scope: 'read:drive'
  },
  read_file: {
    req: '{ "path": "/reports/q3-audit.md" }',
    resp: ['{ "content": "# Q3 Audit\\n…", "bytes": 24576 }'],
    ms: 41,
    scope: 'read:drive'
  },
  write_file: {
    req: '{ "path": "/reports/q3-audit.md", "content": "…" }',
    resp: ['{ "ok": true, "version": 7, "bytes": 24576 }'],
    ms: 84,
    scope: 'write:drive'
  },
  search_files: {
    req: '{ "query": "revenue recognition" }',
    resp: ['[ { "path": "/reports/q3-audit.md", "score": 0.94 } ]'],
    ms: 52,
    scope: 'read:drive'
  },
  create_share: {
    req: '{ "path": "/reports", "password": true, "ttl": "7d" }',
    resp: ['{ "url": "/s/abc12345", "expires": "2026-07-16" }'],
    ms: 66,
    scope: 'share:create'
  },
  remember: {
    req: '{ "key": "q3-conclusions", "content": "…", "tags": ["audit"] }',
    resp: ['{ "ok": true, "id": "mem_4f2a" }'],
    ms: 40,
    scope: 'write:memory'
  },
  recall: {
    req: '{ "query": "what shipped in q3?" }',
    resp: ['[ { "key": "q3-conclusions", "score": 0.91 } ]'],
    ms: 37,
    scope: 'read:memory'
  },
  list_memories: {
    req: '{ "tag": "audit" }',
    resp: ['[ { "key": "q3-conclusions" }, { "key": "q2-notes" } ]'],
    ms: 33,
    scope: 'read:memory'
  },
  forget: {
    req: '{ "key": "q2-notes" }',
    resp: ['{ "ok": true, "removed": 1 }'],
    ms: 29,
    scope: 'write:memory'
  },
  send_file: {
    req: '{ "to": "peer.drive", "path": "/reports/q3-audit.md" }',
    resp: ['{ "ok": true, "signed": true, "status": "delivered" }'],
    ms: 128,
    scope: 'share:create'
  }
};
const SNIPPETS: Record<string, string> = {
  'Claude Code': `claude mcp add agent-drive \\\n  --url https://${DOMAIN}/api/public/mcp \\\n  --transport http`,
  Cursor: `{\n  "mcpServers": {\n    "agent-drive": {\n      "url": "https://${DOMAIN}/api/public/mcp",\n      "type": "http"\n    }\n  }\n}`,
  Codex: `codex mcp add agent-drive \\\n  --url https://${DOMAIN}/api/public/mcp\ncodex mcp login agent-drive`
};
const mono = {
  fontFamily: 'var(--font-mono)'
} as React.CSSProperties;
const heading = {
  fontFamily: 'var(--font-heading)'
} as React.CSSProperties;
const prefersReduce = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------------- i18n (zh + en) — prose only; tool names, JSON, endpoints, snippets stay literal ---------------- */
type Lang = 'en' | 'zh';
type HeadWord = {
  w: string;
  acc?: boolean;
};
type Strings = typeof STRINGS['en'];
const STRINGS = {
  en: {
    nav: [['Tools', '#tools'], ['Capabilities', '#capabilities'], ['Identity', '#identity']] as [string, string][],
    hero: {
      eyebrow: 'Agent-native private cloud drive',
      head: [[{
        w: 'The'
      }, {
        w: 'drive'
      }, {
        w: 'your'
      }, {
        w: 'agents'
      }], [{
        w: 'hand',
        acc: true
      }, {
        w: 'off',
        acc: true
      }, {
        w: 'through.'
      }]] as HeadWord[][],
      sub: 'Files, memory, and signed hand-offs passed agent‑to‑agent — served over MCP and REST. No signup, no eyes but theirs.',
      cta1: 'Connect an agent'
    },
    tools: {
      eyebrow: 'The interface',
      h2: 'Ten tools. One endpoint.',
      body: 'Every capability is an MCP tool and a matching REST route, guarded by the same scopes. An agent lists them once and gets to work — the same surface a human would click through, minus the clicking.',
      chips: ['10 tools', '1 endpoint', 'JSON-RPC 2.0', 'REST mirror', 'OAuth 2.1 scopes'],
      groups: {
        Files: 'Files',
        Memory: 'Memory',
        'Hand-off': 'Hand-off'
      } as Record<string, string>,
      desc: {
        list_files: 'Walk any folder tree',
        read_file: 'Fetch file contents',
        write_file: 'Create or update, versioned',
        search_files: 'Full-text over the drive',
        create_share: 'Password + expiry links',
        remember: 'Persist a memory · key + tags',
        recall: 'Ranked full-text search',
        list_memories: 'Enumerate the brain',
        forget: 'Drop a memory',
        send_file: 'Signed delivery to a peer drive'
      } as Record<string, string>,
      autoplay: 'auto-playing · hover a tool to focus'
    },
    cap: {
      eyebrow: 'What your agents can do',
      h2: 'A drive that keeps, remembers, and hands things off.',
      body: 'Not a folder of files. A living workspace your agents read from, write to, and pass between each other — everything sealed, versioned, and yours.',
      tags: [['◨', 'Files & shares'], ['❖', 'Persistent memory'], ['✎', 'Signed hand-off']] as [string, string][]
    },
    feat: {
      store: {
        kicker: 'Store',
        title: 'Everything an agent touches, kept safe',
        body: "Drop a file and it's sealed, versioned, and shareable in one line — no dashboards, no drag-and-drop."
      },
      remember: {
        kicker: 'Remember',
        title: 'It recalls what you decided',
        body: 'Ask in plain language; the drive surfaces the memory your agents wrote weeks ago.'
      },
      handoff: {
        kicker: 'Hand-off',
        title: 'Pass work between agents',
        body: 'One agent seals it, another opens it — signed, delivered, and traceable.'
      },
      chips: {
        photos: '48 items',
        share: 'share link',
        ttl: '7d',
        query: '"what did we decide on pricing?"',
        recalled: 'recalled · 3 wks ago',
        signed: 'signed ✓',
        delivered: 'delivered to peer drive'
      }
    },
    identity: {
      eyebrow: 'Trust',
      h2: 'Every drive has a cryptographic identity.',
      body: 'Agent Drive publishes an A2A-compatible Agent Card — a public Ed25519 key, its capabilities, and its endpoints — so other agents can discover it and verify that a delivered file, or a subscribed bundle, really came from this drive and wasn’t tampered with in transit.',
      bullets: [['A2A-compatible card', 'at /.well-known/agent.json — standard discovery.'], ['Ed25519 signatures', 'on every inbox payload and bundle manifest — algorithm pinned, no confusion attacks.'], ['Scoped & revocable', 'OAuth 2.1 + path-scoped tokens limit blast radius to a subtree.']] as [string, string][]
    },
    connect: {
      eyebrow: 'Get started',
      h2: 'Point an agent at it.',
      body: 'Add the MCP endpoint to any client, authorize the scopes you want, and your agent has a private drive with memory. The human clicks once; the agent does the rest.',
      cta: 'Open the connect wizard'
    },
    footer: {
      tagline: 'An agent-native private cloud drive. Files, memory, and signed drive-to-drive handoff — all over one API.',
      cols: [['For agents', ['/llms.txt', '/api/public/guide', '/api/public/mcp', '/.well-known/agent.json']], ['For humans', ['Open the drive', 'Connect an agent', 'Bundles']], ['Built by', ['@yrzhe_top', 'Docs']]] as [string, string[]][],
      bottom: 'Agent Drive · single-owner deployment · on EdgeSpark'
    }
  },
  zh: {
    nav: [['工具', '#tools'], ['能力', '#capabilities'], ['身份', '#identity']] as [string, string][],
    hero: {
      eyebrow: '为 agent 而生的私有云盘',
      head: [[{
        w: 'agent'
      }, {
        w: '之间'
      }], [{
        w: '交接',
        acc: true
      }, {
        w: '文件的'
      }, {
        w: '云盘。'
      }]] as HeadWord[][],
      sub: '文件、记忆,还有带签名的交接,在 agent 之间流转 —— 走 MCP 与 REST,无需注册,只有它们看得见。',
      cta1: '接入一个 agent'
    },
    tools: {
      eyebrow: '接口',
      h2: '十个工具,一个入口。',
      body: '每个能力都是一个 MCP 工具,外加一条对应的 REST 路由,受同一套权限守护。Agent 列一次就能开工 —— 和人类点来点去看到的是同一套东西,只是不用点。',
      chips: ['10 个工具', '1 个入口', 'JSON-RPC 2.0', 'REST 镜像', 'OAuth 2.1 权限'],
      groups: {
        Files: '文件',
        Memory: '记忆',
        'Hand-off': '交接'
      } as Record<string, string>,
      desc: {
        list_files: '遍历任意文件夹',
        read_file: '读取文件内容',
        write_file: '写入或更新,自动留版本',
        search_files: '全盘全文搜索',
        create_share: '带密码和有效期的分享链接',
        remember: '存一条记忆 · key + 标签',
        recall: '按相关度全文召回',
        list_memories: '列出整个记忆库',
        forget: '删除一条记忆',
        send_file: '带签名投递到对方云盘'
      } as Record<string, string>,
      autoplay: '自动播放 · 悬停某个工具查看'
    },
    cap: {
      eyebrow: '你的 agent 能做什么',
      h2: '一个会保管、会记忆、会交接的云盘。',
      body: '不是一堆文件夹,而是一个活的工作空间 —— 你的 agent 在这里读、写,并彼此传递,一切都封存、留版本,只属于你。',
      tags: [['◨', '文件与分享'], ['❖', '持久记忆'], ['✎', '带签名交接']] as [string, string][]
    },
    feat: {
      store: {
        kicker: '保管',
        title: 'agent 碰过的一切,妥善保管',
        body: '丢一个文件进来,自动封存、留版本,一行就能分享 —— 没有后台,不用拖拽。'
      },
      remember: {
        kicker: '记忆',
        title: '它记得你当初的决定',
        body: '用大白话问一句,云盘就翻出几周前 agent 写下的记忆。'
      },
      handoff: {
        kicker: '交接',
        title: '在 agent 之间传递工作',
        body: '一个 agent 封好,另一个打开 —— 有签名、可投递、可追溯。'
      },
      chips: {
        photos: '48 项',
        share: '分享链接',
        ttl: '7 天',
        query: '"定价最后是怎么定的?"',
        recalled: '已召回 · 3 周前',
        signed: '已签名 ✓',
        delivered: '已投递到对方云盘'
      }
    },
    identity: {
      eyebrow: '信任',
      h2: '每个云盘都有加密身份。',
      body: 'Agent Drive 会发布一张 A2A 兼容的 Agent Card —— 公开的 Ed25519 公钥、它的能力和端点 —— 让别的 agent 能发现它,并验证收到的文件或订阅的 bundle 确实来自这个云盘、途中没被篡改。',
      bullets: [['A2A 兼容 Card', '位于 /.well-known/agent.json —— 标准发现方式。'], ['Ed25519 签名', '每条 inbox 载荷和 bundle 清单都签 —— 算法锁定,杜绝混淆攻击。'], ['可授权、可撤销', 'OAuth 2.1 + 路径级 token,把影响范围限制在某棵子树内。']] as [string, string][]
    },
    connect: {
      eyebrow: '开始接入',
      h2: '把 agent 指过来。',
      body: '把 MCP 端点加进任意客户端,授权你想给的权限,你的 agent 就有了一个带记忆的私有云盘。人类点一次,剩下的交给 agent。',
      cta: '打开接入向导'
    },
    footer: {
      tagline: '一个为 agent 而生的私有云盘。文件、记忆,以及带签名的云盘间交接 —— 全在一套 API 里。',
      cols: [['给 agent', ['/llms.txt', '/api/public/guide', '/api/public/mcp', '/.well-known/agent.json']], ['给人类', ['打开云盘', '接入 agent', '订阅包']], ['作者', ['@yrzhe_top', '文档']]] as [string, string[]][],
      bottom: 'Agent Drive · 单一所有者部署 · 运行于 EdgeSpark'
    }
  }
};

/* ---------------- icons ---------------- */
function IconCopy() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>;
}
function IconCheck() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>;
}
function IconArrow() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
}
function IconSun() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>;
}
function IconMoon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" /></svg>;
}

/* ---------------- scroll reveal ---------------- */
function Reveal({
  children,
  className,
  style,
  id
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  id?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(entries => entries.forEach(e => {
      if (e.isIntersecting) {
        el.setAttribute('data-reveal', 'shown');
        io.unobserve(el);
      }
    }), {
      threshold: 0.12,
      rootMargin: '-50px'
    });
    io.observe(el);
    const fb = window.setTimeout(() => el.setAttribute('data-reveal', 'shown'), 2600);
    return () => {
      io.disconnect();
      window.clearTimeout(fb);
    };
  }, []);
  return <section ref={ref as React.RefObject<HTMLElement>} data-reveal="" id={id} className={className} style={style}>{children}</section>;
}
const ri = (i: number): React.CSSProperties => ({
  transitionDelay: `${i * 70}ms`
});

/* ---------------- magnetic button ---------------- */
function Magnetic({
  href,
  className,
  style,
  children
}: {
  href: string;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLAnchorElement>(null);
  const onMove = (e: React.MouseEvent) => {
    const el = ref.current;
    if (!el || prefersReduce()) return;
    const r = el.getBoundingClientRect();
    el.style.transform = `translate(${(e.clientX - (r.left + r.width / 2)) * 0.25}px, ${(e.clientY - (r.top + r.height / 2)) * 0.4}px)`;
  };
  const onLeave = () => {
    if (ref.current) ref.current.style.transform = 'translate(0,0)';
  };
  return <a ref={ref} href={href} onMouseMove={onMove} onMouseLeave={onLeave} className={`magnetic ${className || ''}`} style={style}>{children}</a>;
}

function CopyButton({
  text
}: {
  text: string;
}) {
  const [done, setDone] = useState(false);
  return <button onClick={() => {
    try {
      navigator.clipboard?.writeText(text);
    } catch {/* noop */}
    setDone(true);
    setTimeout(() => setDone(false), 1300);
  }} className="press inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition-colors" style={{
    ...mono,
    color: done ? 'var(--verified)' : 'var(--code-dim)'
  }} aria-label="Copy to clipboard">{done ? <IconCheck /> : <IconCopy />}{done ? 'copied' : 'copy'}</button>;
}
function Eyebrow({
  children
}: {
  children: React.ReactNode;
}) {
  return <span className="text-[11px] font-semibold uppercase tracking-[0.16em]" style={{
    ...mono,
    color: 'var(--accent)'
  }}>{children}</span>;
}
/* ---------------- Browserbase-style dithered hero: classical hand-off as a WebGL dot field + cursor-trail particles ---------------- */
const HERO_IMG = '/landing/hero.jpg';
const HERO_FONTS = [{
  name: 'Bricolage Grotesque',
  css: "'Bricolage Grotesque', 'Inter', system-ui, sans-serif",
  w: 800,
  emW: 800,
  ital: false
}, {
  name: 'Space Grotesk',
  css: "'Space Grotesk', 'Inter', system-ui, sans-serif",
  w: 700,
  emW: 700,
  ital: false
}, {
  name: 'Archivo',
  css: "'Archivo', 'Inter', system-ui, sans-serif",
  w: 800,
  emW: 800,
  ital: false
}, {
  name: 'Fraunces (serif)',
  css: "'Fraunces', Georgia, serif",
  w: 900,
  emW: 900,
  ital: true
}] as const;
function ToolsExplorer({
  t: L
}: {
  t: Strings;
}) {
  const flat = TOOL_GROUPS.flatMap(g => g.tools.map(t => ({
    ...t,
    group: g.label
  })));
  const idxOf = (name: string) => flat.findIndex(t => t.name === name);
  const [active, setActive] = useState('write_file');
  const pausedRef = useRef(false);
  const idxRef = useRef(idxOf('write_file'));
  useEffect(() => {
    const id = setInterval(() => {
      if (pausedRef.current) return;
      idxRef.current = (idxRef.current + 1) % flat.length;
      setActive(flat[idxRef.current].name);
    }, 2600);
    return () => clearInterval(id);
  }, []);
  const pick = (name: string) => {
    setActive(name);
    idxRef.current = idxOf(name);
    pausedRef.current = true;
  };
  const call = TOOL_CALLS[active];
  const cs: React.CSSProperties = {
    fontFamily: 'var(--font-mono)'
  };
  return <div onMouseLeave={() => {
    pausedRef.current = false;
  }}>
      <div className="ri mt-6 flex flex-wrap gap-2" style={ri(2)}>{L.tools.chips.map(s => <span key={s} className="rounded-full px-3 py-1 text-[11.5px]" style={{
        ...cs,
        color: 'var(--slate)',
        border: '1px solid var(--line)',
        background: 'var(--surface)'
      }}>{s}</span>)}</div>

      <div className="mt-6 grid grid-cols-1 items-start gap-4 md:grid-cols-3">{TOOL_GROUPS.map((g, gi) => <div key={g.label} className="ri rounded-2xl p-5" style={{
        background: 'var(--surface)',
        border: '1px solid var(--line)',
        ...ri(3 + gi)
      }}>
            <div className="flex items-center gap-2.5">
              <span className="grid h-8 w-8 place-items-center rounded-lg" style={{
            background: 'var(--accent-soft)',
            color: 'var(--accent)'
          }}><Ti name={g.icon} size={17} /></span>
              <span className="text-[15px] font-semibold" style={{
            fontFamily: 'var(--font-heading)',
            color: 'var(--ink)',
            letterSpacing: '-0.01em'
          }}>{L.tools.groups[g.label] || g.label}</span>
              <span className="ml-auto rounded-full px-2 py-0.5 text-[10.5px]" style={{
            ...cs,
            color: 'var(--faint)',
            border: '1px solid var(--line)'
          }}>{g.tools.length}</span>
            </div>
            <div className="mt-3 flex flex-col gap-0.5">{g.tools.map(t => {
            const on = active === t.name;
            return <div key={t.name} onMouseEnter={() => pick(t.name)} className="flex cursor-default items-start gap-2.5 rounded-lg px-2.5 py-2" style={{
              transition: 'background 160ms var(--ease-out), transform 160ms var(--ease-out)',
              background: on ? 'var(--accent-soft)' : 'transparent',
              transform: on ? 'translateX(3px)' : 'none'
            }}>
                  <span className="mt-[3px] shrink-0" style={{
                color: 'var(--accent)'
              }}><Ti name={t.icon} size={14} /></span>
                  <div>
                    <div className="text-[12.5px] font-semibold" style={{
                  ...cs,
                  color: on ? 'var(--accent)' : 'var(--ink)'
                }}>{t.name}</div>
                    <div className="mt-0.5 text-[11.5px] leading-snug" style={{
                  color: 'var(--faint)'
                }}>{L.tools.desc[t.name] || t.desc}</div>
                  </div>
                </div>;
          })}</div>
            {g.note && <div className="mt-3 border-t pt-2.5 text-[10.5px]" style={{
          borderColor: 'var(--line)',
          ...cs,
          color: 'var(--faint)'
        }}>{g.note}</div>}
          </div>)}</div>

      <div className="ri mt-4 overflow-hidden rounded-2xl" style={{
      background: 'var(--code-bg)',
      border: '1px solid var(--code-line)',
      ...ri(6)
    }}>
        <div className="flex items-center gap-2 px-4 py-2.5" style={{
        borderBottom: '1px solid var(--code-line)'
      }}>
          <span className="flex gap-1.5">{['#E0863A', '#8B8375', '#3a352c'].map(c => <span key={c} className="h-2.5 w-2.5 rounded-full" style={{
            background: c
          }} />)}</span>
          <span className="ml-1.5 text-[12px]" style={{
          ...cs,
          color: 'var(--code-dim)'
        }}>POST /api/public/mcp · JSON-RPC 2.0</span>
          <span className="ml-auto text-[11px]" style={{
          ...cs,
          color: 'var(--code-dim)'
        }}>{L.tools.autoplay}</span>
        </div>
        <div key={active} className="mcp-fade px-4 py-4 text-[12.5px] leading-[1.75]" style={cs}>
          <div><span style={{
            color: 'var(--code-dim)'
          }}>→ </span><span style={{
            color: 'var(--code-accent)'
          }}>{active}</span><span style={{
            color: 'var(--code-dim)'
          }}>  {call.req}</span></div>
          <div className="mt-1"><span style={{
            color: 'var(--code-str)'
          }}>← 200 OK</span><span style={{
            color: 'var(--code-dim)'
          }}>  ·  {call.ms}ms  ·  scope </span><span style={{
            color: 'var(--code-kw)'
          }}>{call.scope}</span></div>
          <div className="mt-2.5">{call.resp.map((l, i) => <div key={i} style={{
            color: 'var(--code-fg)'
          }}>{l}</div>)}</div>
          <div className="mt-1"><span style={{
            color: 'var(--code-accent)',
            animation: 'cursor-blink 1s step-end infinite'
          }}>▮</span></div>
        </div>
      </div>
    </div>;
}
function ScrambleWord({
  text,
  offset = 0,
  style
}: {
  text: string;
  offset?: number;
  style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (prefersReduce()) {
      el.textContent = text;
      return;
    }
    const GLYPHS = '▚▛▓░<>/\\[]{}=+*^?#$%&@01λξΣΔΨ';
    const STEP = 34; // ms between each letter locking in
    const t0 = performance.now();
    let raf = 0;
    const tick = () => {
      const t = performance.now() - t0;
      let out = '';
      let done = true;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === ' ') {
          out += ' ';
          continue;
        }
        if (t >= (offset + i) * STEP) {
          out += ch;
        } else {
          out += GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
          done = false;
        }
      }
      el.textContent = out;
      if (done) {
        el.textContent = text;
      } else {
        raf = requestAnimationFrame(tick);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text, offset]);
  return <span ref={ref} className="scr-word" style={style}>{text}</span>;
}
function DitherHero({
  dark,
  t
}: {
  dark: boolean;
  t: Strings;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const secRef = useRef<HTMLElement>(null);
  const trailRef = useRef<{
    x: number;
    y: number;
    t: number;
  }[]>([]);
  const t0Ref = useRef(0);
  const darkRef = useRef(dark);
  darkRef.current = dark;
  const font = HERO_FONTS[0];
  useEffect(() => {
    const canvas = canvasRef.current!;
    const gl = canvas.getContext('webgl2', {
      antialias: true
    });
    if (!gl) return;
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    const reduce = prefersReduce();
    const VERT = `#version 300 es
in vec2 p; void main(){ gl_Position=vec4(p,0.,1.); }`;
    const FRAG = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uTex; uniform vec2 uRes; uniform vec2 uImg;
uniform float uCell; uniform float uTime; uniform float uReveal; uniform float uBiasY;
uniform float uShimmer; uniform float uDPR; uniform vec3 uPaper; uniform vec3 uTrail[24];
float bayer(ivec2 c){int x=c.x&7;int y=c.y&7;int i=y*8+x;
  int m[64]=int[64](0,48,12,60,3,51,15,63,32,16,44,28,35,19,47,31,8,56,4,52,11,59,7,55,40,24,36,20,43,27,39,23,2,50,14,62,1,49,13,61,34,18,46,30,33,17,45,29,10,58,6,54,9,57,5,53,42,26,38,22,41,25,37,21);
  return float(m[i])/64.0;}
float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
vec2 coverUV(vec2 uv){float rC=uRes.x/uRes.y;float rI=uImg.x/uImg.y;
  vec2 f=(rC>rI)?vec2(1.0,rI/rC):vec2(rC/rI,1.0);
  vec2 c=(uv-0.5)*f+0.5; c.y+=uBiasY*f.y; return c;}
void main(){
  vec2 frag=gl_FragCoord.xy;
  vec2 cellId=floor(frag/uCell);
  vec2 cellCenter=(cellId+0.5)*uCell;
  vec2 uv=cellCenter/uRes; uv.y=1.0-uv.y;
  vec2 iuv=coverUV(uv);
  vec3 col=uPaper; float coverage=0.0;
  if(iuv.x>=0.0&&iuv.x<=1.0&&iuv.y>=0.0&&iuv.y<=1.0){
    vec4 s=texture(uTex,iuv);
    float L=dot(s.rgb,vec3(0.299,0.587,0.114));
    float d=clamp((0.90-L)*1.35,0.0,1.0); d=pow(d,0.85);
    d+=uShimmer*0.025*sin(uTime*1.6+cellId.x*0.35+cellId.y*0.6);
    float thr=bayer(ivec2(cellId));
    coverage=smoothstep(thr-0.06,thr+0.06,d);
    vec3 warm=s.rgb; warm=mix(warm,warm*vec3(1.06,0.86,0.6),0.35); col=warm;
  }
  float diag=(uv.x+(1.0-uv.y))*0.5;
  float rev=smoothstep(uReveal-0.05,uReveal+0.02,diag);
  coverage*=(1.0-rev);
  float trail=exp(-pow((diag-uReveal)*26.0,2.0));
  // cursor-trail particles (Browserbase heroEtchTrail): light fine cells near recent pointer path
  float reveal=0.0;
  for(int i=0;i<24;i++){vec3 tp=uTrail[i]; if(tp.z<0.0) continue;
    float age=uTime-tp.z; if(age>0.6) continue;
    float life=1.0-age/0.6;
    float dist=distance(frag, vec2(tp.x,tp.y));
    reveal=max(reveal, life*smoothstep(150.0*uDPR,0.0,dist));}
  float sp=step(hash(cellId+floor(uTime*8.0)*0.0), reveal*reveal);
  float particle=sp*reveal;
  coverage=max(coverage, particle*0.9);
  vec3 outc=mix(uPaper,col,coverage);
  float ambThr=bayer(ivec2(cellId)+ivec2(5,3));
  float amb=step(ambThr,0.05)*(1.0-coverage);
  vec3 ambCol=mix(uPaper,vec3(0.64,0.42,0.22),0.5);
  outc=mix(outc,ambCol,amb*0.5);
  outc=mix(outc,vec3(0.88,0.52,0.22),trail*0.45*step(0.001,coverage));
  float pl=dot(col,vec3(0.299,0.587,0.114));
  float hh=hash(cellId*1.7+vec2(3.1,7.3));
  vec3 hue=vec3(0.92,0.55,0.20);
  hue=mix(hue,vec3(0.90,0.74,0.22),step(0.38,hh));
  hue=mix(hue,vec3(0.88,0.36,0.14),step(0.62,hh));
  hue=mix(hue,vec3(0.22,0.68,0.52),step(0.82,hh));
  hue=mix(hue,vec3(0.36,0.60,0.80),step(0.93,hh));
  vec3 pcol=hue*mix(1.02,0.72,smoothstep(0.4,0.98,pl));
  pcol=mix(pcol,col,0.20);
  outc=mix(outc,pcol,particle);
  o=vec4(outc,1.0);
}`;
    const sh = (t: number, src: string) => {
      const s = gl.createShader(t)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw gl.getShaderInfoLog(s);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const U: Record<string, WebGLUniformLocation | null> = {};
    ['uRes', 'uImg', 'uCell', 'uTime', 'uReveal', 'uBiasY', 'uShimmer', 'uDPR', 'uPaper', 'uTrail'].forEach(n => U[n] = gl.getUniformLocation(prog, n));
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([245, 242, 235, 255]));
    let imgW = 1920,
      imgH = 1080;
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => {
      imgW = im.naturalWidth;
      imgH = im.naturalHeight;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im);
    };
    im.src = HERO_IMG;
    const resize = () => {
      const w = Math.floor(canvas.clientWidth * DPR),
        h = Math.floor(canvas.clientHeight * DPR);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
    };
    t0Ref.current = performance.now();
    const t0 = t0Ref.current;
    let raf = 0;
    const trailBuf = new Float32Array(24 * 3);
    const frame = () => {
      resize();
      const t = (performance.now() - t0) / 1000;
      const reveal = reduce ? 1.0 : Math.min(1.0, t / 1.6);
      // build trail uniform (bottom-origin device px)
      const pts = trailRef.current;
      for (let i = 0; i < 24; i++) {
        const p = pts[pts.length - 24 + i];
        if (p && t - p.t < 0.6) {
          trailBuf[i * 3] = p.x;
          trailBuf[i * 3 + 1] = p.y;
          trailBuf[i * 3 + 2] = p.t;
        } else {
          trailBuf[i * 3 + 2] = -1;
        }
      }
      const pap = darkRef.current ? [0.086, 0.075, 0.059] : [0.96, 0.949, 0.921];
      gl.uniform2f(U.uRes, canvas.width, canvas.height);
      gl.uniform2f(U.uImg, imgW, imgH);
      gl.uniform1f(U.uCell, 4 * DPR);
      gl.uniform1f(U.uTime, t);
      gl.uniform1f(U.uReveal, reveal);
      gl.uniform1f(U.uBiasY, -0.12);
      gl.uniform1f(U.uShimmer, reduce ? 0.0 : 1.0);
      gl.uniform1f(U.uDPR, DPR);
      gl.uniform3f(U.uPaper, pap[0], pap[1], pap[2]);
      gl.uniform3fv(U.uTrail, trailBuf);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      raf = requestAnimationFrame(frame);
    };
    frame();
    window.addEventListener('resize', resize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      const ext = gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
    };
  }, []);
  const onMove = (e: React.PointerEvent) => {
    const sec = secRef.current;
    if (!sec) return;
    const r = sec.getBoundingClientRect();
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    const x = (e.clientX - r.left) * DPR;
    const y = (r.height - (e.clientY - r.top)) * DPR; // flip to bottom-origin
    const t = (performance.now() - t0Ref.current) / 1000;
    const arr = trailRef.current;
    arr.push({
      x,
      y,
      t
    });
    if (arr.length > 48) arr.splice(0, arr.length - 48);
  };
  return <section id="top" ref={secRef as React.RefObject<HTMLElement>} onPointerMove={onMove} className="relative w-full overflow-hidden" style={{
    height: '92vh',
    minHeight: 640,
    background: 'var(--paper)'
  }}>
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center px-6 text-center" style={{
      paddingTop: '10vh'
    }}>
        <div className="enter" style={{
        animationDelay: '120ms'
      }}><Eyebrow>{t.hero.eyebrow}</Eyebrow></div>
        <h1 className="mt-5" style={{
        fontFamily: font.css,
        fontWeight: font.w as any,
        fontSize: 'clamp(2.3rem,5.6vw,4.7rem)',
        lineHeight: 1.06,
        letterSpacing: '-0.02em',
        color: 'var(--ink)',
        maxWidth: 'min(94vw, 62rem)'
      }}>
          {(() => {
          let o = 0;
          return t.hero.head.map((line, li) => <span key={li} className="hl-line">{line.map((word, wi) => {
            const cur = o;
            o += word.w.length + 2;
            return <React.Fragment key={wi}><ScrambleWord text={word.w} offset={cur} style={{
              marginRight: wi < line.length - 1 ? '0.26em' : undefined,
              ...(word.acc ? {
                color: 'var(--accent)',
                fontWeight: font.emW as any
              } : {})
            }} /></React.Fragment>;
          })}</span>);
        })()}
        </h1>
        <p className="enter mt-6 text-[15px] leading-relaxed sm:text-[16px]" style={{
        color: 'var(--slate)',
        maxWidth: '40ch',
        animationDelay: '540ms'
      }}>{t.hero.sub}</p>
        <div className="enter pointer-events-auto mt-8 flex flex-wrap items-center justify-center gap-3" style={{
        animationDelay: '660ms'
      }}>
          <a href="#connect" className="press inline-flex items-center gap-2 rounded-lg px-5 py-3 text-[14.5px] font-semibold" style={{
          background: 'var(--ink)',
          color: 'var(--paper)'
        }}>{t.hero.cta1} <IconArrow /></a>
          <a href="/llms.txt" className="press inline-flex items-center gap-2 rounded-lg px-4 py-3 text-[13px]" style={{
          ...mono,
          border: '1px solid var(--line-strong)',
          color: 'var(--ink)',
          background: 'color-mix(in srgb, var(--surface) 78%, transparent)',
          backdropFilter: 'blur(6px)'
        }}>cat /llms.txt</a>
        </div>
      </div>
    </section>;
}

/* ---------------- feature bento: classical stage + live product-UI chips ---------------- */
const FEAT_IMG = {
  store: "/landing/f-store.jpg",
  remember: "/landing/f-remember.jpg",
  handoff: "/landing/f-handoff.jpg"
} as const;
const FOOTER_HREF: Record<string, string> = {
  'Open the drive': '/drive',
  '打开云盘': '/drive',
  'Connect an agent': '/connect',
  '接入 agent': '/connect',
  'Bundles': '/bundles',
  '订阅包': '/bundles',
  'Docs': '/guide',
  '文档': '/guide',
  '@yrzhe_top': 'https://x.com/yrzhe_top'
};
const footerHref = (it: string) => FOOTER_HREF[it] || (it.startsWith('/') ? it : '#');
function FBChip({
  className,
  children
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <div className={`inline-flex items-center gap-2 self-start rounded-[11px] px-2.5 py-2 text-[12.5px] ${className || ''}`} style={{
    ...mono,
    color: 'var(--ink)',
    background: 'color-mix(in srgb, var(--surface) 92%, transparent)',
    border: '1px solid var(--line)',
    boxShadow: '0 8px 22px -12px rgba(0,0,0,0.5)',
    backdropFilter: 'blur(6px)'
  }}>{children}</div>;
}
function FBIcon({
  d
}: {
  d: string[];
}) {
  return <svg className="flex-none" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">{d.map((p, i) => <path key={i} d={p} />)}</svg>;
}
function FBCard({
  kicker,
  title,
  body,
  img,
  slow,
  glow,
  tall,
  delay,
  children
}: {
  kicker: string;
  title: string;
  body: string;
  img: string;
  slow?: boolean;
  glow: React.CSSProperties;
  tall?: boolean;
  delay: number;
  children: React.ReactNode;
}) {
  const lift = (v: boolean) => (e: React.MouseEvent<HTMLElement>) => {
    const el = e.currentTarget as HTMLElement;
    el.style.transform = v ? 'translateY(-6px)' : 'none';
    el.style.boxShadow = v ? '0 34px 60px -30px rgba(0,0,0,0.45)' : '0 18px 40px -28px rgba(0,0,0,0.3)';
  };
  return <article className={`ri relative flex flex-col overflow-hidden rounded-[22px] ${tall ? 'md:row-span-2' : ''}`} style={{
    border: '1px solid var(--line)',
    background: 'var(--surface)',
    boxShadow: '0 18px 40px -28px rgba(0,0,0,0.3)',
    transition: 'transform 0.5s var(--ease-out), box-shadow 0.5s var(--ease-out)',
    ...ri(delay)
  }} onMouseEnter={lift(true)} onMouseLeave={lift(false)}>
      <div className="relative z-[3] px-6 pb-1 pt-6">
        <div className="mb-2.5 flex items-center gap-2 text-[11px] uppercase tracking-[0.15em]" style={{
        ...mono,
        color: 'var(--accent)'
      }}><span className="inline-block h-1.5 w-1.5 rounded-full" style={{
          background: 'var(--accent)',
          boxShadow: '0 0 0 4px var(--accent-soft)'
        }} />{kicker}</div>
        <h3 className="text-[21px] font-bold leading-[1.1]" style={{
        ...heading,
        letterSpacing: '-0.01em'
      }}>{title}</h3>
        <p className="mt-2 max-w-[34ch] text-[14px] leading-relaxed" style={{
        color: 'var(--slate)'
      }}>{body}</p>
      </div>
      <div className="relative mt-4 flex-1 overflow-hidden" style={{
      minHeight: tall ? 250 : 168
    }}>
        <div className="pointer-events-none absolute z-[1] aspect-square w-[46%] rounded-full fb-glow" style={{
        background: 'radial-gradient(circle, rgba(255,181,92,0.55), rgba(194,97,28,0.12) 55%, transparent 72%)',
        filter: 'blur(6px)',
        mixBlendMode: 'screen',
        ...glow
      }} />
        <img src={img} alt="" className={`absolute inset-0 h-full w-full object-cover fb-img ${slow ? 'slow' : ''}`} style={{
        filter: 'saturate(1.02) contrast(1.02)'
      }} />
        <div className="pointer-events-none absolute inset-0 z-[2]" style={{
        background: 'linear-gradient(180deg, transparent 34%, color-mix(in srgb, var(--surface) 55%, transparent) 74%, var(--surface) 100%)'
      }} />
        <div className="absolute inset-x-0 bottom-0 z-[4] flex flex-col gap-2 px-5 pb-5">{children}</div>
      </div>
    </article>;
}
function FeatureBento({
  t
}: {
  t: Strings;
}) {
  const c = t.feat.chips;
  return <div className="mt-9 grid grid-cols-1 gap-5 md:grid-cols-[1.24fr_0.9fr]" style={{
    gridAutoRows: 'minmax(0, 1fr)'
  }}>
      <FBCard tall kicker={t.feat.store.kicker} title={t.feat.store.title} body={t.feat.store.body} img={FEAT_IMG.store} slow glow={{
      left: '26%',
      top: '30%'
    }} delay={2}>
        <FBChip className="fb-file f1"><FBIcon d={['M4 4h9l3 3v13H4z']} />report.md<span style={{
          color: 'var(--faint)'
        }}>· 12 KB</span></FBChip>
        <FBChip className="fb-file f2"><FBIcon d={['M3 5h18v14H3z', 'M3 15l5-4 4 3 3-2 6 5']} />photos/<span style={{
          color: 'var(--faint)'
        }}>· {c.photos}</span></FBChip>
        <FBChip className="fb-file f3"><FBIcon d={['M4 4h9l3 3v13H4z']} />invoice.pdf<span style={{
          color: 'var(--faint)'
        }}>· 210 KB</span></FBChip>
        <FBChip className="fb-share"><FBIcon d={['M9 15l6-6', 'M11 7l1-1a4 4 0 0 1 6 6l-1 1', 'M13 17l-1 1a4 4 0 0 1-6-6l1-1']} />{c.share}<span style={{
          color: 'var(--faint)'
        }}>· /s/9f2a · {c.ttl} ·</span><span style={{
          color: 'var(--verified)',
          fontWeight: 600
        }}>🔒 ✓</span></FBChip>
      </FBCard>

      <FBCard kicker={t.feat.remember.kicker} title={t.feat.remember.title} body={t.feat.remember.body} img={FEAT_IMG.remember} glow={{
      left: '30%',
      top: '20%'
    }} delay={4}>
        <FBChip className="fb-q"><FBIcon d={['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M21 21l-4.3-4.3']} />{c.query}</FBChip>
        <FBChip className="fb-recall"><FBIcon d={['M12 3a9 9 0 1 0 9 9', 'M12 7v5l3 2']} />Pro → $12/mo<span style={{
          color: 'var(--faint)'
        }}>· {c.recalled}</span></FBChip>
      </FBCard>

      <FBCard kicker={t.feat.handoff.kicker} title={t.feat.handoff.title} body={t.feat.handoff.body} img={FEAT_IMG.handoff} glow={{
      left: '34%',
      top: '24%'
    }} delay={6}>
        <FBChip className="fb-toast"><FBIcon d={['M4 12l5 5L20 6']} /><span style={{
          color: 'var(--verified)',
          fontWeight: 600
        }}>{c.signed}</span><span style={{
          color: 'var(--faint)'
        }}>· {c.delivered}</span></FBChip>
      </FBCard>
    </div>;
}
export const Landing = () => {
  const [dark, setDark] = useState(false);
  const [lang, setLang] = useState<Lang>('en');
  const t = STRINGS[lang];
  const [client, setClient] = useState<keyof typeof SNIPPETS>('Claude Code');
  const rootRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const heroContentRef = useRef<HTMLDivElement>(null);
  const heroTermRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const reduce = prefersReduce();
    let raf = 0;
    const loop = () => {
      const sy = sentinelRef.current ? -sentinelRef.current.getBoundingClientRect().top : 0;
      const root = rootRef.current;
      if (barRef.current && root) {
        const max = root.offsetHeight - window.innerHeight;
        barRef.current.style.transform = `scaleX(${max > 0 ? Math.min(1, Math.max(0, sy / max)) : 0})`;
      }
      if (!reduce) {
        if (canvasWrapRef.current) canvasWrapRef.current.style.transform = `translateY(${sy * 0.22}px)`;
        if (heroContentRef.current) heroContentRef.current.style.transform = `translateY(${sy * 0.07}px)`;
        if (heroTermRef.current) heroTermRef.current.style.transform = `translateY(${sy * -0.06}px)`;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  const marqueeItems = [...TOOLS, ...TOOLS];
  return <div ref={rootRef} className={dark ? 'dark' : ''} style={{
    width: '100%'
  }}>
      <div ref={sentinelRef} style={{
      position: 'absolute',
      top: 0,
      height: 1,
      width: 1
    }} aria-hidden="true" />
      <div className="fixed left-0 top-0 z-[60] h-[3px] w-full" aria-hidden="true"><div ref={barRef} className="scroll-bar h-full w-full" style={{
        background: 'var(--accent)'
      }} /></div>

      <div className="w-full min-h-screen" style={{
      background: 'var(--paper)',
      color: 'var(--ink)'
    }}>
        <header className="sticky top-0 z-50 backdrop-blur-md" style={{
        background: 'color-mix(in srgb, var(--paper) 82%, transparent)',
        borderBottom: '1px solid var(--line)'
      }}>
          <div className="mx-auto flex h-14 max-w-[1120px] items-center gap-5 px-6">
            <a href="#top" className="flex items-center gap-2.5 text-[15px] font-semibold" style={{
            ...heading,
            letterSpacing: '-0.01em'
          }}><span className="grid h-6 w-6 place-items-center rounded-md text-[13px] font-bold" style={{
              background: 'var(--ink)',
              color: 'var(--paper)'
            }}>◨</span>Agent Drive</a>
            <nav className="ml-auto hidden items-center gap-1 md:flex">{t.nav.map(([label, href]) => <a key={href} href={href} className="rounded-lg px-3 py-1.5 text-[13.5px]" style={{
              color: 'var(--slate)'
            }}>{label}</a>)}<a href="/llms.txt" className="rounded-lg px-3 py-1.5 text-[12.5px]" style={{
              ...mono,
              color: 'var(--slate)'
            }}>/llms.txt</a></nav>
            <button onClick={() => setLang(l => l === 'en' ? 'zh' : 'en')} className="press ml-auto grid h-8 min-w-8 place-items-center rounded-lg px-2 text-[12px] font-semibold md:ml-1" style={{
            ...mono,
            border: '1px solid var(--line)',
            background: 'var(--surface)',
            color: 'var(--slate)'
          }} aria-label="Switch language">{lang === 'en' ? '中' : 'EN'}</button>
            <button onClick={() => setDark(d => !d)} className="press ml-1 grid h-8 w-8 place-items-center rounded-lg" style={{
            border: '1px solid var(--line)',
            background: 'var(--surface)',
            color: 'var(--slate)'
          }} aria-label="Toggle theme">{dark ? <IconSun /> : <IconMoon />}</button>
          </div>
        </header>

        <DitherHero dark={dark} t={t} />

        <div className="marquee-mask relative overflow-hidden border-y py-3" style={{
        borderColor: 'var(--line)',
        background: 'var(--surface)'
      }}>
          <div className="marquee-track gap-3">{marqueeItems.map((t, i) => <span key={i} className="inline-flex items-center gap-2 whitespace-nowrap rounded-full px-3.5 py-1.5 text-[12.5px]" style={{
            ...mono,
            color: 'var(--slate)',
            border: '1px solid var(--line)',
            background: 'var(--paper)'
          }}><span style={{
              color: 'var(--accent)'
            }}>▹</span>{t.name}</span>)}</div>
          <div className="pointer-events-none absolute inset-y-0 left-0 w-16" style={{
          background: 'linear-gradient(90deg, var(--surface), transparent)'
        }} /><div className="pointer-events-none absolute inset-y-0 right-0 w-16" style={{
          background: 'linear-gradient(270deg, var(--surface), transparent)'
        }} />
        </div>

        <main className="mx-auto max-w-[1120px] px-6">
          <Reveal id="tools" className="border-t py-16 block" style={{
          borderColor: 'var(--line)'
        }}>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div><div className="ri" style={ri(0)}><Eyebrow>{t.tools.eyebrow}</Eyebrow></div><h2 className="ri mt-2 text-[clamp(1.5rem,2.6vw,2rem)] font-bold" style={{
                ...heading,
                letterSpacing: '-0.025em',
                ...ri(1)
              }}>{t.tools.h2}</h2></div>
              <span className="ri text-[13px]" style={{
              ...mono,
              color: 'var(--faint)',
              ...ri(2)
            }}>POST <b style={{
                color: 'var(--accent)'
              }}>/api/public/mcp</b></span>
            </div>
            <p className="ri mt-3 max-w-[52ch] text-[15px]" style={{
            color: 'var(--slate)',
            ...ri(2)
          }}>{t.tools.body}</p>
            <ToolsExplorer t={t} />
          </Reveal>

          <Reveal id="capabilities" className="border-t py-16 block" style={{
          borderColor: 'var(--line)'
        }}>
            <div className="grid grid-cols-1 gap-x-12 gap-y-6 md:grid-cols-[1.1fr_0.9fr] md:items-end">
              <div>
                <div className="ri" style={ri(0)}><Eyebrow>{t.cap.eyebrow}</Eyebrow></div>
                <h2 className="ri mt-2 max-w-[15ch] text-[clamp(1.7rem,3.4vw,2.6rem)] font-bold leading-[1.04]" style={{
                ...heading,
                letterSpacing: '-0.025em',
                ...ri(1)
              }}>{t.cap.h2}</h2>
              </div>
              <div className="md:pb-1.5">
                <p className="ri text-[15px] leading-relaxed" style={{
                color: 'var(--slate)',
                ...ri(2)
              }}>{t.cap.body}</p>
                <div className="ri mt-5 flex flex-wrap gap-2" style={ri(3)}>{t.cap.tags.map(([g, label]) => <span key={label} className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[12.5px]" style={{
                  ...mono,
                  color: 'var(--slate)',
                  border: '1px solid var(--line)',
                  background: 'var(--surface)'
                }}><span style={{
                    color: 'var(--accent)'
                  }}>{g}</span>{label}</span>)}</div>
              </div>
            </div>
            <FeatureBento t={t} />
          </Reveal>

          <Reveal id="identity" className="border-t py-16 block" style={{
          borderColor: 'var(--line)'
        }}>
            <div className="ri" style={ri(0)}><Eyebrow>{t.identity.eyebrow}</Eyebrow></div>
            <h2 className="ri mt-2 text-[clamp(1.5rem,2.6vw,2rem)] font-bold" style={{
            ...heading,
            letterSpacing: '-0.025em',
            ...ri(1)
          }}>{t.identity.h2}</h2>
            <div className="mt-7 grid grid-cols-1 items-center gap-10 md:grid-cols-[1.05fr_0.95fr] md:gap-14">
              <div className="ri" style={ri(2)}>
                <p className="text-[15px] leading-relaxed" style={{
                color: 'var(--slate)'
              }}>{t.identity.body}</p>
                <ul className="mt-5 flex flex-col gap-3.5">{t.identity.bullets.map(([b, desc]) => <li key={b} className="flex gap-3 text-[14px]" style={{
                  color: 'var(--slate)'
                }}><span className="mt-0.5 flex-none" style={{
                    ...mono,
                    color: 'var(--verified)'
                  }}>✓</span><span><b style={{
                      color: 'var(--ink)'
                    }}>{b}</b> {desc}</span></li>)}</ul>
              </div>
              <div className="ri overflow-hidden rounded-xl" style={{
              background: 'var(--code-bg)',
              border: '1px solid var(--code-line)',
              boxShadow: '0 24px 56px -30px rgba(0,0,0,0.55)',
              ...ri(3)
            }}>
                <div className="flex items-center justify-between px-4 py-2.5 text-[11px]" style={{
                ...mono,
                borderBottom: '1px solid var(--code-line)',
                color: 'var(--code-dim)'
              }}><span>GET /.well-known/agent.json</span><span style={{
                  color: 'var(--verified)'
                }}>● signed</span></div>
                <div className="px-4 py-4 text-[12.5px] leading-[1.75] overflow-x-auto" style={{
                ...mono,
                color: 'var(--code-fg)'
              }}><pre className="m-0" style={{
                  ...mono
                }}>{`{
  `}<span style={{
                    color: 'var(--code-kw)'
                  }}>"name"</span>{`: `}<span style={{
                    color: 'var(--code-str)'
                  }}>"Agent Drive"</span>{`,
  `}<span style={{
                    color: 'var(--code-kw)'
                  }}>"protocol"</span>{`: `}<span style={{
                    color: 'var(--code-str)'
                  }}>"a2a/1.0"</span>{`,
  `}<span style={{
                    color: 'var(--code-kw)'
                  }}>"identity"</span>{`: {
    `}<span style={{
                    color: 'var(--code-kw)'
                  }}>"alg"</span>{`: `}<span style={{
                    color: 'var(--code-str)'
                  }}>"Ed25519"</span>{`,
    `}<span style={{
                    color: 'var(--code-kw)'
                  }}>"publicKey"</span>{`: `}<span style={{
                    color: 'var(--code-str)'
                  }}>"MCowBQYDK2Vw…"</span>{`
  },
  `}<span style={{
                    color: 'var(--code-kw)'
                  }}>"verified"</span>{`: `}<span style={{
                    color: 'var(--verified)'
                  }}>true</span>{`
}`}</pre></div>
              </div>
            </div>
          </Reveal>

          <Reveal id="connect" className="border-t py-16 block" style={{
          borderColor: 'var(--line)'
        }}>
            <div className="ri overflow-hidden rounded-2xl" style={{
            border: '1px solid var(--line)',
            background: 'radial-gradient(120% 130% at 100% 0%, var(--accent-soft), transparent 55%), var(--surface)',
            ...ri(0)
          }}>
              <div className="px-6 py-10 sm:px-10">
                <div className="text-center"><Eyebrow>{t.connect.eyebrow}</Eyebrow><h2 className="mt-2 text-[clamp(1.5rem,2.6vw,2rem)] font-bold" style={{
                  ...heading,
                  letterSpacing: '-0.025em'
                }}>{t.connect.h2}</h2><p className="mx-auto mt-3 max-w-[46ch] text-[15px]" style={{
                  color: 'var(--slate)'
                }}>{t.connect.body}</p></div>
                <div className="mx-auto mt-8 max-w-[640px]">
                  <div className="flex gap-1 rounded-lg p-1" style={{
                  border: '1px solid var(--line)',
                  background: 'var(--paper)'
                }}>{(Object.keys(SNIPPETS) as (keyof typeof SNIPPETS)[]).map(k => <button key={k} onClick={() => setClient(k)} className="press flex-1 rounded-md px-3 py-2 text-[13px] font-medium transition-colors" style={client === k ? {
                    background: 'var(--ink)',
                    color: 'var(--paper)'
                  } : {
                    color: 'var(--slate)',
                    background: 'transparent'
                  }}>{k}</button>)}</div>
                  <div className="mt-3 overflow-hidden rounded-lg" style={{
                  background: 'var(--code-bg)',
                  border: '1px solid var(--code-line)'
                }}><div className="flex items-center justify-between px-3 py-2" style={{
                    borderBottom: '1px solid var(--code-line)'
                  }}><span className="text-[11px]" style={{
                      ...mono,
                      color: 'var(--code-dim)'
                    }}>{client}</span><CopyButton text={SNIPPETS[client]} /></div><pre className="m-0 overflow-x-auto px-4 py-3.5 text-[12.5px] leading-[1.7]" style={{
                    ...mono,
                    color: 'var(--code-fg)'
                  }}>{SNIPPETS[client]}</pre></div>
                  <div className="mt-5 flex justify-center"><Magnetic href="/connect" className="press inline-flex items-center gap-2 rounded-lg px-5 py-3 text-[14.5px] font-semibold" style={{
                    background: 'var(--accent)',
                    color: '#fff'
                  }}>{t.connect.cta} <IconArrow /></Magnetic></div>
                </div>
              </div>
            </div>
          </Reveal>
        </main>

        <footer className="border-t" style={{
        borderColor: 'var(--line)'
      }}>
          <div className="mx-auto grid max-w-[1120px] grid-cols-2 gap-8 px-6 py-12 md:grid-cols-4">
            <div className="col-span-2 md:col-span-1"><div className="flex items-center gap-2.5 text-[15px] font-semibold" style={heading}><span className="grid h-6 w-6 place-items-center rounded-md text-[13px] font-bold" style={{
                background: 'var(--ink)',
                color: 'var(--paper)'
              }}>◨</span>Agent Drive</div><p className="mt-3 max-w-[26ch] text-[13px]" style={{
              color: 'var(--slate)'
            }}>{t.footer.tagline}</p></div>
            {t.footer.cols.map(([h, items]) => <div key={h}><h4 className="mb-3 text-[11px] uppercase tracking-[0.12em]" style={{
              ...mono,
              color: 'var(--faint)'
            }}>{h}</h4>{items.map(it => <a key={it} href={footerHref(it)} className="block py-1 text-[13px] transition-colors" style={{
              ...mono,
              color: 'var(--slate)'
            }} onMouseEnter={e => {
              (e.currentTarget as HTMLAnchorElement).style.color = 'var(--accent)';
            }} onMouseLeave={e => {
              (e.currentTarget as HTMLAnchorElement).style.color = 'var(--slate)';
            }}>{it}</a>)}</div>)}
          </div>
          <div className="mx-auto flex max-w-[1120px] flex-wrap justify-between gap-2 px-6 pb-10 text-[12px]" style={{
          ...mono,
          color: 'var(--faint)'
        }}><span>{t.footer.bottom}</span><span>{DOMAIN}</span></div>
        </footer>
      </div>
    </div>;
};
export default Landing;