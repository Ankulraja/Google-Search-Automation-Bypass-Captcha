import fs from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import { extractPage } from "./search-extract";

// New-approach storage (DATA_STORAGE.md): two tables, Search_table (1 row per search) and
// Ads_results_table (1 row per ad), in their own file so the old ads.sqlite is untouched.
const DATA_DIR = path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
export const SEARCH_DB_PATH = path.join(DATA_DIR, "search_ads.sqlite");
const db = new DatabaseSync(SEARCH_DB_PATH);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS Search_table (
  search_id      TEXT PRIMARY KEY,
  mcat_id        INTEGER,
  search_keyword TEXT NOT NULL,
  search_time    TEXT NOT NULL,          -- IST HH:MM:SS
  search_date    TEXT NOT NULL,          -- IST YYYY-MM-DD
  location       TEXT,                   -- city
  ip_address     TEXT,                   -- NULL for now
  device         TEXT NOT NULL,          -- mobile / desktop
  run_mode       TEXT NOT NULL,          -- normal / incognito
  window_mode    TEXT NOT NULL,          -- headed / headless
  status         TEXT NOT NULL,          -- ok / captcha / error
  html_path      TEXT                    -- relative to the captures folder
);
CREATE INDEX IF NOT EXISTS search_mcat_date ON Search_table(mcat_id, search_date);

CREATE TABLE IF NOT EXISTS Ads_results_table (
  ad_id                 TEXT PRIMARY KEY,  -- <search_id>-<absolute>-<relative>
  search_id             TEXT NOT NULL REFERENCES Search_table(search_id) ON DELETE CASCADE,
  ads_type              TEXT NOT NULL,     -- search_ads / shopping_ads
  title                 TEXT,
  description           TEXT,
  advertiser_name       TEXT,
  domain                TEXT,              -- lowercase, no www.
  brand                 TEXT,
  brand_status          TEXT NOT NULL,     -- found / not_in_ad / unbranded / unresolved
  price                 INTEGER,
  image_url             TEXT,
  url_of_product        TEXT,
  absolute_ads_position INTEGER NOT NULL,
  relative_ads_position INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ads_search ON Ads_results_table(search_id);
CREATE INDEX IF NOT EXISTS ads_domain ON Ads_results_table(domain);
`);

export interface SearchMeta {
  id: string;
  query: string;
  tag?: string;
  device?: string;
  mode?: string; // logged-in / incognito
  headless?: boolean;
  capturedAt: string;
  captcha: boolean;
}

const IST = { timeZone: "Asia/Kolkata" } as const;

/** Parse one saved page and (re)write its Search_table row and Ads_results_table rows. */
// Embedded pictures are saved here; image_url then holds "images/<ad_id>.<ext>" (relative to the captures folder, like html_path)
export const IMAGES_SUBDIR = "images";
function saveEmbeddedImage(capturesDir: string, adId: string, dataUri: string): string | null {
  const m = dataUri.match(/^data:image\/(webp|jpe?g|png|gif);base64,(.+)$/);
  if (!m) return null;
  const ext = m[1] === "jpeg" ? "jpg" : m[1];
  const dir = path.join(capturesDir, IMAGES_SUBDIR);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${adId}.${ext}`;
  fs.writeFileSync(path.join(dir, name), Buffer.from(m[2], "base64"));
  return `${IMAGES_SUBDIR}/${name}`;
}

export function indexSearch(meta: SearchMeta, html: string, htmlPath: string, capturesDir?: string) {
  const page = extractPage(html);
  const when = new Date(meta.capturedAt);
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM Search_table WHERE search_id = ?").run(meta.id); // cascades to its ads
    db.prepare(
      `INSERT INTO Search_table (search_id, mcat_id, search_keyword, search_time, search_date, location, ip_address,
         device, run_mode, window_mode, status, html_path) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`
    ).run(
      meta.id,
      meta.tag && /^\d+$/.test(meta.tag) ? Number(meta.tag) : null,
      meta.query,
      when.toLocaleTimeString("en-GB", { ...IST, hour12: false }),
      when.toLocaleDateString("en-CA", IST),
      page.city,
      meta.device || "desktop",
      meta.mode === "incognito" ? "incognito" : "normal",
      meta.headless ? "headless" : "headed",
      meta.captcha ? "captcha" : "ok",
      htmlPath
    );
    if (!meta.captcha) {
      const ins = db.prepare(
        `INSERT INTO Ads_results_table (ad_id, search_id, ads_type, title, description, advertiser_name, domain, brand,
           brand_status, price, image_url, url_of_product, absolute_ads_position, relative_ads_position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const s of page.sections)
        for (const a of s.ads) {
          const adId = `${meta.id}-${s.rank}-${a.relative_ads_position}`;
          // web link if Google gave one, otherwise the picture embedded in the page, saved as a file
          const image = a.image_url || (a.image_data && capturesDir ? saveEmbeddedImage(capturesDir, adId, a.image_data) : null);
          ins.run(
            adId, meta.id, a.ads_type, a.title, a.description, a.advertiser_name,
            a.domain, a.brand, a.brand_status, a.price, image, a.url_of_product, s.rank, a.relative_ads_position
          );
        }
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Make sure the first `limit` searches (oldest first) are in the tables. Already-stored ones are skipped unless `rebuild`. */
export function ensureIndexed(capturesDir: string, limit: number, rebuild = false) {
  const metas = fs
    .readdirSync(capturesDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(capturesDir, f), "utf8")) as SearchMeta)
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
    .slice(0, limit);
  const has = db.prepare("SELECT 1 FROM Search_table WHERE search_id = ?");
  let indexed = 0;
  for (const m of metas) {
    if (!rebuild && has.get(m.id)) continue;
    const file = path.join(capturesDir, `${m.id}.html`);
    if (!fs.existsSync(file)) continue;
    indexSearch(m, fs.readFileSync(file, "utf8"), `${m.id}.html`, capturesDir);
    indexed++;
  }
  return { ids: metas.map((m) => m.id), indexed };
}

/** Combined view: Search_table LEFT JOIN Ads_results_table, one row per ad (a search with no ads = one row, ad columns empty). */
export function dashboardRows(ids: string[]) {
  if (!ids.length) return { rows: [], searches: 0, ads: 0, noAdSearches: 0 };
  const ph = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT s.search_id, s.mcat_id, s.search_keyword, s.search_date, s.search_time, s.location, s.ip_address,
              s.device, s.run_mode, s.window_mode, s.status, s.html_path,
              a.ad_id, a.ads_type, a.absolute_ads_position, a.relative_ads_position, a.title, a.description,
              a.advertiser_name, a.domain, a.brand, a.brand_status, a.price, a.image_url, a.url_of_product
         FROM Search_table s
         LEFT JOIN Ads_results_table a ON a.search_id = s.search_id
        WHERE s.search_id IN (${ph})
        ORDER BY s.search_date, s.search_time, a.absolute_ads_position, a.relative_ads_position`
    )
    .all(...ids);
  const c = db
    .prepare(
      `SELECT COUNT(*) AS searches,
              (SELECT COUNT(*) FROM Ads_results_table WHERE search_id IN (${ph})) AS ads,
              SUM(NOT EXISTS (SELECT 1 FROM Ads_results_table a WHERE a.search_id = s.search_id)) AS noAdSearches
         FROM Search_table s WHERE s.search_id IN (${ph})`
    )
    .get(...ids, ...ids) as { searches: number; ads: number; noAdSearches: number };
  return { rows, ...c };
}
