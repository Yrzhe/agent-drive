const BINARY_SCAN_BYTES = 8 * 1024;

export function isBinaryContent(buffer: Buffer): boolean {
  const head = buffer.subarray(0, BINARY_SCAN_BYTES);
  if (head.includes(0)) return true;
  return !Buffer.from(buffer.toString("utf8"), "utf8").equals(buffer);
}
