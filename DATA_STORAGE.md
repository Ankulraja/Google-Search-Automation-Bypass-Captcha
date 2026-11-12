# Data Storage & Schema (SQLite): new approach

> **Living document.** Everything we discuss and decide about how search data is stored goes here.
> When something is decided, update the table sections **and** add a row to the [Decision log](#decision-log).
> Requirement and business context: [`GOOGLE_ADS_VISIBILITY_REQUIREMENT.md`](GOOGLE_ADS_VISIBILITY_REQUIREMENT.md).

Last updated: 2026-11-12

---

## Tables

| # | Table | Holds | Grain |
|---|---|---|---|
| 1 | `Search_table` | One Google search (what was searched, when, where, how, and whether it worked) | 1 row per search |
| 2 | `Ads_results_table` | Every ad found on that search's results page | 1 row per ad |

```
Search_table (1) ──── search_id ────< (many) Ads_results_table
```

**Every search gets a `Search_table` row, even when no ads are found.** Such a search has `status = 'ok'` and no rows in `Ads_results_table`. It still counts in Total Runs, as a run with no ads.

**Conventions**
- All dates and times are **India time (IST)**.
- Empty / not available = `NULL`.
- File paths are stored **relative** (see `html_path`), never as full paths from one computer.

### Table 1: `Search_table`

| Column | Type | Meaning | Example |
|---|---|---|---|
| `search_id` | TEXT **PK** | Unique id of the search; referenced by `Ads_results_table.search_id` | |
| `mcat_id` | INTEGER | MCAT id from the Platinum list | `9898` |
| `search_keyword` | TEXT | Query typed into Google | `Massage Chair` |
| `search_time` | TEXT | IST time (`HH:MM:SS`) | `10:42:15` |
| `search_date` | TEXT | IST date (`YYYY-MM-DD`) | `2026-11-10` |
| `location` | TEXT | City | `Indore` |
| `ip_address` | TEXT | Public IP used for the search. **Kept empty (NULL) for now.** | `NULL` |
| `device` | TEXT | `mobile` / `desktop` | `mobile` |
| `run_mode` | TEXT | `normal` (logged-in: a copy of the real browser profile) / `incognito` | `incognito` |
| `window_mode` | TEXT | `headed` / `headless` | `headless` |
| `status` | TEXT | `ok` / `captcha` / `error`. **Only `ok` searches are counted in reports.** | `ok` |
| `html_path` | TEXT | Saved page source, **relative to the captures folder** (see below) | `2026-11-10/<search_id>.html` |

### Table 2: `Ads_results_table`

| Column | Type | Meaning | Example |
|---|---|---|---|
| `ad_id` | TEXT **PK** | Unique id of the ad (format under discussion) | |
| `search_id` | TEXT **FK → Search_table** | Which search this ad came from | |
| `ads_type` | TEXT | Kind of ad: `search_ads` / `shopping_ads` / … | `shopping_ads` |
| `title` | TEXT | Search ad: the heading title. Shopping ad: the product title | `Elgi 2 HP Air Compressor 50L` |
| `description` | TEXT | Search ads only: the ad text below the title | |
| `advertiser_name` | TEXT | Store / company name shown on the ad | `Moglix` |
| `domain` | TEXT | Advertiser's domain, **normalised**: lowercase, no `www.`, no path | `moglix.com` |
| `brand` | TEXT | Product brand; NULL unless `brand_status = 'found'` | `Elgi` |
| `brand_status` | TEXT | Why `brand` is or isn't filled: `found` (brand identified) / `not_in_ad` (the ad names no product brand) / `unbranded` (generic product with no brand) / `unresolved` (a brand may be there but couldn't be confirmed) | `found` |
| `price` | INTEGER | Price in rupees, if shown | `14500` |
| `image_url` | TEXT | Product image, **only a real `http(s)` link**; NULL if the image is embedded in the page | |
| `url_of_product` | TEXT | **Real landing page**, decoded from Google's redirect link (`googleadservices.com/aclk?…`); NULL if absent | `https://www.moglix.com/…` |
| `absolute_ads_position` | INTEGER | Rank of the **section** the ad is in, counting every section of the page from the top | `7` |
| `relative_ads_position` | INTEGER | Rank of the ad **inside its section**, starting at 1 | `3` |

### `html_path`: portable location of the saved page

- Stored **relative to the captures folder**, e.g. `2026-11-10/<search_id>.html`, never `/Users/<name>/Desktop/…` or `http://localhost:4000/…`.
- The captures folder itself is a **setting** (default `search-automation/ui/captures/`), so the same database works on any laptop or server. Move the folder, change the setting, and every path still resolves.
- Full path at read time = `<captures folder>/<html_path>`.

### How positions work

The results page is read from top to bottom and split into **sections**: the AI overview, an organic result, an ads block, "People also search", a videos row, a shopping carousel, and so on. Each section gets a rank: 1, 2, 3, …

- **`absolute_ads_position`**: the rank of the section the ad sits in. It shows *where on the page* the ads land.
- **`relative_ads_position`**: the ad's place inside that section. In a shopping section with 5 products they are 1–5. The same applies when several search ads sit together.

**Counting rule (decided):** every organic result is **its own section**. Every other part of the page counts as **one section**, however many items it holds: the AI overview, a block of search ads, People also search, a videos row, a shopping carousel.

Example:

| Section on page | Absolute | Ads stored |
|---|---|---|
| Gemini / AI overview | 1 | none |
| Organic result | 2 | none |
| Organic result | 3 | none |
| Organic result | 4 | none |
| Sponsored search ad(s) | 5 | each ad: absolute 5, relative 1, 2, … |
| People also search | 6 | none |
| Shorts / videos | 7 | none |
| Shopping ads (5 products) | 8 | 5 rows: absolute 8, relative 1–5 |
| Sponsored search ad(s) | 9 | each ad: absolute 9, relative 1, 2, … |

---

## Implementation status (preview)

The two tables are built, filled from **all 914 saved searches** (run of 2026-11-10), and shown on the **Dashboard** page (http://localhost:4000/dashboard), 100 rows per page; CSV / Excel downloads contain every row.

**Current contents:** 914 searches · 4,520 ads (1,378 search ads, 3,142 shopping ads) · 137 searches with no ads. Ad counts match the previous extractor for every search.

**Quality checks passed (all 0 problems):**
- every ad has a title and an advertiser;
- no labels or buttons ("Sponsored", "My Ad Centre", "₹… off", "Call …", "WhatsApp …") are stored as titles or names;
- `relative_ads_position` always runs 1…n inside each section;
- no section mixes search and shopping ads;
- no Google link is stored as `url_of_product`;
- every `domain` is normalised;
- every shopping ad has a price;
- every `html_path` file exists.

**Extraction rules added during the full run:**
- A top or bottom ad area that holds two separate blocks (e.g. a "Featured products" carousel plus a sponsored local-business ad) is split into two sections.
- Prices like "₹1,12,375.38 + tax" are read.
- Call-only, WhatsApp and lead-form ads: the advertiser is the business named in the ad, never the button text. The domain and description are taken from the website and text shown on the ad. When the ad shows no website, `domain` is NULL (70 ads).
- A "People also ask" box that mentions "AI Overview" is not counted as an AI overview.

**Known data notes:** one search has `location = '482001'`, because Google's footer showed a PIN code instead of a city ("482001, Madhya Pradesh").
- Code: `search-automation/ui/search-extract.ts` (page → sections + ads), `search-automation/ui/search-db.ts` (tables, writes, combined query). Database file: `search-automation/ui/data/search_ads.sqlite` (the old `ads.sqlite` is untouched).
- **Provisional until decided** (see open questions): `search_id` = the saved page's id (`<epoch-ms>-<keyword-slug>`); `ad_id` = `<search_id>-<absolute>-<relative>`; `html_path` = file name relative to the captures folder.
- Section types recognised: `search_ads`, `shopping_ads`, `ai_overview`, `organic`, `people_also_ask`, `people_also_search`, `short_videos`, `videos`, `images`, `places`, `popular_products`, `shop_by_store`, `news`, `discussions`, `related_searches`, `other`.
- Known limits, from what Google puts in the page:
  - Shopping images are embedded data, so `image_url` is NULL.
  - Some shopping ads (e.g. IndiaMART's) carry no real landing URL in Google's link, so `url_of_product` is NULL for them.
  - Brands come only from the "advertiser is the brand" rule until a brand list exists.

---

## Open questions

2. **`page_layout` (proposed, not yet agreed).** One extra text column in `Search_table` that lists the sections of the page in order, e.g. `ai_overview > organic > search_ads > people_also_search > videos > shopping_ads > search_ads`. The ads table only records sections that hold ads; this column also records what sits between them. That makes it possible to answer, without re-reading pages, questions like "how often is the AI overview above the first ad?" or "how many organic results come before the shopping ads?".
3. **`ad_id` format.** Proposal: `<search_id>-<absolute>-<relative>`, e.g. `S000123-7-3`. It's readable, unique per page, and the same every time the page is re-extracted.
4. **`search_id` format.** Proposal: a sortable unique id that's safe when several laptops collect data at once. Options: a timestamp plus a short random part, or a UUID.
5. **`ads_type` list.** Fix the full list, e.g. `search_ads`, `shopping_ads`, plus any other sponsored formats to capture (local services, sponsored images, …).
6. **Brand detection.** How `brand` is filled: matching against a known brand list per MCAT, the brand field on shopping cards, or an LLM reading the title. Also what to store when no brand is found.
7. **Browser.** Add `browser` (`chrome` / `brave`) to `Search_table`?
8. **Location detail.** Also store the state, and where the city came from (Google's page footer vs IP lookup)?
9. **Price text.** Also keep the price exactly as shown (`₹14,500`, `₹1.2 lakh`, ranges) next to the number?

---

## Decision log

| # | Date | Decision | Reason |
|---|---|---|---|
| 1 | 2026-11-12 | Start the storage design fresh; the previous schema is dropped | New approach |
| 2 | 2026-11-12 | 2 tables: `Search_table` (1 row per search) and `Ads_results_table` (1 row per ad), linked by `search_id` | |
| 3 | 2026-11-12 | First set of columns for both tables | Initial proposal |
| 4 | 2026-11-12 | Two ad positions: section rank on the page (`absolute_ads_position`) and rank inside the section (`relative_ads_position`) | Shows where on the page ads land, and order within a carousel / ad group |
| 5 | 2026-11-12 | Add `status` (`ok` / `captcha` / `error`) to `Search_table`; only `ok` is counted | A CAPTCHA page must not count as "no ads" |
| 6 | 2026-11-12 | Add `brand` to `Ads_results_table` | Needed for Top 5 brands |
| 7 | 2026-11-12 | Add `ad_id` as primary key of `Ads_results_table` | Every ad row needs its own id |
| 8 | 2026-11-12 | Add `advertiser_name`; store `domain` normalised (lowercase, no `www.`) | Same advertiser always counts as one |
| 9 | 2026-11-12 | `url_of_product` = real landing URL decoded from Google's redirect | The redirect link is not the advertiser's page |
| 10 | 2026-11-12 | `image_url` = real `http(s)` link only; embedded images → NULL | Embedded image data is not a URL |
| 11 | 2026-11-12 | Add `html_path`, stored relative to a configurable captures folder | Works on any machine, not only this MacBook / localhost |
| 12 | 2026-11-12 | `ip_address` kept as a column but left empty (NULL) for now | IP recording is not built yet |
| 13 | 2026-11-12 | `run_mode` `normal` = logged-in (copy of the real browser profile) | Clarified |
| 14 | 2026-11-12 | `search_date` / `search_time` are India time (IST) | Clarified |
| 15 | 2026-11-12 | Section counting: each organic result is its own section; every other part of the page (AI overview, ads block, People also search, videos, shopping carousel) is one section | Fixed rule so every page is numbered the same way |
| 16 | 2026-11-12 | Add `brand_status` (`found` / `not_in_ad` / `unbranded` / `unresolved`) to `Ads_results_table` | Tells "ad has no brand" apart from "brand not detected" |
| 17 | 2026-11-12 | Every search is stored in `Search_table`, including searches where no ads are found | "No ads" is a real result and must be counted |
