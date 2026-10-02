export interface BrowserTool {
  name: string;
  description: string;
  inputSchema: object;
  annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
  execute(input: unknown): unknown | Promise<unknown>;
}
interface ModelContext { registerTool(tool: BrowserTool, options: { signal: AbortSignal }): void | Promise<void> }
export function registerBrowserTools(tools: BrowserTool[]): () => void {
  const context = (document as Document & { modelContext?: ModelContext }).modelContext;
  if (!context?.registerTool) return () => {};
  const lifecycle = new AbortController();
  for (const tool of tools) {
    try { void Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => {}); }
    catch { /* Unsupported browser or another page registry; UI remains usable. */ }
  }
  return () => lifecycle.abort();
}
