# Google Ads Visibility Tracking — Requirement

> Received 2026-11-04. The requirement as shared is below, unchanged, followed by our
> understanding of it and the questions still open.

---

## 1. The requirement (as received)

Hi Team,

To understand the visibility of Google Shopping and Search ads (or both) across our
categories, we need you to track and share this data over a 10-day period. We will
provide a list of 914 Platinum MCATs for this.

For each MCAT, please capture the following data points:

- **Total Runs:** Total number of searches conducted (across multiple IPs).
- **City Count:** Number of distinct cities from which the searches were made.
- **Shopping Ads Count:** Frequency of Google Shopping ads appearing.
- **Search Ads Count:** Frequency of Google Search ads appearing.
- **Search + Shopping Count:** Frequency of both Shopping and Search ads appearing together.
- **Top 5 Brands:** The top 5 brands that appeared, along with their frequencies.
- **Top 5 Advertisers:** The top 5 advertisers that appeared, along with their frequencies.
- **Competitor Details:** Domain or company names of the competitors appearing for these categories.

**10-Day Summary Requirements:**

- Identify which sellers run ads daily vs. occasionally.
- Ensure all data is delivered in a structured format within our tables.
- Stabilize this tracking process in the marketplace.

---

## 2. Our understanding

### The goal

For each of IndiaMART's 914 most important (Platinum) categories, find out **who is
paying Google to appear** when a buyer searches for that product. Measure how often
they show up, from which cities, and whether they appear daily or only now and then.
This shows which competitors and sellers are buying the traffic IndiaMART competes for.

### How it works, in short

1. **Input:** a list of 914 Platinum MCATs, to be provided by the business team. Each one
   becomes a Google search query, e.g. the MCAT name "Industrial Air Compressor".
2. **Every day for 10 days:** search each MCAT on Google several times, from different
   IPs and cities across India.
3. **On every results page, record:**
   - whether **Shopping ads** appeared (the product carousel with image, price and store);
   - whether **Search ads** appeared (the text results marked "Sponsored");
   - for each ad: the **advertiser** (the store or domain that paid, e.g. `amazon.in`,
     `moglix.com`), the **brand** of the product (e.g. Bosch, Atlas Copco), and the
     landing domain.
4. **Roll up per MCAT, per day and over the 10 days** into the agreed tables.

### Output per MCAT

| Field | Meaning |
|---|---|
| Total Runs | Number of Google searches made for this MCAT |
| City Count | Number of distinct cities those searches came from |
| Shopping Ads Count | Runs where Shopping ads appeared |
| Search Ads Count | Runs where Search (text) ads appeared |
| Search + Shopping Count | Runs where both appeared on the same page |
| Top 5 Brands | Product brands seen most often in the ads, with counts |
| Top 5 Advertisers | Stores/domains that paid for ads most often, with counts |
| Competitor Details | Every advertiser domain or company that is not IndiaMART |

**Note on the counts:** Shopping, Search and Search + Shopping overlap, because a run
with both ad types adds one to all three. "Search only" and "Shopping only" can be
derived from them, and a run with no ads is `Total Runs − (Shopping + Search − Both)`.

### 10-day summary

- **Daily vs. occasional advertisers:** for each advertiser and MCAT, count the days out
  of 10 the advertiser appeared. For example, 9–10 days could be *daily*, 3–8 days
  *frequent*, and 1–2 days *occasional*. These thresholds still need to be agreed.
- **Structured delivery:** the data goes into IndiaMART's own tables, not a one-off sheet.
- **Stabilize:** this should become a repeatable, reliable process, not a manual one-time
  exercise.

### Scale

914 MCATs × N runs per MCAT per day × 10 days. At 5 runs per day that is about
**4,570 searches a day** and **45,700 in total**, each from a rotated IP and city.

---

## 3. Per-run storage (SQLite)

**Decided:** the search query is the MCAT name exactly as written, one query per MCAT.
Storage is **SQLite** on the server that hosts the tracker. Screenshots and HTML are
files on disk; the database stores only their paths.

Every run is stored raw. All the counts in section 2 are computed from these two tables
later, so a new question can be answered without searching again.

### Table `runs` — one row per Google search

| Column | Type | Example |
|---|---|---|
| `run_id` | TEXT PK | `R0001` |
| `mcat_id` | INTEGER | `12345` |
| `mcat_name` | TEXT | `Air Compressor` (this is also the search query) |
| `run_date` | TEXT | `2026-11-05` |
| `run_time` | TEXT | `10:42:15` |
| `day_no` | INTEGER | `1` (day 1–10) |
| `city` | TEXT | `Delhi` |
| `ip_address` | TEXT | `103.21.x.x` |
| `device` | TEXT | `desktop` / `mobile` |
| `status` | TEXT | `ok` / `captcha` / `error` (only `ok` runs are counted) |
| `has_shopping_ads` | INTEGER | `1` / `0` |
| `has_search_ads` | INTEGER | `1` / `0` |
| `shopping_ads_seen` | INTEGER | `5` |
| `search_ads_seen` | INTEGER | `2` |
| `screenshot_path` | TEXT | `shots/2026-11-05/R0001.avif` |
| `html_path` | TEXT | `html/2026-11-05/R0001.html.zst` |
| `zstd_dict_id` | INTEGER | `1` (the zstd dictionary the HTML was compressed with) |

### Table `ads` — one row per ad seen in a run

| Column | Type | Example |
|---|---|---|
| `ad_id` | TEXT PK | `A0001` |
| `run_id` | TEXT FK → runs | `R0001` |
| `ad_type` | TEXT | `shopping` / `search` |
| `position` | INTEGER | `1` |
| `advertiser_name` | TEXT | `Moglix` |
| `advertiser_domain` | TEXT | `moglix.com` (normalised: no `www.`, lowercase) |
| `brand` | TEXT NULL | `Elgi` (canonical name; NULL unless `brand_status = 'found'`) |
| `brand_status` | TEXT | `found` / `not_in_ad` / `unbranded` / `unresolved` |
| `brand_source` | TEXT NULL | `title_match` / `ad_detail` / `advertiser_is_brand` / `landing_page` / `llm` |
| `brand_raw` | TEXT NULL | `ELGI EQUIPMENTS` (text exactly as seen, before normalising) |
| `title` | TEXT | `Elgi 2 HP Air Compressor 50L` |
| `price` | INTEGER NULL | `14500` (shopping ads only) |
| `landing_url` | TEXT | `https://www.moglix.com/…` |
| `is_indiamart` | INTEGER | `0` |

A run with no ads has one `runs` row and no `ads` rows.

### Table `brand_alias` — spelling variants → one brand

| Column | Type | Example |
|---|---|---|
| `alias` | TEXT PK (lowercase) | `elgi equipments` |
| `brand` | TEXT | `Elgi` |
| `mcat_id` | INTEGER NULL | NULL = valid for every MCAT |

### When the brand cannot be identified

Brand detection runs as a ladder and stops at the first step that finds one:

1. **Title match:** the ad title contains a known brand or alias from `brand_alias`
   (seeded from IndiaMART's own brand data per MCAT). Cheap and exact.
2. **Ad detail:** a "Brand" field in the Shopping card or product panel, when shown.
3. **Advertiser is the brand:** the advertiser's domain belongs to a manufacturer
   (e.g. `elgi.com`), so advertiser and brand are the same.
4. **Landing page** (optional, unknowns only, run as a later batch): the product page's
   structured data (`schema.org Product → brand`).
5. **LLM fallback:** a model reads the title and returns a brand **only if it is written
   in that title**, never a guess. Results land in `brand_alias` for review, so the same
   name is matched by step 1 next time.

If nothing matches, `brand` stays NULL and `brand_status` records why:

| `brand_status` | Meaning | Example |
|---|---|---|
| `not_in_ad` | The ad names no product brand | tradeindia text ad "Air Compressor Manufacturers" |
| `unbranded` | Generic or local product with no brand | "Heavy Duty 2 HP Air Compressor" |
| `unresolved` | A brand may be there but could not be confirmed | "KCX-2 Pro 50L" |

**Rules:**
- **Never guess**, and never use the advertiser as the brand (Moglix is not a brand,
  except in step 3).
- **Top 5 Brands counts only `found` ads.** Unknown is not a brand, so it never takes a
  top-5 slot.
- **Always report coverage beside the Top 5**, e.g. *"Brand identified in 72% of ads
  (not in ad 18%, unbranded 6%, unresolved 4%)"*, so a reader knows how much the list
  rests on.
- **Fewer than 5 brands found → show only those** ("Only 3 brands found"). Do not pad.
- **High unknown share** (e.g. > 30% `unresolved` for an MCAT) → flag that MCAT for a
  person to review and add aliases. The raw title, screenshot and HTML are stored, so it
  can be re-run without searching again.

### How each metric is derived

| Metric | From |
|---|---|
| Total Runs | `runs` rows with `status = 'ok'` |
| City Count | distinct `runs.city` |
| Shopping Ads Count | `runs` with `has_shopping_ads = 1` |
| Search Ads Count | `runs` with `has_search_ads = 1` |
| Search + Shopping | `runs` with both = 1 |
| Top 5 Brands | `ads` with `brand_status = 'found'`, grouped by `brand` (+ coverage %) |
| Top 5 Advertisers | `ads` grouped by `advertiser_domain` |
| Competitors | distinct `ads.advertiser_domain` where `is_indiamart = 0` |
| Daily vs occasional | distinct `runs.run_date` per advertiser per MCAT |

### Approximate storage (914 MCATs × 5 runs/day × 10 days ≈ 45,700 runs)

| Item | Per run | 10 days |
|---|---|---|
| SQLite `runs` (~45,700 rows, with indexes) | ~0.3 KB | ~15 MB |
| SQLite `ads` (~3 lakh rows at ~6–7 ads/run, with indexes) | ~2.5 KB | ~120 MB |
| **SQLite total** | | **~150 MB** |
| Screenshot, **AVIF** (q50, effort 6, 4:4:4 chroma), top of page only | ~60–120 KB | **~2.7–5.5 GB** |
| HTML, **zstd -19 with a trained dictionary** | ~30–60 KB | **~1.4–2.7 GB** |
| **Everything** | ~0.1–0.2 MB | **~4.5–8.5 GB** |

Ongoing after the 10 days: about **0.45–0.85 GB a day**.

**Screenshots: AVIF.** Measured on one of our 1500 px mock result pages: PNG 371 KB,
JPEG q70 117 KB, WebP q70 93 KB, **AVIF q50 68 KB** (q60: 83 KB). Real pages carry
product photos, hence the 60–120 KB range. Use 4:4:4 chroma so small text stays
readable. Playwright captures PNG; `sharp` (already in the repo, AVIF supported)
converts it. JPEG XL compresses slightly better but Chrome cannot display it, and the
evidence has to open in a browser.

**HTML: zstd with a dictionary.** Google result pages repeat the same large inline
JS/CSS on every run, which per-file compression cannot exploit. Typical sizes for a
~1 MB result page:

| Method | Per page (approx.) |
|---|---|
| gzip -9 | ~180–220 KB |
| brotli -11 | ~140–170 KB |
| zstd -19 | ~150–180 KB |
| **zstd -19 + trained dictionary** | **~30–60 KB** |

Train the dictionary once on the first ~500–1,000 pages (`zstd --train`), keep it
under version (`zstd_dict_id`), and retrain when Google changes its page layout.
Every file stays independently readable, unlike one big compressed archive per day.

**Node version on the server:** `zlib.zstdCompress` exists only in Node ≥ 22.15 / 23.8.
The server runs Node 20, so use the `zstd` CLI or a native package there, or brotli
(built into Node 20) as the fallback.

All sizes are estimates; measure the first 50–100 real runs and correct them.

---

## 4. Points to confirm before building

1. ~~**Search query:**~~ Decided: the MCAT name as written, one query per MCAT.
2. **Runs per MCAT per day:** how many, and how evenly spread across the day?
3. **Cities:** which cities, and how many? Does "city" mean the IP's city, Google's
   location setting, or both?
4. **Device:** desktop, mobile, or both? Ads differ between them.
5. **Brand vs. advertiser:** we read *brand* as the product's manufacturer and
   *advertiser* as the seller or domain paying for the ad. Is that right?
6. **Competitors:** is that every non-IndiaMART advertiser, or a known list (TradeIndia,
   Amazon Business, Moglix, Udaan, JustDial, …)?
7. **"Sellers run ads daily":** does *sellers* mean the advertisers seen on Google, or
   IndiaMART's own paid sellers matched against them?
8. **Target tables:** which database or schema, and who owns it?
9. **Collection method:** automated Google searches from rotating IPs trigger CAPTCHAs
   and go against Google's terms of service. A licensed SERP-data API (e.g. SerpApi,
   DataForSEO), which returns ads per location, or Google's Ads Transparency Center may
   be the safer and more stable route. This needs a decision before building.
10. **Start date and timeline** for the 10-day window.
