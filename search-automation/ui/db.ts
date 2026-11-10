import fs from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import { EXTRACTOR_VERSION, extractFromHtml, resolveBrand } from "./extract";

// SQLite store for the Google ads visibility data (tables from GOOGLE_ADS_VISIBILITY_REQUIREMENT.md, section 3).
// Every row is derived from a saved capture (.html + .json), so the whole database can be rebuilt from captures/.
const DATA_DIR = path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
export const DB_PATH = path.join(DATA_DIR, "ads.sqlite");
const db = new DatabaseSync(DB_PATH);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS runs (
  run_id            TEXT PRIMARY KEY,      -- capture id, e.g. 1794289671808-heater
  mcat_id           INTEGER,               -- the number typed before the query (NULL if none)
  mcat_name         TEXT NOT NULL,         -- the search query
  keyword_key       TEXT NOT NULL,         -- groups runs of one keyword: 'mcat:<id>' or 'q:<lowercase query>'
  run_date          TEXT NOT NULL,         -- YYYY-MM-DD (India time)
  run_time          TEXT NOT NULL,         -- HH:MM:SS (India time)
  day_no            INTEGER,               -- day 1-10 of the tracking window (set once the window starts)
  city              TEXT,                  -- from Google's footer, e.g. Indore
  region            TEXT,                  -- e.g. Madhya Pradesh
  location_source   TEXT,                  -- ip / device / other: how Google located the search
  ip_address        TEXT,                  -- not in the page source; NULL until IP rotation records it
  device            TEXT NOT NULL,         -- desktop / mobile
  browser           TEXT,
  mode              TEXT,                  -- logged-in / incognito
  status            TEXT NOT NULL,         -- ok / captcha / error (only ok runs are counted)
  has_shopping_ads  INTEGER NOT NULL DEFAULT 0,
  has_search_ads    INTEGER NOT NULL DEFAULT 0,
  shopping_ads_seen INTEGER NOT NULL DEFAULT 0,
  search_ads_seen   INTEGER NOT NULL DEFAULT 0,
  screenshot_path   TEXT,                  -- not stored (source only)
  html_path         TEXT NOT NULL,
  zstd_dict_id      INTEGER,               -- set once HTML is compressed
  captured_at       TEXT NOT NULL,         -- ISO timestamp
  extractor_version INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_keyword ON runs(keyword_key, run_date);

CREATE TABLE IF NOT EXISTS ads (
  ad_id             TEXT PRIMARY KEY,      -- <run_id>-s1 (shopping #1) / <run_id>-t2 (search #2)
  run_id            TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  ad_type           TEXT NOT NULL,         -- shopping / search
  position          INTEGER NOT NULL,
  placement         TEXT,                  -- top (#tads) / other ad block / bottom (#bottomads)
  advertiser_name   TEXT,
  advertiser_domain TEXT,
  brand             TEXT,
  brand_status      TEXT NOT NULL,         -- found / not_in_ad / unbranded / unresolved
  brand_source      TEXT,                  -- title_match / ad_detail / advertiser_is_brand / landing_page / llm
  brand_raw         TEXT,
  title             TEXT,
  price             INTEGER,
  landing_url       TEXT,
  is_indiamart      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ads_run ON ads(run_id);
CREATE INDEX IF NOT EXISTS ads_domain ON ads(advertiser_domain);

CREATE TABLE IF NOT EXISTS brand_alias (
  alias   TEXT PRIMARY KEY,                -- lowercase spelling as seen in titles
  brand   TEXT NOT NULL,                   -- canonical brand name
  mcat_id INTEGER                          -- NULL = valid for every MCAT
);
`);

/** The parts of a capture's .json that the database needs. */
export interface CaptureMeta {
  id: string;
  query: string;
  tag?: string;
  device?: string;
  browser?: string;
  mode?: string;
  capturedAt: string;
  captcha: boolean;
}

const keywordKey = (m: { tag?: string; query: string }) =>
  m.tag && /^\d+$/.test(m.tag) ? `mcat:${m.tag}` : `q:${m.query.trim().toLowerCase()}`;

const IST = { timeZone: "Asia/Kolkata" } as const;
const dateIST = (d: Date) => d.toLocaleDateString("en-CA", IST); // YYYY-MM-DD
const timeIST = (d: Date) => d.toLocaleTimeString("en-GB", { ...IST, hour12: false });

function aliasesFor(mcatId: number | null) {
  const rows = db
    .prepare("SELECT alias, brand FROM brand_alias WHERE mcat_id IS NULL OR mcat_id = ? ORDER BY length(alias) DESC")
    .all(mcatId) as { alias: string; brand: string }[];
  return rows;
}

/** Extract ads from one capture's source and (re)write its rows. */
export function indexCapture(meta: CaptureMeta, html: string, htmlPath: string) {
  const x = extractFromHtml(html);
  const mcatId = meta.tag && /^\d+$/.test(meta.tag) ? Number(meta.tag) : null;
  const aliases = aliasesFor(mcatId);
  const shopping = x.ads.filter((a) => a.type === "shopping").length;
  const search = x.ads.filter((a) => a.type === "search").length;
  const when = new Date(meta.capturedAt);

  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM runs WHERE run_id = ?").run(meta.id); // cascades to ads
    db.prepare(
      `INSERT INTO runs (run_id, mcat_id, mcat_name, keyword_key, run_date, run_time, city, region, location_source,
        device, browser, mode, status, has_shopping_ads, has_search_ads, shopping_ads_seen, search_ads_seen,
        html_path, captured_at, extractor_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      meta.id, mcatId, meta.query, keywordKey(meta), dateIST(when), timeIST(when), x.city, x.region, x.locationSource,
      meta.device || "desktop", meta.browser || null, meta.mode || null, meta.captcha ? "captcha" : "ok",
      shopping ? 1 : 0, search ? 1 : 0, shopping, search, htmlPath, meta.capturedAt, EXTRACTOR_VERSION
    );
    const ins = db.prepare(
      `INSERT INTO ads (ad_id, run_id, ad_type, position, placement, advertiser_name, advertiser_domain, brand,
        brand_status, brand_source, brand_raw, title, price, landing_url, is_indiamart)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const a of x.ads) {
      const b = resolveBrand(a, aliases);
      ins.run(
        `${meta.id}-${a.type === "shopping" ? "s" : "t"}${a.position}`, meta.id, a.type, a.position, a.placement,
        a.advertiserName, a.advertiserDomain, b.brand, b.status, b.source, b.raw, a.title, a.price, a.landingUrl,
        a.isIndiamart ? 1 : 0
      );
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function deleteRun(id: string) {
  db.prepare("DELETE FROM runs WHERE run_id = ?").run(id);
}

/** Index every capture that is missing or was indexed by an older extractor. `force` re-indexes all. */
export function syncCaptures(capturesDir: string, force = false) {
  const have = new Map(
    (db.prepare("SELECT run_id, extractor_version FROM runs").all() as { run_id: string; extractor_version: number }[]).map((r) => [
      r.run_id,
      r.extractor_version,
    ])
  );
  const ids = fs.readdirSync(capturesDir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
  let indexed = 0;
  for (const id of ids) {
    if (!force && have.get(id) === EXTRACTOR_VERSION) continue;
    const htmlFile = path.join(capturesDir, `${id}.html`);
    if (!fs.existsSync(htmlFile)) continue;
    const meta = JSON.parse(fs.readFileSync(path.join(capturesDir, `${id}.json`), "utf8")) as CaptureMeta;
    indexCapture(meta, fs.readFileSync(htmlFile, "utf8"), `captures/${id}.html`);
    indexed++;
  }
  // Drop rows whose capture files were removed
  const keep = new Set(ids);
  for (const id of have.keys()) if (!keep.has(id)) deleteRun(id);
  return { indexed, total: ids.length };
}

/** Everything the Ads tab shows for one capture: this run's ads + metrics for all runs of the same keyword. */
export function keywordReport(runId: string) {
  const run = db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as Record<string, any> | undefined;
  if (!run) return null;
  const key = run.keyword_key;

  const metrics = db
    .prepare(
      `SELECT COUNT(*) AS total_runs,
              COUNT(DISTINCT city) AS city_count,
              SUM(has_shopping_ads) AS shopping_runs,
              SUM(has_search_ads) AS search_runs,
              SUM(has_shopping_ads AND has_search_ads) AS both_runs,
              SUM(NOT has_shopping_ads AND NOT has_search_ads) AS no_ad_runs,
              COUNT(DISTINCT run_date) AS days
         FROM runs WHERE keyword_key = ? AND status = 'ok'`
    )
    .get(key);
  const skipped = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE keyword_key = ? AND status <> 'ok'").get(key) as { n: number };
  const cities = db
    .prepare(
      `SELECT COALESCE(city, 'Unknown') AS city, region, COUNT(*) AS runs FROM runs
        WHERE keyword_key = ? AND status = 'ok' GROUP BY city ORDER BY runs DESC`
    )
    .all(key);

  // ads of ok runs for this keyword
  const FROM = `FROM ads a JOIN runs r ON r.run_id = a.run_id WHERE r.keyword_key = ? AND r.status = 'ok'`;
  const topAdvertisers = db
    .prepare(
      `SELECT a.advertiser_domain AS domain, COALESCE(MAX(CASE WHEN a.advertiser_name <> a.advertiser_domain THEN a.advertiser_name END), a.advertiser_domain) AS name,
              COUNT(DISTINCT a.run_id) AS runs, COUNT(*) AS ads,
              SUM(a.ad_type = 'shopping') AS shopping_ads, SUM(a.ad_type = 'search') AS search_ads,
              MAX(a.is_indiamart) AS is_indiamart
         ${FROM} GROUP BY a.advertiser_domain ORDER BY runs DESC, ads DESC LIMIT 5`
    )
    .all(key);
  const topBrands = db
    .prepare(`SELECT a.brand, COUNT(*) AS ads, COUNT(DISTINCT a.run_id) AS runs ${FROM} AND a.brand_status = 'found'
              GROUP BY a.brand ORDER BY ads DESC, runs DESC LIMIT 5`)
    .all(key);
  const brandCoverage = db.prepare(`SELECT a.brand_status AS status, COUNT(*) AS ads ${FROM} GROUP BY a.brand_status`).all(key);
  const competitors = db
    .prepare(
      `SELECT a.advertiser_domain AS domain, COALESCE(MAX(CASE WHEN a.advertiser_name <> a.advertiser_domain THEN a.advertiser_name END), a.advertiser_domain) AS name,
              GROUP_CONCAT(DISTINCT a.ad_type) AS ad_types,
              COUNT(DISTINCT a.run_id) AS runs, COUNT(DISTINCT r.run_date) AS days,
              MIN(r.run_date) AS first_seen, MAX(r.run_date) AS last_seen
         ${FROM} AND a.is_indiamart = 0 GROUP BY a.advertiser_domain ORDER BY runs DESC, domain`
    )
    .all(key);
  const runs = db
    .prepare(
      `SELECT run_id, run_date, run_time, city, device, browser, mode, status, shopping_ads_seen, search_ads_seen
         FROM runs WHERE keyword_key = ? ORDER BY captured_at DESC`
    )
    .all(key);
  const ads = db.prepare("SELECT * FROM ads WHERE run_id = ? ORDER BY ad_type, position").all(runId);
  // Every ad seen across the counted runs of this keyword (for the Shopping / Search sections)
  const keywordAds = db
    .prepare(
      `SELECT a.*, r.run_date, r.run_time, r.city, r.device ${FROM}
        ORDER BY r.captured_at DESC, a.ad_type, a.position`
    )
    .all(key);

  return { run, metrics, skippedRuns: skipped.n, cities, topAdvertisers, topBrands, brandCoverage, competitors, runs, ads, keywordAds };
}
