import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

// Cross-OS browser support (macOS, Windows, Linux): find the installed Chrome / Brave executable,
// find where its real user profiles live, and copy one profile so automation never touches the original.

export type BrowserKind = "chrome" | "brave";
export const BROWSER_KINDS: BrowserKind[] = ["chrome", "brave"];

export interface BrowserInfo {
  kind: BrowserKind;
  label: string;
  exe?: string; // undefined = not installed / not found
  src?: string; // folder holding the browser's real profiles ("User Data"); undefined = not found
  copy: string; // where we keep our copy of a profile for logged-in mode
}

const home = os.homedir();
const plat = process.platform; // "darwin" | "win32" | "linux" | ...

// Windows install roots. Chrome/Brave install per-machine (Program Files) or per-user (LocalAppData).
const winRoots = () =>
  [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA, process.env.PROGRAMW6432].filter(
    (x): x is string => !!x
  );
const localAppData = () => process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
const xdgConfig = () => process.env.XDG_CONFIG_HOME || path.join(home, ".config");

// Candidate executable paths per OS (first existing one wins)
function exeCandidates(kind: BrowserKind): string[] {
  if (plat === "darwin") {
    const app = kind === "chrome" ? "Google Chrome.app/Contents/MacOS/Google Chrome" : "Brave Browser.app/Contents/MacOS/Brave Browser";
    return [path.join("/Applications", app), path.join(home, "Applications", app)];
  }
  if (plat === "win32") {
    const rel = kind === "chrome" ? ["Google", "Chrome", "Application", "chrome.exe"] : ["BraveSoftware", "Brave-Browser", "Application", "brave.exe"];
    return winRoots().map((r) => path.join(r, ...rel));
  }
  // Linux / other Unix
  const names = kind === "chrome" ? ["google-chrome", "google-chrome-stable"] : ["brave-browser", "brave-browser-stable", "brave"];
  const fixed =
    kind === "chrome"
      ? ["/opt/google/chrome/chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"]
      : ["/opt/brave.com/brave/brave", "/usr/bin/brave-browser", "/usr/bin/brave-browser-stable", "/snap/bin/brave"];
  return [...fixed, ...names.map(whichSync).filter((x): x is string => !!x)];
}

// Look a command up on PATH (Linux). Returns undefined when it is not there.
function whichSync(cmd: string): string | undefined {
  try {
    const out = execFileSync("which", [cmd], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

// Where the browser keeps its real profiles ("User Data" folder that contains "Local State")
function profileRootCandidates(kind: BrowserKind): string[] {
  if (plat === "darwin") {
    const as = path.join(home, "Library", "Application Support");
    return [kind === "chrome" ? path.join(as, "Google", "Chrome") : path.join(as, "BraveSoftware", "Brave-Browser")];
  }
  if (plat === "win32") {
    return [kind === "chrome" ? path.join(localAppData(), "Google", "Chrome", "User Data") : path.join(localAppData(), "BraveSoftware", "Brave-Browser", "User Data")];
  }
  return kind === "chrome"
    ? [path.join(xdgConfig(), "google-chrome")]
    : [path.join(xdgConfig(), "BraveSoftware", "Brave-Browser"), path.join(home, "snap", "brave", "current", ".config", "BraveSoftware", "Brave-Browser")];
}

const isFile = (p: string) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

// Env overrides: CHROME_PATH / BRAVE_PATH (executable), CHROME_PROFILE_DIR / BRAVE_PROFILE_DIR (User Data folder),
// PROFILE_COPY (Brave copy folder, kept for backwards compatibility) / CHROME_PROFILE_COPY / BRAVE_PROFILE_COPY.
export function detectBrowser(kind: BrowserKind): BrowserInfo {
  const K = kind.toUpperCase();
  const envExe = process.env[`${K}_PATH`];
  const exe = envExe ? (isFile(envExe) ? envExe : undefined) : exeCandidates(kind).find(isFile);
  const envSrc = process.env[`${K}_PROFILE_DIR`];
  const src = [envSrc, ...profileRootCandidates(kind)].find((d): d is string => !!d && fs.existsSync(d));
  const copy =
    process.env[`${K}_PROFILE_COPY`] || (kind === "brave" ? process.env.PROFILE_COPY : undefined) || path.join(os.tmpdir(), `gsa-${kind}-profile`);
  return { kind, label: kind === "chrome" ? "Google Chrome" : "Brave", exe, src, copy };
}

// Detected once per process start (restart the server after installing a browser)
export const BROWSERS: Record<BrowserKind, BrowserInfo> = { chrome: detectBrowser("chrome"), brave: detectBrowser("brave") };

// Large caches that are not needed for a logged-in session; skipping them makes the copy much faster
const SKIP_DIRS = new Set(["Cache", "Code Cache", "GPUCache", "DawnCache", "GrShaderCache", "GraphiteDawnCache", "ShaderCache", "CacheStorage"]);

export interface CopyResult {
  skipped: string[]; // files that could not be copied (usually locked by the running browser, mainly on Windows)
}

/**
 * Copy one profile ("Default", "Profile 2", ...) plus "Local State" into our own user-data folder.
 * Pure Node (no cp/rsync), so it works on every OS. Files that are locked are skipped and reported.
 * The previous copy is only replaced once the new one is complete.
 */
export function copyProfile(kind: BrowserKind, profile: string): CopyResult {
  const { src, copy, label } = BROWSERS[kind];
  if (!src) throw new Error(`${label} profile folder not found on this computer. Open ${label} once, or set ${kind.toUpperCase()}_PROFILE_DIR.`);
  if (!/^[\w .-]+$/.test(profile)) throw new Error(`Invalid profile name: ${profile}`);
  const from = path.join(src, profile);
  if (!fs.existsSync(from)) throw new Error(`${label} profile "${profile}" not found in ${src}`);

  fs.mkdirSync(copy, { recursive: true });
  // Reading the profile folder is where macOS privacy (Full Disk Access) fails; let that error surface first
  fs.readdirSync(from);
  const skipped: string[] = [];
  const staging = path.join(copy, `${profile}.gsa-new`);
  fs.rmSync(staging, { recursive: true, force: true });
  copyTree(from, staging, skipped, from);
  fs.copyFileSync(path.join(src, "Local State"), path.join(copy, "Local State"));

  const dest = path.join(copy, profile);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(staging, dest);
  // Lock files left by an earlier run of our copy would make the browser think it is already open
  for (const f of fs.readdirSync(copy)) if (/^Singleton|^lockfile$/i.test(f)) fs.rmSync(path.join(copy, f), { force: true });
  return { skipped };
}

function copyTree(from: string, to: string, skipped: string[], root: string) {
  fs.mkdirSync(to, { recursive: true });
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, ent.name);
    const d = path.join(to, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      copyTree(s, d, skipped, root);
    } else if (ent.isFile()) {
      if (/^(Singleton|LOCK$|lockfile$)/.test(ent.name)) continue;
      try {
        fs.copyFileSync(s, d);
      } catch (e: any) {
        // EBUSY / EPERM / EACCES: the running browser holds this file open (common on Windows). Skip it.
        if (/EBUSY|EPERM|EACCES|ENOENT/.test(String(e?.code || e?.message))) skipped.push(path.relative(root, s));
        else throw e;
      }
    }
    // symlinks and sockets are skipped on purpose
  }
}

/** Human-readable install hint for the UI and logs */
export function notFoundHint(kind: BrowserKind): string {
  const K = kind.toUpperCase();
  const where =
    plat === "win32"
      ? kind === "chrome"
        ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
        : "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
      : plat === "darwin"
        ? kind === "chrome"
          ? "/Applications/Google Chrome.app"
          : "/Applications/Brave Browser.app"
        : kind === "chrome"
          ? "google-chrome on PATH"
          : "brave-browser on PATH";
  const env = process.env[`${K}_PATH`];
  if (env) return `${BROWSERS[kind].label} was not found at ${K}_PATH=${env}. Fix or unset ${K}_PATH, then restart the server.`;
  return `${BROWSERS[kind].label} was not found (looked for ${where}). Install it, or set ${K}_PATH to its executable, then restart the server.`;
}
