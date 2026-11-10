import * as cheerio from "cheerio";

// Reads a saved Google results page (the .html source) and pulls out the ads data.
// Bump this when the extraction logic changes: older rows in SQLite are then re-extracted.
export const EXTRACTOR_VERSION = 3;

export type AdType = "shopping" | "search";
export type BrandStatus = "found" | "not_in_ad" | "unbranded" | "unresolved";
export type BrandSource = "title_match" | "ad_detail" | "advertiser_is_brand" | "landing_page" | "llm";

export interface ExtractedAd {
  type: AdType;
  position: number; // 1-based, per ad type, in page order
  placement: "top" | "other" | "bottom"; // #tads / any other ad block (e.g. a product carousel) / #bottomads
  advertiserName: string;
  advertiserDomain: string; // lowercase, no www.
  title: string;
  price: number | null; // shopping ads only, in rupees
  landingUrl: string;
  isIndiamart: boolean;
}

export interface Extracted {
  city: string | null; // e.g. "Indore"
  region: string | null; // e.g. "Madhya Pradesh"
  locationSource: "ip" | "device" | "other" | null; // how Google worked out the location
  ads: ExtractedAd[];
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const normDomain = (d: string) => d.trim().toLowerCase().replace(/^www\./, "").replace(/\/.*$/, "");
const hostOf = (u: string) => {
  try { return normDomain(new URL(u).hostname); } catch { return ""; }
};
const absGoogle = (h: string) => (!h ? "" : h.startsWith("/") ? "https://www.google.com" + h : h);
const isIndiamart = (d: string) => d === "indiamart.com" || d.endsWith(".indiamart.com");
const placementOf = (el: cheerio.Cheerio<any>): ExtractedAd["placement"] =>
  el.closest("#tads").length ? "top" : el.closest("#bottomads").length ? "bottom" : "other";
const PRICE = /^₹\s?([\d,]+(?:\.\d+)?)$/;

export function extractFromHtml(html: string): Extracted {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();

  const leaves = (root: cheerio.Cheerio<any>) => {
    const out: string[] = [];
    root.find("*").each((_, e) => {
      if ($(e).children().length === 0) {
        const t = clean($(e).text());
        if (t) out.push(t);
      }
    });
    return out;
  };
  const outermost = (sel: string) => $(sel).filter((_, e) => $(e).parents(sel).length === 0);

  // ---------- Shopping ads (product cards with price + store) ----------
  const ads: ExtractedAd[] = [];
  const seen = new Set<string>();
  let pos = 0;
  outermost("[data-offer-id][data-dtld], .pla-unit[data-dtld]").each((_, el) => {
    const u = $(el);
    const domain = normDomain(u.attr("data-dtld") || "");
    const key = `${u.attr("data-merchant-id") || domain}|${u.attr("data-offer-id") || u.attr("data-offer-docid") || ""}`;
    if (seen.has(key)) return; // the same offer can appear twice (carousel copies)
    seen.add(key);

    const texts = leaves(u);
    const titleId = u.attr("data-title-id");
    let title = clean(u.find("[role=heading]").first().text()) || (titleId ? clean($(`[id="${titleId}"]`).text()) : "");
    if (!title) title = texts.filter((t) => !PRICE.test(t)).sort((a, b) => b.length - a.length)[0] || "";

    const priceText = texts.find((t) => PRICE.test(t));
    const price = priceText ? Math.round(Number(priceText.match(PRICE)![1].replace(/,/g, ""))) : null;

    // Store name: aria-label "From IndiaMART" (mobile) or "... from Lixo Healthcare, ..." (desktop)
    const label = u.attr("aria-label") || "";
    const fromMatch = label.match(/(?:^|\s)from\s+(.+?)(?:,|$)/i);
    const name = clean(fromMatch?.[1] || "") || clean(u.find(".UsGWMe").first().text()) || domain;

    ads.push({
      type: "shopping",
      position: ++pos,
      placement: placementOf(u),
      advertiserName: name,
      advertiserDomain: domain,
      title,
      price,
      landingUrl: absGoogle(u.attr("href") || u.find("a[href]").first().attr("href") || ""),
      isIndiamart: isIndiamart(domain),
    });
  });

  // ---------- Search ads (text ads marked "Sponsored") ----------
  pos = 0;
  outermost("[data-text-ad]").each((_, el) => {
    const a = $(el);
    const title = clean(a.find("[role=heading]").first().text());
    const pcu = (a.attr("data-pcu") || a.find("[data-pcu]").first().attr("data-pcu") || "").split(",")[0];
    const domain = normDomain(a.attr("data-dtld") || a.find("[data-dtld]").first().attr("data-dtld") || "") || hostOf(pcu);
    // Advertiser name: first short text that is not the title, a URL, a rating or Google's own label
    const name =
      leaves(a).find(
        (t) =>
          t !== title &&
          t.length >= 2 &&
          t.length <= 60 &&
          !/^https?:\/\//i.test(t) &&
          !/^(sponsored|my ad cent(re|er)|ad|·|-|›)$/i.test(t) &&
          !/^[\d.,()\s]+(k|l|m|cr|lakh)?\)?$/i.test(t)
      ) || domain;
    ads.push({
      type: "search",
      position: ++pos,
      placement: placementOf(a),
      advertiserName: name,
      advertiserDomain: domain,
      title,
      price: null,
      landingUrl: pcu || absGoogle(a.find("a[href]").first().attr("href") || ""),
      isIndiamart: isIndiamart(domain),
    });
  });

  // ---------- Location from Google's footer: "Indore, Madhya Pradesh - From your IP address" ----------
  let city: string | null = null, region: string | null = null, locationSource: Extracted["locationSource"] = null;
  const all = leaves($("body"));
  const i = all.findIndex((t) => /^-?\s*from your (ip address|internet address|device|places|location)/i.test(t));
  if (i > 0) {
    const place = all.slice(Math.max(0, i - 3), i).reverse().find((t) => t !== "-" && /[a-z]/i.test(t));
    if (place) {
      const [c, ...rest] = place.split(",").map((s) => s.trim());
      city = c || null;
      region = rest.join(", ") || null;
    }
    locationSource = /ip|internet/i.test(all[i]) ? "ip" : /device/i.test(all[i]) ? "device" : "other";
  }

  return { city, region, locationSource, ads };
}

// ---------- Brand detection ladder (never guesses; see GOOGLE_ADS_VISIBILITY_REQUIREMENT.md) ----------
export interface BrandResult {
  brand: string | null;
  status: BrandStatus;
  source: BrandSource | null;
  raw: string | null;
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function resolveBrand(ad: ExtractedAd, aliases: { alias: string; brand: string }[]): BrandResult {
  // 1. Title contains a known brand or alias (longest alias first)
  for (const { alias, brand } of aliases) {
    const m = ad.title.match(new RegExp(`(^|[^\\p{L}\\p{N}])(${escRe(alias)})(?=$|[^\\p{L}\\p{N}])`, "iu"));
    if (m) return { brand, status: "found", source: "title_match", raw: m[2] };
  }
  // 2. "Brand" field in the ad: not present in Google's result-page source, so skipped here.
  // 3. Advertiser is the brand: the title starts with the domain name ("Lixo LI4405 ..." from lixo.in).
  //    Only the first word counts, so a store name tacked on at the end ("... - Pepperfry") is not taken as a brand.
  const root = ad.advertiserDomain.split(".")[0];
  const first = ad.title.split(/[^\p{L}\p{N}]+/u).find(Boolean) || "";
  if (root.length >= 3 && first.toLowerCase() === root)
    return { brand: first[0].toUpperCase() + first.slice(1), status: "found", source: "advertiser_is_brand", raw: first };
  // 4/5. Landing page and LLM steps run later as a batch. Until then the brand is unknown.
  return { brand: null, status: "unresolved", source: null, raw: null };
}
