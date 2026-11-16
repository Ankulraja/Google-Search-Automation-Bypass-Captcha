import fs from "fs";
import path from "path";
import { storedSearches } from "./search-db";

// Uploads finished runs to the central store in ads-next (Search Automation Results).
//
//  - Upload key: created on ads-next → Search Automation Results → API keys, pasted on Run queries.
//    Kept in ui/data/upload.json (git-ignored). Every run uploaded with it is saved under the key owner's email.
//  - No key, no run: /api/run calls requireKey() first.
//  - After every run its rows are put in a queue (ui/data/upload-queue.json) and sent; whatever cannot be
//    sent (offline, VPN off, server down) stays queued and is retried every minute.
//  - Only extracted rows are sent, never the page source; image_url / url_of_product only when they are web links.
// Server: GSA_UPLOAD_URL (default https://ads.intermesh.net).

export const UPLOAD_URL = (process.env.GSA_UPLOAD_URL || "https://ads.intermesh.net").replace(/\/+$/, "");
const API_VERSION = 1;
const BATCH = 100; // the server's per-request limit
const KEY_RE = /^gsa_[A-Za-z0-9_-]{32}$/;
const DATA = path.join(__dirname, "data");
const SETTINGS = path.join(DATA, "upload.json");
const QUEUE = path.join(DATA, "upload-queue.json");
const CAPTURES = path.join(__dirname, "captures");
const ENDPOINT = `${UPLOAD_URL}/api/search-automation/ingest`;

export interface KeyInfo {
  user_email: string;
  project: string;
  expires_at: string | null;
}
interface Settings extends KeyInfo {
  key: string;
  verified_at: string;
}

// ---------- key ----------
function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
function writeJson(file: string, data: unknown, secret = false) {
  fs.mkdirSync(DATA, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), secret ? { mode: 0o600 } : undefined);
  fs.renameSync(tmp, file); // never leave a half-written file
}
const settings = () => readJson<Settings | null>(SETTINGS, null);
const expired = (s: KeyInfo) => !!s.expires_at && s.expires_at <= new Date().toISOString();

/** ok = valid (info set); otherwise reason "invalid", or "unreachable" = no answer (offline, VPN, server down). */
export interface KeyCheck {
  ok: boolean;
  info?: KeyInfo;
  reason?: "invalid" | "unreachable";
  error?: string;
}

/** Ask ads-next whether a key is valid. */
export async function checkKey(key: string): Promise<KeyCheck> {
  if (!KEY_RE.test(key)) return { ok: false, reason: "invalid", error: "That is not an API key. It starts with gsa_ and has 36 characters." };
  try {
    const r = await fetch(ENDPOINT, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
    const body = (await r.json().catch(() => ({}))) as Partial<KeyInfo> & { error?: string };
    if (r.ok && body.user_email) return { ok: true, info: { user_email: body.user_email, project: body.project || "", expires_at: body.expires_at ?? null } };
    if (r.status === 401) return { ok: false, reason: "invalid", error: body.error || "This API key is not valid, has expired or was revoked." };
    return { ok: false, reason: "unreachable", error: `ads-next answered HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, reason: "unreachable", error: `Cannot reach ${UPLOAD_URL} (${(e as Error).message}). Check the network / VPN.` };
  }
}

/** Verify with ads-next, then save. Only a valid key is saved. */
export async function saveKey(key: string) {
  const c = await checkKey(key.trim());
  if (!c.ok) return c;
  writeJson(SETTINGS, { key: key.trim(), ...c.info!, verified_at: new Date().toISOString() } satisfies Settings, true);
  flushQueue();
  return c;
}

export function removeKey() {
  fs.rmSync(SETTINGS, { force: true });
}

/**
 * Gate for /api/run. The saved key is checked with ads-next on every run, so a revoked or expired key
 * stops runs at once. If ads-next cannot be reached, a key that was valid before (and is not past its
 * expiry) may still run; its results wait in the queue.
 */
export async function requireKey(): Promise<{ ok: boolean; error?: string; offline?: string }> {
  const s = settings();
  if (!s) return { ok: false, error: "Add your API key first (ads-next → Search Automation Results → API keys)." };
  if (expired(s)) return { ok: false, error: `Your API key for "${s.project}" has expired. Generate a new one on ads-next and add it here.` };
  const c = await checkKey(s.key);
  if (c.ok) {
    writeJson(SETTINGS, { ...s, ...c.info!, verified_at: new Date().toISOString() } satisfies Settings, true);
    return { ok: true };
  }
  if (c.reason === "invalid") return { ok: false, error: `${c.error} Add a new key.` };
  return { ok: true, offline: `${c.error} Runs are saved and will upload when ads-next is reachable.` };
}

// ---------- queue + sending ----------
const queue = () => readJson<string[]>(QUEUE, []);
let lastResult: { at: string; ok: boolean; message: string } | null = null;
let sending: Promise<void> | null = null;

/** Add finished runs to the upload queue (a run sent again replaces its earlier copy on ads-next). */
export function enqueue(ids: string[]) {
  const q = queue();
  for (const id of ids) if (!q.includes(id)) q.push(id);
  writeJson(QUEUE, q);
}

/** The capture's own timestamp: ads-next keeps the newest capture of a search id. */
function capturedAt(id: string, date: string, time: string): string {
  const meta = readJson<{ capturedAt?: string } | null>(path.join(CAPTURES, `${id}.json`), null);
  if (meta?.capturedAt && !Number.isNaN(Date.parse(meta.capturedAt))) return new Date(meta.capturedAt).toISOString();
  return new Date(`${date}T${time}+05:30`).toISOString();
}
const web = (u: string | null) => (u && /^https?:\/\//i.test(u) ? u : null);

/** The upload body for these stored searches (shared with scripts/upload-results.ts). */
export function payload(ids: string[]) {
  return storedSearches(ids).map((s) => ({
    ...s,
    captured_at: capturedAt(s.search_id, s.search_date, s.search_time),
    extractor_version: null,
    ads: s.status === "ok" ? s.ads.map((a) => ({ ...a, image_url: web(a.image_url), url_of_product: web(a.url_of_product) })) : [],
  }));
}

export interface SendResult {
  status: number; // HTTP status, 0 = unreachable
  error?: string;
  retryAfter?: number;
  user_email?: string;
  stored?: string[];
  stale?: string[];
  conflicts?: string[];
  errors?: { search_id: string | null; error: string }[];
}

/** POST up to 100 searches. */
export async function send(key: string, ids: string[]): Promise<SendResult> {
  try {
    const r = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ api_version: API_VERSION, searches: payload(ids) }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = (await r.json().catch(() => ({}))) as Omit<SendResult, "status">;
    return { ...body, status: r.status, retryAfter: Number(r.headers.get("retry-after")) || undefined };
  } catch (e) {
    return { status: 0, error: `Cannot reach ${UPLOAD_URL} (${(e as Error).message})` };
  }
}

/** Send everything in the queue. One flush at a time; failures stay queued for the next try. */
export function flushQueue(): Promise<void> {
  if (!sending) sending = doFlush().finally(() => (sending = null));
  return sending;
}

async function doFlush() {
  const s = settings();
  if (!s || !queue().length) return;
  let sent = 0;
  for (;;) {
    const batch = queue().slice(0, BATCH);
    if (!batch.length) break;
    const stored = new Set(storedSearches(batch).map((x) => x.search_id));
    const missing = batch.filter((id) => !stored.has(id)); // deleted locally: nothing to send
    const toSend = batch.filter((id) => stored.has(id));
    let done = missing;
    if (toSend.length) {
      const r = await send(s.key, toSend);
      if (r.status !== 200) {
        const why = r.status === 401 ? "the API key is no longer valid; add a new key" : r.error || `HTTP ${r.status}`;
        lastResult = { at: new Date().toISOString(), ok: false, message: `Upload paused: ${why}. ${queue().length} run(s) waiting.` };
        console.warn("[search-automation] upload:", lastResult.message);
        return;
      }
      for (const e of r.errors ?? []) console.warn(`[search-automation] upload rejected ${e.search_id}: ${e.error}`);
      for (const c of r.conflicts ?? []) console.warn(`[search-automation] upload skipped ${c}: uploaded by another user`);
      sent += r.stored?.length ?? 0;
      done = [...done, ...toSend]; // stored, stale, conflict or rejected: resending would not change it
    }
    writeJson(QUEUE, queue().filter((id) => !done.includes(id)));
  }
  lastResult = { at: new Date().toISOString(), ok: true, message: sent ? `Uploaded ${sent} run(s).` : "Up to date." };
}

/** What the Run queries page shows. No part of the key is sent to the browser. */
export function status() {
  const s = settings();
  return {
    url: UPLOAD_URL,
    keyUrl: `${UPLOAD_URL}/search-automation-results/keys`,
    key: s
      ? { user_email: s.user_email, project: s.project, expires_at: s.expires_at, expired: expired(s), verified_at: s.verified_at }
      : null,
    queued: queue().length,
    sending: !!sending,
    last: lastResult,
  };
}

// Retry the queue every minute
setInterval(() => flushQueue(), 60_000).unref();
