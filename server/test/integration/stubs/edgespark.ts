import { runtime } from "../edge-runtime";

export const storage = new Proxy({} as any, {
  get(_target, property) {
    const value = runtime.storage[property as keyof typeof runtime.storage];
    return typeof value === "function" ? value.bind(runtime.storage) : value;
  },
});

export const vars = {
  get(name: string): string | null {
    return runtime.vars.get(name) ?? null;
  },
};

export const secret = {
  get(name: string): string | null {
    return runtime.secrets.get(name) ?? null;
  },
};

export const ctx = {
  get environment() {
    return "staging" as const;
  },
  runInBackground(promise: Promise<unknown>): void {
    runtime.background.push(Promise.resolve(promise));
  },
};

export const db = new Proxy({} as any, {
  get(_target, property) {
    const value = runtime.db[property as keyof typeof runtime.db];
    return typeof value === "function" ? value.bind(runtime.db) : value;
  },
});
