const UNITS: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
};

export function parseSize(value: string | number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value === "number") return value;
  const trimmed = value.trim();
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/iu.exec(trimmed);
  if (!match) throw new Error(`Invalid size: ${value}. Use values like 10MB or 1GB.`);
  const amount = Number(match[1]);
  const unit = (match[2] ?? "b").toLowerCase();
  return Math.floor(amount * UNITS[unit]);
}

export function formatBytes(bytes: number): string {
  const format = (value: number, unit: string) => `${Number.isInteger(value) ? String(value) : value.toFixed(1)} ${unit}`;
  if (bytes >= 1024 ** 3) return format(bytes / 1024 ** 3, "GB");
  if (bytes >= 1024 ** 2) return format(bytes / 1024 ** 2, "MB");
  if (bytes >= 1024) return format(bytes / 1024, "KB");
  return `${bytes} B`;
}
