/** Provider registry: crawls self-describing signed manifests (OCGP §2.1, §5). */
import { verify, type Manifest } from "./protocol.js";
import { env } from "./config.js";

export type Entry = { operator_id: string; node_id: string; base_url: string; manifest: Manifest; verified: boolean; last_seen: string; online: boolean };
const entries = new Map<string, Entry>();
const seedUrls = new Set<string>(env.REGISTRY_SEED);

async function fetchJson(url: string, ms = 3000): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

/** Fetch + verify a manifest URL (or a base URL) and upsert it. */
export async function register(urlOrBase: string): Promise<Entry> {
  const url = urlOrBase.includes("/.well-known/") ? urlOrBase : urlOrBase.replace(/\/$/, "") + "/.well-known/ocgp.json";
  const manifest: Manifest = await fetchJson(url);
  const verified = await verify(manifest, manifest.public_key);
  const base_url = (manifest.base_url || urlOrBase.replace(/\/\.well-known\/.*$/, "")).replace(/\/$/, "");
  const entry: Entry = { operator_id: manifest.operator_id, node_id: manifest.node_id, base_url, manifest, verified, last_seen: new Date().toISOString(), online: true };
  const isNew = !entries.has(manifest.operator_id);
  entries.set(manifest.operator_id, entry);
  seedUrls.add(base_url);
  if (isNew) console.log(`[registry] ${verified ? "verified" : "UNVERIFIED"} provider ${manifest.operator_id} (${manifest.node_id}) at ${base_url}`);
  return entry;
}

export async function crawl(): Promise<void> {
  await Promise.all([...seedUrls].map(async (u) => {
    try { await register(u); } catch {
      const e = [...entries.values()].find((x) => x.base_url === u.replace(/\/$/, ""));
      if (e && e.online) { e.online = false; console.log(`[registry] provider ${e.operator_id} offline`); }
    }
  }));
}
export function startCrawler(intervalMs = 10_000) { crawl().catch(() => {}); setInterval(() => crawl().catch(() => {}), intervalMs).unref(); }
export function list(): Entry[] { return [...entries.values()]; }
export function byOperator(id: string) { return entries.get(id); }
export function byNode(node_id: string) { return [...entries.values()].find((e) => e.node_id === node_id); }
export function reset() { entries.clear(); }
