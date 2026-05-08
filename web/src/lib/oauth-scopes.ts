export interface OAuthScopeDescription {
  scope: string;
  title: string;
  description: string;
}

export const OAUTH_SCOPE_DESCRIPTIONS: Record<string, Omit<OAuthScopeDescription, "scope">> = {
  "read:drive": {
    title: "读取你的文件 / Read your files",
    description: "允许该 MCP 客户端列出、搜索和读取 Agent Drive 中的文件内容。",
  },
  "write:drive": {
    title: "写入你的文件 / Write files",
    description: "允许该 MCP 客户端创建、更新和删除 Agent Drive 中的文件。",
  },
  "read:memory": {
    title: "读取你的记忆 / Read memory",
    description: "允许该 MCP 客户端读取已保存的偏好、记忆和上下文。",
  },
  "write:memory": {
    title: "写入你的记忆 / Write memory",
    description: "允许该 MCP 客户端保存新的偏好、记忆和上下文。",
  },
  "read:skills": {
    title: "读取你的 Skills / Read skills",
    description: "允许该 MCP 客户端读取已同步的 skills、规则和能力说明。",
  },
  "write:skills": {
    title: "写入你的 Skills / Write skills",
    description: "允许该 MCP 客户端导入、更新或备份 skills。",
  },
  "share:create": {
    title: "创建分享链接 / Create share links",
    description: "允许该 MCP 客户端为文件或文件夹创建可分享链接。",
  },
};

export function parseOAuthScopes(scopeParam: string | null): string[] {
  if (!scopeParam) return [];
  return Array.from(new Set(scopeParam.split(/\s+/).map((scope) => scope.trim()).filter(Boolean)));
}

export function describeOAuthScope(scope: string): OAuthScopeDescription {
  const known = OAUTH_SCOPE_DESCRIPTIONS[scope];
  if (known) return { scope, ...known };
  return {
    scope,
    title: `${scope} / Unknown permission`,
    description: "此权限不在当前前端词表中。请确认你信任该 MCP 客户端后再同意。",
  };
}
