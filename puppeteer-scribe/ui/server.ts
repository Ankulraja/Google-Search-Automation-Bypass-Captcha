import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import puppeteer, { Browser, Page } from "puppeteer";
import Scribe from "../index";

// Local UI: page 1 (/) queues search queries, page 2 (/source) shows the saved page source.
const PORT = Number(process.env.UI_PORT || 4000);
// Supported browsers: where the app lives, where its real profiles live, where we keep our copy
type BrowserKind = "chrome" | "brave";
const BROWSERS: Record<BrowserKind, { label: string; exe: string; src: string; copy: string }> = {
  chrome: {
    label: "Google Chrome",
    exe: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    src: path.join(os.homedir(), "Library/Application Support/Google/Chrome"),
    copy: path.join(os.tmpdir(), "scribe-chrome-profile"),
  },
  brave: {
    label: "Brave",
    exe: process.env.BRAVE_PATH || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    src: path.join(os.homedir(), "Library/Application Support/BraveSoftware/Brave-Browser"),
    copy: process.env.PROFILE_COPY || path.join(os.tmpdir(), "scribe-brave-profile"),
  },
};
const PUBLIC = path.join(__dirname, "public");
const CAPTURES = path.join(__dirname, "captures");
fs.mkdirSync(CAPTURES, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Status = "queued" | "running" | "done" | "captcha" | "error";
type Mode = "logged-in" | "incognito";
type Device = "desktop" | "mobile";
interface Job {
  id: number;
  mode: Mode;
  browser: BrowserKind;
  profile?: string; // profile folder for logged-in mode, e.g. "Default" or "Profile 2"
  profileName?: string;
  device: Device;
  tag?: string; // optional leading number, e.g. an MCAT id
  query: string;
  status: Status;
  captureId?: string;
  resultCount?: number;
  error?: string;
  note?: string;
}
interface Capture {
  id: string;
  mode?: Mode; // older captures have none (they were logged-in Brave)
  browser?: BrowserKind;
  profileName?: string;
  device?: Device; // older captures: desktop
  tag?: string;
  query: string;
  url: string;
  capturedAt: string;
  bytes: number;
  captcha: boolean;
  results: { title: string; url: string; site: string; snippet?: string }[];
}

const jobs: Job[] = [];
let nextJobId = 1;
let working = false;

// ---------- Browsers & profiles ----------
interface ProfileInfo { dir: string; name: string; email?: string }

// Read the browser's profile list (folder + display name) from its "Local State" file
function listProfiles(kind: BrowserKind): { profiles: ProfileInfo[]; lastUsed?: string; error?: string } {
  try {
    const ls = JSON.parse(fs.readFileSync(path.join(BROWSERS[kind].src, "Local State"), "utf8"));
    const cache = ls?.profile?.info_cache || {};
    const profiles = Object.entries(cache)
      .map(([dir, v]: [string, any]) => ({ dir, name: v?.name || dir, email: v?.user_name || undefined }))
      .sort((a, b) => (a.dir === "Default" ? -1 : b.dir === "Default" ? 1 : a.dir.localeCompare(b.dir, undefined, { numeric: true })));
    return { profiles, lastUsed: ls?.profile?.last_used };
  } catch (e: any) {
    const blocked = /EPERM|Operation not permitted/i.test(String(e?.message || e));
    return { profiles: [{ dir: "Default", name: "Default" }], error: blocked ? "macOS blocked reading the profile list" : undefined };
  }
}

let profileNote = "";

// Refresh our copy of one profile; if macOS privacy blocks reading the browser's folder, reuse the last copy.
function syncProfile(kind: BrowserKind, profile: string) {
  const b = BROWSERS[kind];
  profileNote = "";
  try {
    copyProfile(kind, profile);
  } catch (e: any) {
    const blocked = /Operation not permitted/i.test(String(e?.message || e));
    if (fs.existsSync(path.join(b.copy, profile, "Cookies"))) {
      profileNote = blocked
        ? `Used the last saved ${b.label} profile copy (macOS blocked reading ${b.label}'s folder; give your terminal Full Disk Access to refresh logins)`
        : `Used the last saved ${b.label} profile copy (refresh failed)`;
      console.warn("[scribe] " + profileNote);
      return;
    }
    throw new Error(
      blocked
        ? `macOS blocked access to ${b.label}'s profile folder. Open System Settings → Privacy & Security → Full Disk Access, enable the app running this server (Terminal / iTerm / VS Code), restart that app, then start the server again.`
        : String(e?.message || e)
    );
  }
}

function copyProfile(kind: BrowserKind, profile: string) {
  const { src, copy } = BROWSERS[kind];
  const ex = ["Cache", "Code Cache", "GPUCache", "Service Worker/CacheStorage", "DawnCache", "GrShaderCache"]
    .map((e) => `--exclude='${e}'`)
    .join(" ");
  execSync(`mkdir -p "${copy}"`);
  execSync(`cp "${src}/Local State" "${copy}/Local State.tmp"`, { stdio: "pipe" });
  execSync(`rsync -a --delete ${ex} "${src}/${profile}/" "${copy}/${profile}/"`, { stdio: "pipe" });
  execSync(`mv "${copy}/Local State.tmp" "${copy}/Local State"`);
  execSync(`rm -f "${copy}"/Singleton*`);
}

const COMMON_IGNORE = ["--enable-automation", "--disable-extensions", "--disable-component-extensions-with-background-pages"];
const COMMON_ARGS = ["--window-size=1400,900", "--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"];

function checkInstalled(kind: BrowserKind) {
  if (!fs.existsSync(BROWSERS[kind].exe)) throw new Error(`${BROWSERS[kind].label} is not installed at ${BROWSERS[kind].exe}`);
}

// Logged-in: a copy of your real browser profile (cookies, Google sign-in, extensions)
function launchLoggedIn(kind: BrowserKind, profile: string) {
  checkInstalled(kind);
  return puppeteer.launch({
    executablePath: BROWSERS[kind].exe,
    headless: false,
    defaultViewport: null,
    userDataDir: BROWSERS[kind].copy,
    ignoreDefaultArgs: COMMON_IGNORE,
    args: [`--profile-directory=${profile}`, ...COMMON_ARGS],
  });
}

// Incognito: a brand-new empty profile that is deleted afterwards; each query uses its own private context
function launchIncognito(kind: BrowserKind, tmpDir: string) {
  checkInstalled(kind);
  return puppeteer.launch({
    executablePath: BROWSERS[kind].exe,
    headless: false,
    defaultViewport: null,
    userDataDir: tmpDir,
    ignoreDefaultArgs: COMMON_IGNORE,
    args: COMMON_ARGS,
  });
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

// Organic results for both layouts. Runs inside the page.
// Desktop: links with an <h3> title in #search. Mobile: links with a role="heading" title inside a [data-snc] result block in #rso.
function extractResults() {
  const t = (e: Element | null | undefined) => (e?.textContent || "").replace(/\s+/g, " ").trim();
  const seen = new Set<string>();
  const out: { title: string; url: string; site: string; snippet: string }[] = [];
  const desktop = [...document.querySelectorAll("#search a:has(h3)")];
  const links = desktop.length
    ? desktop
    : [...document.querySelectorAll("#rso a[href]:has([role=heading])")].filter((a) => a.closest("[data-snc]"));
  for (const a of links as HTMLAnchorElement[]) {
    if (a.closest("#tads, #bottomads") || seen.has(a.href)) continue;
    seen.add(a.href);
    const head = a.querySelector("h3") || a.querySelector("[role=heading]");
    const block = a.closest("[jscontroller='SC7lYd'], [data-rpos], .MjjYud, [data-snc]") || a.parentElement;
    const title = t(head);
    out.push({
      title,
      url: a.href,
      site: (t(a.querySelector("cite")) || t(block?.querySelector("cite")) || t(a).replace(title, "").trim()).replace(/(\S)(https?:\/\/)/, "$1 · $2").slice(0, 90),
      snippet: t(block?.querySelector(".VwiC3b")),
    });
  }
  return out;
}

// Mobile: present as a current Android phone (Pixel 8 size, touch, mobile UA + client hints)
const MOBILE = { width: 412, height: 915, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true };
async function emulateMobile(page: Page, browser: Browser) {
  const full = (await browser.version()).match(/(\d+)\.(\d+\.\d+\.\d+)/); // "Chrome/156.0.8078.80"
  const major = full ? full[1] : "130";
  const ver = full ? `${full[1]}.${full[2]}` : "130.0.0.0";
  await page.setViewport(MOBILE);
  await page.setUserAgent(
    `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`,
    {
      brands: [{ brand: "Chromium", version: major }, { brand: "Google Chrome", version: major }, { brand: "Not-A.Brand", version: "99" }],
      fullVersionList: [{ brand: "Chromium", version: ver }, { brand: "Google Chrome", version: ver }, { brand: "Not-A.Brand", version: "99.0.0.0" }],
      fullVersion: ver,
      platform: "Android",
      platformVersion: "14.0.0",
      architecture: "",
      model: "Pixel 8",
      mobile: true,
    }
  );
}

async function runJob(browser: Browser, job: Job) {
  // Incognito: every query gets its own private (off-the-record) context, thrown away afterwards
  const ctx = job.mode === "incognito" ? await browser.createBrowserContext() : undefined;
  const page = ctx ? await ctx.newPage() : await browser.newPage();
  if (job.device === "mobile") await emulateMobile(page, browser);
  try {
    const scribe = new Scribe(page, { visualize: true });
    await page.goto("https://www.google.com", { waitUntil: "networkidle2" });
    await sleep(1000);
    await scribe.click('textarea[name="q"], input[name="q"]');
    await scribe.type(job.query);
    await sleep(400);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(() => {}),
      page.keyboard.press("Enter"),
    ]);
    await page.waitForSelector("#search", { timeout: 10000 }).catch(() => {});
    await sleep(1500);

    const captcha = page.url().includes("/sorry/");
    const results = captcha ? [] : await page.evaluate(extractResults);
    const html = await page.content();

    const id = `${Date.now()}-${slug(job.query)}`;
    const meta: Capture = {
      id,
      mode: job.mode,
      browser: job.browser,
      device: job.device,
      profileName: job.profileName,
      tag: job.tag,
      query: job.query,
      url: page.url(),
      capturedAt: new Date().toISOString(),
      bytes: Buffer.byteLength(html),
      captcha,
      results,
    };
    fs.writeFileSync(path.join(CAPTURES, `${id}.html`), html);
    fs.writeFileSync(path.join(CAPTURES, `${id}.json`), JSON.stringify(meta, null, 2));

    job.captureId = id;
    job.resultCount = results.length;
    job.status = captcha ? "captcha" : "done";
  } finally {
    await page.close().catch(() => {});
    await ctx?.close().catch(() => {});
  }
}

async function work() {
  if (working) return;
  working = true;
  let browser: Browser | undefined;
  let browserKey: string | undefined;
  let tmpDir: string | undefined;
  const closeBrowser = async () => {
    await browser?.close().catch(() => {});
    browser = undefined;
    browserKey = undefined;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  };
  try {
    while (jobs.some((j) => j.status === "queued")) {
      const job = jobs.find((j) => j.status === "queued")!;
      job.status = "running";
      try {
        // Relaunch when the next job needs a different browser / mode / profile
        const key = `${job.browser}|${job.mode}|${job.mode === "logged-in" ? job.profile : ""}`;
        if (browser && (browserKey !== key || !browser.connected)) await closeBrowser();
        if (!browser) {
          if (job.mode === "incognito") {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-incognito-"));
            browser = await launchIncognito(job.browser, tmpDir);
          } else {
            syncProfile(job.browser, job.profile!);
            browser = await launchLoggedIn(job.browser, job.profile!);
          }
          browserKey = key;
        }
        if (job.mode === "logged-in" && profileNote) job.note = profileNote;
        await runJob(browser, job);
      } catch (e: any) {
        job.status = "error";
        job.error = e?.code === "ECONNREFUSED" ? "Path server on :3000 is not running" : String(e?.message || e);
      }
    }
  } finally {
    await closeBrowser();
    working = false;
  }
}

// ---------- HTTP ----------
function parseQueries(text: string) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = l.match(/^(\d+)\s+(.+)$/); // "9898    Massage Chair"
      return m ? { tag: m[1], query: m[2].trim() } : { query: l };
    });
}

function listCaptures(): Capture[] {
  return fs
    .readdirSync(CAPTURES)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(CAPTURES, f), "utf8")) as Capture)
    .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
}

const send = (res: http.ServerResponse, code: number, body: string | Buffer, type = "application/json") => {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
};
const json = (res: http.ServerResponse, data: unknown, code = 200) => send(res, code, JSON.stringify(data));
const validId = (id: string) => /^[a-z0-9-]+$/.test(id) && fs.existsSync(path.join(CAPTURES, `${id}.json`));

// ---------- view-source page ----------
const escHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const VOID_TAG = /^<(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr|!doctype)\b/i;

function formatHtml(s: string) {
  let depth = 0;
  return s
    .replace(/>\s*</g, ">\n<")
    .split("\n")
    .map((line) => {
      const l = line.trim();
      if (/^<\//.test(l)) depth = Math.max(0, depth - 1);
      const out = "  ".repeat(Math.min(depth, 40)) + l;
      if (/^<[a-z]/i.test(l) && !VOID_TAG.test(l) && !/\/>$/.test(l) && !/^<([a-z0-9-]+)\b[\s\S]*<\/\1>$/i.test(l)) depth++;
      return out;
    })
    .join("\n");
}

function highlightLine(line: string) {
  if (line.length > 200000) return escHtml(line); // giant inline script: skip colouring
  return escHtml(line)
    .replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="c">$1</span>')
    .replace(/(&lt;\/?)([a-zA-Z][\w:-]*)/g, '$1<span class="t">$2</span>')
    .replace(/(\s)([\w:@-]+)=(&quot;[\s\S]*?&quot;)/g, '$1<span class="a">$2</span>=<span class="v">$3</span>');
}

// ---------- view-page: rebuild the page UI from the saved source ----------
const unescapeJs = (s: string) =>
  s.replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\\//g, "/");

function setImgSrc(tag: string, src: string) {
  const attr = ` src="${src.replace(/"/g, "&quot;")}"`;
  return /\ssrc="[^"]*"/i.test(tag) ? tag.replace(/\ssrc="[^"]*"/i, attr) : tag.replace(/^<img/i, "<img" + attr);
}

function buildPage(html: string, meta: Capture, bar: boolean) {
  let restored = 0;
  // 1. Images Google injects with JS: (function(){var s='data:image/...';var ii=['id1','id2'];_setImagesSrc(ii,s);})()
  const imgById = new Map<string, string>();
  for (const m of html.matchAll(/var s='(data:image\/[^']+)';\s*var ii=\[([^\]]*)\]/g)) {
    const src = unescapeJs(m[1]);
    for (const idm of m[2].matchAll(/'([^']+)'/g)) imgById.set(idm[1], src);
  }
  // 2. Drop everything that is code, plus the <noscript> "enable JavaScript" redirect
  let out = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<link\b[^>]*rel="?(preload|modulepreload|prefetch)"?[^>]*>/gi, "");
  // 3. Put the images back
  out = out.replace(/<img\b[^>]*>/gi, (tag) => {
    const id = tag.match(/\sid="([^"]+)"/i)?.[1];
    if (id && imgById.has(id)) { restored++; return setImgSrc(tag, imgById.get(id)!); }
    const lazy = tag.match(/\sdata-src="([^"]+)"/i)?.[1];
    const src = tag.match(/\ssrc="([^"]*)"/i)?.[1];
    if (lazy && (!src || src.startsWith("data:image/gif"))) { restored++; return setImgSrc(tag, lazy); }
    return tag;
  });
  // 4. Resolve relative URLs against Google; open clicked links in a new tab
  const head = `<base href="https://www.google.com/" target="_blank"><meta name="referrer" content="no-referrer">`;
  out = /<head\b[^>]*>/i.test(out) ? out.replace(/<head\b[^>]*>/i, (h) => h + head) : head + out;
  // 5. Optional info bar
  if (bar) {
    const b = `<div style="all:initial;display:flex;gap:16px;align-items:center;flex-wrap:wrap;padding:7px 14px;background:#1a73e8;color:#fff;font:13px -apple-system,BlinkMacSystemFont,sans-serif;position:relative;z-index:2147483647">
      <b>Rebuilt from saved source</b><span>${escHtml(meta.query)}${meta.tag ? ` · ${escHtml(meta.tag)}` : ""} · captured ${new Date(meta.capturedAt).toLocaleString()} · ${restored} images restored · scripts removed</span>
      <a style="color:#fff" target="_self" href="http://localhost:${PORT}/view-source/${meta.id}">View source</a>
      <a style="color:#fff" target="_self" href="http://localhost:${PORT}/source?id=${meta.id}">Open in viewer</a></div>`;
    out = out.replace(/<body\b[^>]*>/i, (bt) => bt + b);
  }
  return out;
}

function phoneFrame(meta: Capture) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mobile · ${escHtml(meta.query)}</title>
<style>
body{margin:0;background:#16181c;font:13px -apple-system,BlinkMacSystemFont,sans-serif;color:#fff}
.bar{display:flex;gap:16px;align-items:center;flex-wrap:wrap;padding:7px 14px;background:#1a73e8}
.bar a{color:#fff}
.stage{display:flex;justify-content:center;padding:24px 16px}
.phone{width:412px;max-width:100%;height:915px;border:10px solid #2b2e33;border-radius:36px;overflow:hidden;background:#fff;box-shadow:0 10px 40px rgba(0,0,0,.5)}
iframe{width:100%;height:100%;border:0;display:block}
</style></head><body>
<div class="bar"><b>Rebuilt from saved source · Mobile (412 × 915)</b>
<span>${escHtml(meta.query)}${meta.tag ? ` · ${escHtml(meta.tag)}` : ""} · captured ${new Date(meta.capturedAt).toLocaleString()} · scripts removed</span>
<a href="/view-source/${meta.id}">View source</a><a href="/source?id=${meta.id}">Open in viewer</a></div>
<div class="stage"><div class="phone"><iframe sandbox="allow-popups allow-popups-to-escape-sandbox" src="/view-page/${meta.id}?frame=1&bar=0"></iframe></div></div>
</body></html>`;
}

function viewSourcePage(meta: Capture, html: string, format: boolean, wrap: boolean) {
  const src = format ? formatHtml(html) : html;
  const rows = src
    .split("\n")
    .map((l, i) => `<tr id="L${i + 1}"><td class="n"><a href="#L${i + 1}">${i + 1}</a></td><td class="s">${highlightLine(l)}</td></tr>`)
    .join("");
  const q = (f: boolean, w: boolean) => `?mode=raw&${f ? "format=1&" : ""}wrap=${w ? 1 : 0}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>view-source: ${escHtml(meta.query)}</title>
<style>
:root{--bg:#fff;--fg:#1b1f24;--ln:#9aa0a6;--bar:#f1f3f4;--bd:#dadce0;--t:#881280;--a:#994500;--v:#1a1aa6;--c:#236e25}
@media (prefers-color-scheme:dark){:root{--bg:#202124;--fg:#e8eaed;--ln:#80868b;--bar:#2d2e31;--bd:#3c4043;--t:#5db0d7;--a:#9bbbdc;--v:#f29766;--c:#898989}}
body{margin:0;background:var(--bg);color:var(--fg)}
.bar{position:sticky;top:0;display:flex;gap:16px;align-items:center;flex-wrap:wrap;padding:8px 14px;background:var(--bar);border-bottom:1px solid var(--bd);font:13px -apple-system,BlinkMacSystemFont,sans-serif;z-index:1}
.bar b{font-weight:600}.bar .m{color:var(--ln)}.bar a{color:inherit}
table{border-collapse:collapse;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
td.n{color:var(--ln);text-align:right;padding:0 12px 0 8px;vertical-align:top;user-select:none;border-right:1px solid var(--bd)}
td.n a{color:inherit;text-decoration:none}
td.s{padding:0 12px;white-space:${wrap ? "pre-wrap" : "pre"};word-break:${wrap ? "break-all" : "normal"}}
tr:target{background:rgba(255,213,0,.25)}
.t{color:var(--t)}.a{color:var(--a)}.v{color:var(--v)}.c{color:var(--c)}
</style></head><body>
<div class="bar">
  <span><b>view-source:</b> ${escHtml(meta.query)}${meta.tag ? ` <span class="m">· ${escHtml(meta.tag)}</span>` : ""}</span>
  <a href="/view-source/${meta.id}">← Parsed</a> <b>Raw (original)</b>
  <span class="m">${new Date(meta.capturedAt).toLocaleString()} · ${(meta.bytes / 1048576).toFixed(2)} MB</span>
  <label><input type="checkbox" ${wrap ? "checked" : ""} onchange="location.search='${q(format, !wrap)}'"> Line wrap</label>
  <label><input type="checkbox" ${format ? "checked" : ""} onchange="location.search='${q(!format, wrap)}'"> Format</label>
  <a href="/view-page/${meta.id}" target="_blank">View page ↗</a>
  <a href="/api/captures/${meta.id}/raw" download="${meta.id}.html">Download</a>
  <a href="/source?id=${meta.id}">Open in viewer</a>
</div>
<table>${rows}</table>
</body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    if (req.method === "GET" && (p === "/" || p === "/index.html"))
      return send(res, 200, fs.readFileSync(path.join(PUBLIC, "index.html")), "text/html; charset=utf-8");
    if (req.method === "GET" && (p === "/source" || p === "/source.html"))
      return send(res, 200, fs.readFileSync(path.join(PUBLIC, "source.html")), "text/html; charset=utf-8");
    if (req.method === "GET" && p === "/theme.js")
      return send(res, 200, fs.readFileSync(path.join(PUBLIC, "theme.js")), "text/javascript; charset=utf-8");
    if (req.method === "GET" && p === "/style.css")
      return send(res, 200, fs.readFileSync(path.join(PUBLIC, "style.css")), "text/css; charset=utf-8");

    if (p === "/favicon.ico") { res.writeHead(204); return res.end(); }

    const vp = p.match(/^\/view-page\/([^/]+)$/);
    if (req.method === "GET" && vp) {
      if (!validId(vp[1])) return send(res, 404, "Capture not found", "text/plain");
      const meta = JSON.parse(fs.readFileSync(path.join(CAPTURES, `${vp[1]}.json`), "utf8")) as Capture;
      const html = fs.readFileSync(path.join(CAPTURES, `${vp[1]}.html`), "utf8");
      // Mobile captures open in a phone-sized frame, so the page lays out at phone width
      if (meta.device === "mobile" && url.searchParams.get("frame") !== "1") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(phoneFrame(meta));
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "script-src 'none'; object-src 'none'",
        "Cache-Control": "no-store",
      });
      return res.end(buildPage(html, meta, url.searchParams.get("bar") !== "0" && meta.device !== "mobile"));
    }

    const vs = p.match(/^\/view-source\/([^/]+)$/);
    if (req.method === "GET" && vs) {
      if (!validId(vs[1])) return send(res, 404, "Capture not found", "text/plain");
      // Default: parsed view (rendered client-side with the browser's HTML parser)
      if (url.searchParams.get("mode") !== "raw")
        return send(res, 200, fs.readFileSync(path.join(PUBLIC, "view-source.html")), "text/html; charset=utf-8");
      const meta = JSON.parse(fs.readFileSync(path.join(CAPTURES, `${vs[1]}.json`), "utf8")) as Capture;
      const html = fs.readFileSync(path.join(CAPTURES, `${vs[1]}.html`), "utf8");
      const page = viewSourcePage(meta, html, url.searchParams.get("format") === "1", url.searchParams.get("wrap") !== "0");
      return send(res, 200, page, "text/html; charset=utf-8");
    }
    if (req.method === "GET" && p === "/api/jobs") return json(res, { working, jobs });
    if (req.method === "GET" && p === "/api/browsers") {
      return json(res, (Object.keys(BROWSERS) as BrowserKind[]).map((k) => ({
        id: k,
        label: BROWSERS[k].label,
        installed: fs.existsSync(BROWSERS[k].exe),
        ...listProfiles(k),
      })));
    }
    if (req.method === "GET" && p === "/api/health") {
      const pathServer = await new Promise<boolean>((resolve) => {
        const r = http.get("http://127.0.0.1:3000/generate_path?start_point=0,0&end_point=10,10", (resp) => { resp.resume(); resolve(resp.statusCode === 200); });
        r.on("error", () => resolve(false));
        r.setTimeout(3000, () => { r.destroy(); resolve(false); });
      });
      return json(res, { pathServer });
    }

    if (req.method === "POST" && p === "/api/run") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { queries, mode, browser, profile, device } = JSON.parse(body || "{}");
      const dev: Device = device === "mobile" ? "mobile" : "desktop";
      const parsed = parseQueries(String(queries || ""));
      if (!parsed.length) return json(res, { error: "Enter at least one query" }, 400);
      const m: Mode = mode === "incognito" ? "incognito" : "logged-in";
      const kind: BrowserKind = browser === "brave" ? "brave" : "chrome";
      let prof: ProfileInfo | undefined;
      if (m === "logged-in") {
        const { profiles, lastUsed } = listProfiles(kind);
        prof = profiles.find((x) => x.dir === profile) || profiles.find((x) => x.dir === lastUsed) || profiles[0];
      }
      for (const q of parsed)
        jobs.push({ id: nextJobId++, mode: m, browser: kind, device: dev, profile: prof?.dir, profileName: prof?.name, ...q, status: "queued" });
      work();
      return json(res, { added: parsed.length, mode: m, browser: kind, device: dev, profile: prof?.name });
    }

    if (req.method === "POST" && p === "/api/jobs/clear") {
      for (let i = jobs.length - 1; i >= 0; i--) if (!["queued", "running"].includes(jobs[i].status)) jobs.splice(i, 1);
      return json(res, { ok: true });
    }

    if (req.method === "GET" && p === "/api/captures") return json(res, listCaptures());

    const m = p.match(/^\/api\/captures\/([^/]+)(\/raw)?$/);
    if (m && validId(m[1])) {
      const id = m[1];
      if (req.method === "DELETE") {
        fs.rmSync(path.join(CAPTURES, `${id}.json`), { force: true });
        fs.rmSync(path.join(CAPTURES, `${id}.html`), { force: true });
        return json(res, { ok: true });
      }
      if (m[2]) {
        // Raw saved HTML. Served as text unless ?render=1 (used by the sandboxed preview iframe).
        const html = fs.readFileSync(path.join(CAPTURES, `${id}.html`));
        const render = url.searchParams.get("render") === "1";
        res.writeHead(200, {
          "Content-Type": render ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
          "Content-Security-Policy": "script-src 'none'",
          "Cache-Control": "no-store",
        });
        return res.end(html);
      }
      return send(res, 200, fs.readFileSync(path.join(CAPTURES, `${id}.json`)));
    }

    send(res, 404, "Not found", "text/plain");
  } catch (e: any) {
    console.error("[scribe] request failed:", req.url, e?.message || e);
    if (res.headersSent) return res.end(); // never crash the server on a half-sent response
    json(res, { error: String(e?.message || e) }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`Scribe UI running:`);
  console.log(`  Page 1 (run queries):  http://localhost:${PORT}/`);
  console.log(`  Page 2 (page source):  http://localhost:${PORT}/source`);
  console.log(`Remember to start the path server: ../.venv/bin/python server/server.py`);
});
