import * as cheerio from "cheerio";
import { resolveBrand } from "./extract";

// New-approach extractor (DATA_STORAGE.md): reads a saved Google results page and returns
//  - the page split into SECTIONS, top to bottom, each with a rank (= absolute_ads_position)
//  - every ad inside each section, with its rank inside the section (= relative_ads_position)
// Section rule (decision #15): every organic result is its own section; every other part of the page
// (AI overview, ads block, People also search, videos, shopping carousel, ...) is one section.

export type SectionType =
  | "search_ads" | "shopping_ads" | "ai_overview" | "organic" | "people_also_ask" | "people_also_search"
  | "short_videos" | "videos" | "images" | "places" | "popular_products" | "shop_by_store" | "news"
  | "discussions" | "related_searches" | "other";

export interface PageAd {
  ads_type: "search_ads" | "shopping_ads";
  relative_ads_position: number;
  title: string | null;
  description: string | null;
  advertiser_name: string | null;
  domain: string | null;
  brand: string | null;
  brand_status: "found" | "not_in_ad" | "unbranded" | "unresolved";
  price: number | null;
  image_url: string | null;
  image_data?: string | null; // embedded picture ("data:image/…;base64,…") when the page has no web link for it
  url_of_product: string | null;
}

export interface PageSection {
  rank: number; // absolute position on the page, from 1
  type: SectionType;
  ads: PageAd[];
}

export interface ExtractedPage {
  city: string | null;
  sections: PageSection[];
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const normDomain = (d: string) => d.trim().toLowerCase().replace(/^www\./, "").replace(/[/:].*$/, "") || "";
const hostOf = (u: string) => {
  try { return normDomain(new URL(u).hostname); } catch { return ""; }
};
const httpOnly = (u?: string | null) => (u && /^https?:\/\//i.test(u) ? u : null);
const PRICE = /^₹\s?([\d,]+(?:\.\d+)?)(?:\s*\+\s*tax)?$/i; // "₹76,199", "₹1,12,375.38 + tax"

// Any Google host (google.com, maps.google.com, googleadservices.com, …) is never an advertiser's page
const isGoogle = (u: string) => /(^|\.)google(adservices|syndication)?\.[a-z.]+$/i.test(hostOf(u)) || /(^|\.)(googleusercontent|gstatic)\.com$/i.test(hostOf(u));

// Google ad links are redirects (/aclk?…, /goto?…). Return the advertiser's real URL when it is in the link
// (adurl= / url= parameter holding an http URL); otherwise null. Never return the Google redirect itself.
function realUrl(href?: string | null): string | null {
  if (!href) return null;
  if (/^https?:\/\//i.test(href) && !isGoogle(href)) return href;
  try {
    const u = new URL(href, "https://www.google.com");
    for (const k of ["adurl", "url", "q"]) {
      const v = u.searchParams.get(k);
      if (v && /^https?:\/\//i.test(v) && !isGoogle(v)) return v;
    }
  } catch {}
  return null;
}

function classify($: cheerio.CheerioAPI, el: cheerio.Cheerio<any>): SectionType {
  if (el.is("[data-text-ad]") || el.find("[data-text-ad]").length) return "search_ads";
  if (el.find("[data-offer-id][data-dtld], .pla-unit[data-dtld]").length) return "shopping_ads";
  const t = clean(el.text());
  const head = t.slice(0, 120);
  if (/^(AI Mode|AI Overview)/i.test(head)) return "ai_overview";
  if (/^People also ask/i.test(head)) return "people_also_ask";
  if (/^People also search for/i.test(head)) return "people_also_search";
  if (/^Short videos/i.test(head)) return "short_videos";
  if (/^Videos/i.test(head)) return "videos";
  if (/^Images/i.test(head)) return "images";
  if (/^Places/i.test(head)) return "places";
  if (/Popular products/i.test(head)) return "popular_products";
  if (/Shop by store/i.test(head)) return "shop_by_store";
  if (/^(Top stories|News)/i.test(head)) return "news";
  if (/^Discussions and forums/i.test(head)) return "discussions";
  if (/^(Related searches|Searches related to)/i.test(head)) return "related_searches";
  // Organic result: "Web results" label, a <cite>, or a display URL ("https://www.amazon.in") among its first lines
  const firstLines: string[] = [];
  el.find("*").each((_, e) => {
    if (firstLines.length >= 6) return false;
    if ($(e).children().length === 0) { const x = clean($(e).text()); if (x) firstLines.push(x); }
  });
  if (/^Web results/i.test(head) || el.find("cite").length || firstLines.some((x) => /^https?:\/\/\S+$/i.test(x)) ||
      el.find("a[href^='http'] h3, a[href^='http'] [role=heading]").length) return "organic";
  return "other";
}

// Google fills many result images later from script maps (google.ldi / google.ldilf):
// "dimg_…" / "plathumb…" -> "https://encrypted-tbn0.gstatic.com/…". Read the http links from the raw page.
function imageLinkMap(html: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of html.matchAll(/"([A-Za-z]+\d*_[\w-]+)":"(https:\/\/[^"]+)"/g)) {
    let url = m[2];
    try { url = JSON.parse(`"${url}"`); } catch {} // undo \u003d etc.
    if (/^https:\/\/encrypted-tbn\d\.gstatic\.com\//.test(url) || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(url)) map.set(m[1], url);
  }
  return map;
}
let IMG_LINKS = new Map<string, string>(); // for the page being extracted

export function extractPage(html: string): ExtractedPage {
  IMG_LINKS = imageLinkMap(html);
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

  // ---------- 1. Sections, in page order ----------
  // Roots: top ads (#tads), each result block (.MjjYud), bottom ads (#bottomads), and the blocks in #botstuff.
  const isRoot = (e: any) => {
    const n = $(e);
    const id = n.attr("id");
    return id === "tads" || id === "bottomads" || n.hasClass("MjjYud") || n.parent().attr("id") === "botstuff";
  };
  const roots: any[] = [];
  const walk = (e: any) => {
    for (const c of $(e).children().toArray()) {
      if (isRoot(c)) roots.push(c);
      else walk(c);
    }
  };
  walk($("#center_col").get(0) || $("#main").get(0) || $("body").get(0));

  const sections: PageSection[] = [];
  for (const r of roots) {
    const el = $(r);
    if (!clean(el.text())) continue; // empty block, not shown
    // a #botstuff block that just wraps .MjjYud blocks is handled by those blocks
    if (el.parent().attr("id") === "botstuff" && el.find(".MjjYud").length) {
      el.find(".MjjYud").filter((_, x) => $(x).parents(".MjjYud").length === 0).each((_, x) => {
        if (clean($(x).text())) sections.push({ rank: 0, type: classify($, $(x)), ads: extractAds($, $(x), leaves) });
      });
      continue;
    }
    for (const part of splitMixed($, el)) sections.push({ rank: 0, type: classify($, part), ads: extractAds($, part, leaves) });
  }
  sections.forEach((s, i) => (s.rank = i + 1));

  // ---------- 2. City from Google's footer: "Indore, Madhya Pradesh - From your IP address" ----------
  let city: string | null = null;
  const all = leaves($("body"));
  const i = all.findIndex((t) => /^-?\s*from your (ip address|internet address|device|places|location)/i.test(t));
  if (i > 0) {
    const place = all.slice(Math.max(0, i - 3), i).reverse().find((t) => t !== "-" && /[a-z]/i.test(t));
    if (place) city = place.split(",")[0].trim() || null;
  }
  return { city, sections };
}

// An ad area can hold two separate blocks, e.g. a "Featured products" carousel and, under it, a sponsored
// local-business ad, each with its own header. Those are two sections. Split a block that holds both ad kinds into
// its runs of children of the same kind; any other block stays one section.
function splitMixed($: cheerio.CheerioAPI, el: cheerio.Cheerio<any>): cheerio.Cheerio<any>[] {
  const kind = (x: cheerio.Cheerio<any>) =>
    x.is("[data-text-ad]") || x.find("[data-text-ad]").length ? "text" : x.find("[data-offer-id][data-dtld], .pla-unit[data-dtld]").length ? "pla" : "";
  const both = (x: cheerio.Cheerio<any>) => x.find("[data-text-ad]").length > 0 && x.find("[data-offer-id][data-dtld], .pla-unit[data-dtld]").length > 0;
  if (!both(el)) return [el];
  let node = el;
  for (;;) {
    const kids = node.children().filter((_, c) => clean($(c).text()).length > 0);
    // Go deeper while one child holds all the ads (headers like "Sponsored results" are skipped)
    const withAds = kids.filter((_, c) => !!kind($(c)));
    if (withAds.length === 1 && both(withAds.first())) { node = withAds.first(); continue; }
    if (kids.length < 2) return [el];
    const groups: { k: string; els: any[] }[] = [];
    let pending: any[] = []; // header / non-ad children join the next ad block
    kids.each((_, c) => {
      const k = kind($(c));
      if (!k) { pending.push(c); return; }
      if (groups.length && groups[groups.length - 1].k === k && !pending.length) groups[groups.length - 1].els.push(c);
      else { groups.push({ k, els: [...pending, c] }); pending = []; }
    });
    if (groups.length < 2) return [el];
    if (pending.length) groups[groups.length - 1].els.push(...pending);
    return groups.map((g) => $(g.els));
  }
}

// Store name on a shopping card: the first short line after the price that is not a price, discount or label
function storeLine(texts: string[], title: string): string | null {
  const i = texts.findIndex((t) => PRICE.test(t));
  if (i < 0) return null;
  return texts.slice(i + 1).find((t) => t !== title && t.length >= 2 && t.length <= 40 && !/[₹%]|^\d|off$|delivery|returns|^(free|ad)$/i.test(t)) || null;
}

// Some sellers' shopping ads carry no landing address in Google's link ("adurl=" is empty). Their
// data-offer-id is the seller's own product id from the Shopping feed, so the product page can be built from it.
// Only for sellers whose product-page pattern is known; anything else stays NULL.
function urlFromOfferId(domain: string | null, offerId?: string): string | null {
  if (!domain || !offerId) return null;
  if ((domain === "indiamart.com" || domain.endsWith(".indiamart.com")) && /^\d{6,15}$/.test(offerId))
    return `https://www.indiamart.com/proddetail/${offerId}.html`;
  if (/^amazon\.(in|com)$/.test(domain) && /^[A-Z0-9]{10}$/.test(offerId))
    return `https://www.${domain}/dp/${offerId}`;
  return null;
}

// Real http link of the product picture inside `el`, or null when the page only has it as embedded image data.
// Store logos ("tsuid_…") are skipped.
function productImage($: cheerio.CheerioAPI, el: cheerio.Cheerio<any>): string | null {
  for (const im of el.find("img").toArray()) {
    const i = $(im), id = i.attr("id") || i.attr("data-iid") || "";
    if (id.startsWith("tsuid_")) continue;
    const url = httpOnly(i.attr("src")) || httpOnly(i.attr("data-src")) || (id ? IMG_LINKS.get(id) || null : null);
    if (url && !/^https:\/\/(ssl|www)\.gstatic\.com\//.test(url)) return url; // skip Google's own icons (WhatsApp, call, …)
  }
  return null;
}

// The product picture embedded in the page itself (no web link exists for it). Tiny placeholders are ignored.
function productImageData($: cheerio.CheerioAPI, el: cheerio.Cheerio<any>): string | null {
  for (const im of el.find("img").toArray()) {
    const i = $(im), id = i.attr("id") || "";
    if (id.startsWith("tsuid_")) continue; // store logo
    const src = i.attr("src") || "";
    if (/^data:image\/(webp|jpe?g|png|gif);base64,/.test(src) && src.length > 1500) return src;
  }
  return null;
}

function extractAds($: cheerio.CheerioAPI, sec: cheerio.Cheerio<any>, leaves: (r: cheerio.Cheerio<any>) => string[]): PageAd[] {
  const ads: PageAd[] = [];
  const outermost = (sel: string) => sec.find(sel).add(sec.filter(sel)).filter((_, e) => $(e).parents(sel).length === 0);
  const brandOf = (title: string | null, domain: string | null) => {
    const b = resolveBrand({ title: title || "", advertiserDomain: domain || "" } as any, []);
    return { brand: b.brand, brand_status: b.status };
  };

  // Search (text) ads
  outermost("[data-text-ad]").each((_, node) => {
    const a = $(node);
    const LABEL = /^(sponsored|sponsored results|my ad cent(re|er)|ad|·|-|›|read more|directions|call|website|about|photos|reviews|menu|services|products)$/i;
    // Buttons, not names: "Call 080 4581 3026", "WhatsApp +91…", "Get quote on WhatsApp", "Send message", "Learn more"
    const ACTION = /^(call|whatsapp|message|chat|send message|get directions)\b|\bwhatsapp\b|^(get|learn|contact|request)( a)? (quote|info|more|us|price)\b/i;
    const ls = leaves(a);
    // Display URL shown on the ad ("http://www.crownpipes.co.in/", "https://www.irestindia.in › …")
    const shown = ls.map((t) => t.split(/\s+/)[0]).find((t) => /^https?:\/\/[^\s]+$/i.test(t)) || "";
    // Local-business ads (map card) have no heading: their first text line is the business name
    const heading = a.find("[role=heading]").toArray().map((h) => clean($(h).text())).find((t) => t && !LABEL.test(t));
    const title = heading || leaves(a).find((t) => !LABEL.test(t) && t.length >= 2) || null;
    const pcu = (a.attr("data-pcu") || a.find("[data-pcu]").first().attr("data-pcu") || "").split(",")[0];
    const domain = normDomain(a.attr("data-dtld") || a.find("[data-dtld]").first().attr("data-dtld") || "") || hostOf(pcu) || hostOf(shown) ||
      normDomain(ls.find((t) => /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/\S*)?$/i.test(t)) || "") || null; // "sollant.com/form"; not "4.4"
    // Local-business ads and ads without a headline show the business name as their first line: that business is the advertiser
    const isLocal = a.find("[data-business-lat]").length > 0;
    const name = isLocal || !heading ? title :
      ls.find(
        (t) => t !== title && t.length >= 2 && t.length <= 60 && !/^https?:\/\//i.test(t) &&
          !LABEL.test(t) && !ACTION.test(t) && !/^[\d.,()\s]+(k|l|m|cr|lakh)?\)?$/i.test(t)
      ) || title || domain;
    // Description: the ad text block; ads without one (e.g. call-only) carry it as one long line
    const desc = clean(a.find(".p4wth").first().text()).replace(/\s*Read more$/i, "") ||
      ls.filter((t) => t !== title && t.length >= 60 && !/^https?:\/\//i.test(t)).sort((x, y) => y.length - x.length)[0] || null;
    let url = httpOnly(pcu);
    if (!url) a.find("a[href]").each((_, l) => { url = url || realUrl($(l).attr("href")) || realUrl($(l).attr("data-rw")); });
    if (!url) url = realUrl(shown); // last resort: the website shown on the ad
    ads.push({
      ads_type: "search_ads", relative_ads_position: ads.length + 1, title, description: desc, advertiser_name: name,
      domain, ...brandOf(title, domain), price: null, image_url: productImage($, a), image_data: productImageData($, a), url_of_product: url,
    });
  });

  // Shopping ads (product cards); the same offer can appear twice (carousel copies)
  const seen = new Set<string>();
  outermost("[data-offer-id][data-dtld], .pla-unit[data-dtld]").each((_, node) => {
    const u = $(node);
    const domain = normDomain(u.attr("data-dtld") || "") || null;
    const key = `${u.attr("data-merchant-id") || domain}|${u.attr("data-offer-id") || u.attr("data-offer-docid") || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    // The link is only part of the card; title / price / store sit in the card around it.
    // Card = the largest ancestor (inside this section) that still holds only this one offer.
    let card = u;
    for (let p = u.parent(); p.length && !p.is(sec) && p.find("[data-offer-id]").toArray()
      .every((o) => ($(o).attr("data-offer-id") || "") === (u.attr("data-offer-id") || "")); p = p.parent()) card = p;
    const texts = leaves(card);
    const titleId = u.attr("data-title-id");
    let title = clean(card.find("[role=heading]").first().text()) || (titleId ? clean($(`[id="${titleId}"]`).text()) : "");
    if (!title) title = texts.filter((t) => !PRICE.test(t) && !/ off$/i.test(t)).sort((a, b) => b.length - a.length)[0] || "";
    const priceText = texts.find((t) => PRICE.test(t));
    const price = priceText ? Math.round(Number(priceText.match(PRICE)![1].replace(/,/g, ""))) : null;
    const label = u.attr("aria-label") || "";
    const fromMatch = label.match(/(?:^|\s)from\s+(.+?)(?:,|$)/i);
    const name = clean(fromMatch?.[1] || "") || clean(card.find(".UsGWMe").first().text()) || storeLine(texts, title) || domain;
    const img = productImage($, card);
    ads.push({
      ads_type: "shopping_ads", relative_ads_position: ads.length + 1, title: title || null, description: null,
      advertiser_name: name, domain, ...brandOf(title, domain), price, image_url: img, image_data: img ? null : productImageData($, card),
      url_of_product: realUrl(u.attr("href")) || realUrl(u.find("a[href]").first().attr("href")) || urlFromOfferId(domain, u.attr("data-offer-id")),
    });
  });
  return ads;
}
