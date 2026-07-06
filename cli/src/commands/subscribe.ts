import { createHash, webcrypto } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

interface SubscribeOptions {
  to: string;
  verify?: boolean;
}

interface CurrentResponse {
  publicId: string;
  versionId: string;
  hash: string;
  fileCount: number;
  totalSize: number;
  pushedAt: string;
  manifestUrl: string;
  signature?: { algorithm: string; value: string };
}

interface ManifestFileEntry {
  path: string;
  size: number;
  hash: string;
}

function parseSubscribeUrl(input: string): { origin: string; publicId: string } {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Subscribe URL must be a full URL like https://host/api/public/b/<id>/current");
  }
  const match = url.pathname.match(/\/api\/public\/b\/([^/]+)/u);
  if (!match) throw new Error("Subscribe URL must contain /api/public/b/<publicId>");
  return { origin: url.origin, publicId: match[1] };
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return new Uint8Array(Buffer.from(padded, "base64"));
}

async function verifyManifestSignature(origin: string, manifestBytes: Uint8Array, signatureB64Url: string): Promise<void> {
  const cardResponse = await fetch(`${origin}/api/public/.well-known/agent.json`);
  if (!cardResponse.ok) throw new Error(`Cannot fetch Agent Card for verification (HTTP ${cardResponse.status})`);
  const card = (await cardResponse.json()) as { signing?: { algorithm?: string; publicKeyJwk?: JsonWebKey } };
  const jwk = card.signing?.publicKeyJwk;
  if (!jwk) throw new Error("Agent Card has no signing.publicKeyJwk — cannot verify");
  const key = await webcrypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["verify"]);
  const valid = await webcrypto.subtle.verify({ name: "Ed25519" }, key, base64UrlDecode(signatureB64Url), manifestBytes);
  if (!valid) throw new Error("Manifest signature verification FAILED — the bundle may not come from this Drive's identity");
  console.log("Signature verified against the publisher's Agent Card ✓");
}

function assertSafeRelativePath(path: string): void {
  if (path.startsWith("/") || path.includes("\\") || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Manifest contains unsafe path: ${path}`);
  }
}

export async function subscribeCommand(url: string, options: SubscribeOptions): Promise<void> {
  const { origin, publicId } = parseSubscribeUrl(url);
  const localPath = resolve(options.to);

  const currentResponse = await fetch(`${origin}/api/public/b/${publicId}/current`);
  if (!currentResponse.ok) throw new Error(`Bundle not available (HTTP ${currentResponse.status})`);
  const current = (await currentResponse.json()) as CurrentResponse;

  const manifestResponse = await fetch(`${origin}/api/public/b/${publicId}/manifest`);
  if (!manifestResponse.ok) throw new Error(`Manifest not available (HTTP ${manifestResponse.status})`);
  const manifestBytes = new Uint8Array(await manifestResponse.arrayBuffer());

  if (options.verify !== false) {
    if (!current.signature?.value) throw new Error("Publisher did not provide a signature (use --no-verify to skip)");
    await verifyManifestSignature(origin, manifestBytes, current.signature.value);
  }

  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as { files?: ManifestFileEntry[] };
  const entries = manifest.files ?? [];
  console.log(`Subscribing to ${publicId} @ ${current.versionId} — ${entries.length} files`);

  await mkdir(localPath, { recursive: true });
  for (const entry of entries) {
    assertSafeRelativePath(entry.path);
    const fileResponse = await fetch(`${origin}/api/public/b/${publicId}/file?path=${encodeURIComponent(entry.path)}`);
    if (!fileResponse.ok) throw new Error(`Failed to resolve ${entry.path} (HTTP ${fileResponse.status})`);
    const { downloadUrl } = (await fileResponse.json()) as { downloadUrl: string };
    const download = await fetch(downloadUrl);
    if (!download.ok) throw new Error(`Failed to download ${entry.path} (HTTP ${download.status})`);
    const bytes = new Uint8Array(await download.arrayBuffer());
    // The signature covers the manifest; the manifest's per-file sha256 covers
    // the bytes. Without this check the chain of trust stops at the file list.
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== entry.hash) {
      throw new Error(`Hash mismatch for ${entry.path}: manifest ${entry.hash}, downloaded ${digest} — aborting`);
    }
    const target = join(localPath, entry.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    console.log(`  ✓ ${entry.path} (sha256 verified)`);
  }

  console.log(`Subscribed ${publicId} → ${localPath} (versionId=${current.versionId}, pushedAt=${current.pushedAt})`);
  console.log("Re-run the same command later to pull updates.");
}
