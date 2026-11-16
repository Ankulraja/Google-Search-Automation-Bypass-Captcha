/**
 * Upload the local search results (ui/data/search_ads.sqlite) to the central
 * Search Automation Results store in ads-next, in one go.
 *
 *   GSA_API_KEY=gsa_… npm run upload                 # every stored search
 *   GSA_API_KEY=gsa_… npm run upload -- --since 2026-11-01
 *   GSA_UPLOAD_URL=http://127.0.0.1:3005 …           # another ads-next (default https://ads.intermesh.net)
 *
 * Without GSA_API_KEY the key saved on the Run queries page is used. New runs upload by
 * themselves (ui/upload.ts); this is for sending everything at once. Sending a search
 * again is safe: the server replaces it, and an older capture never overwrites a newer one.
 */
import fs from "fs";
import path from "path";
import { allSearchIds, storedSearches } from "../ui/search-db";
import { checkKey, send, UPLOAD_URL } from "../ui/upload";

const BATCH = 100;
const saved = (() => {
  try {
    return (JSON.parse(fs.readFileSync(path.join(__dirname, "..", "ui", "data", "upload.json"), "utf8")) as { key?: string }).key || "";
  } catch {
    return "";
  }
})();
const key = (process.env.GSA_API_KEY || saved).trim();
const sinceIdx = process.argv.indexOf("--since");
const since = sinceIdx > -1 ? process.argv[sinceIdx + 1] : "";
if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
  console.error("--since must be YYYY-MM-DD");
  process.exit(1);
}

async function main() {
  const c = await checkKey(key);
  if (!c.ok) {
    console.error(key ? c.error : "Set GSA_API_KEY, or save a key on the Run queries page.");
    process.exit(1);
  }
  const info = c.info!;
  let ids = allSearchIds();
  if (since) ids = storedSearches(ids).filter((s) => s.search_date >= since).map((s) => s.search_id);
  console.log(`Uploading ${ids.length} searches to ${UPLOAD_URL} as ${info.user_email} (project "${info.project}")…`);
  const totals = { stored: 0, stale: 0, conflicts: 0, errors: 0 };
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    let r = await send(key, batch);
    for (let attempt = 1; attempt < 4 && (r.status === 0 || r.status === 429 || r.status >= 500); attempt++) {
      const wait = r.status === 429 ? r.retryAfter || 10 : 2 * attempt;
      console.warn(`  batch ${i / BATCH + 1}: ${r.error || `HTTP ${r.status}`}, retrying in ${wait} s`);
      await new Promise((res) => setTimeout(res, wait * 1000));
      r = await send(key, batch);
    }
    if (r.status !== 200) {
      console.error(`Upload stopped (HTTP ${r.status}): ${r.error || "unknown error"}. Run again; already-sent searches are safe to resend.`);
      process.exit(1);
    }
    totals.stored += r.stored?.length ?? 0;
    totals.stale += r.stale?.length ?? 0;
    totals.conflicts += r.conflicts?.length ?? 0;
    totals.errors += r.errors?.length ?? 0;
    for (const e of r.errors ?? []) console.warn(`  ${e.search_id ?? "?"}: ${e.error}`);
    for (const x of r.conflicts ?? []) console.warn(`  ${x}: already uploaded by another user, skipped`);
    console.log(`  batch ${i / BATCH + 1}: ${r.stored?.length ?? 0} stored`);
  }
  console.log(`Done. Stored ${totals.stored}, kept newer copy ${totals.stale}, other user's id ${totals.conflicts}, rejected ${totals.errors}.`);
}

main();
