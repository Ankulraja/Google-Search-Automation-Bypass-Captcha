// Setup check, on any OS:  npm run doctor
// Prints OK / FAIL for everything the project needs, with the fix for each failure.
import fs from "fs";
import path from "path";
import http from "http";
import { spawnSync } from "child_process";
import { BROWSERS, BROWSER_KINDS, notFoundHint } from "../browsers";

const root = path.join(__dirname, "..");
const win = process.platform === "win32";
let failed = 0;
const ok = (msg: string) => console.log(`  OK    ${msg}`);
const warn = (msg: string) => console.log(`  WARN  ${msg}`);
const fail = (msg: string, fix: string) => {
  failed++;
  console.log(`  FAIL  ${msg}\n        fix: ${fix}`);
};

console.log(`Platform: ${process.platform} ${process.arch}`);

// Node 22.13+ (ui/db.ts uses the built-in node:sqlite)
const [maj, min] = process.versions.node.split(".").map(Number);
if (maj > 22 || (maj === 22 && min >= 13)) ok(`Node ${process.versions.node}`);
else fail(`Node ${process.versions.node} is too old`, "install Node.js 22.13 or newer (LTS 24 recommended)");

// npm packages
if (fs.existsSync(path.join(root, "node_modules", "puppeteer"))) ok("npm packages installed");
else fail("npm packages missing", "cd search-automation && npm install");

// Python venv + packages
const venv = [path.join(root, "..", ".venv"), path.join(root, ".venv")]
  .map((d) => path.join(d, win ? "Scripts" : "bin", win ? "python.exe" : "python"))
  .find((p) => fs.existsSync(p));
if (!venv) {
  fail("Python venv not found at ../.venv", win
    ? "py -3 -m venv .venv  &&  .venv\\Scripts\\pip install -r search-automation\\server\\requirements.txt   (run in repo root)"
    : "python3 -m venv .venv && .venv/bin/pip install -r search-automation/server/requirements.txt   (run in repo root)");
} else {
  const r = spawnSync(venv, ["-c", "import flask, torch, numpy, matplotlib; print(torch.__version__)"], { encoding: "utf8" });
  if (r.status === 0) ok(`Python venv ${venv} (torch ${r.stdout.trim()})`);
  else fail("Python packages missing in venv", `${venv} -m pip install -r server/requirements.txt   (run in search-automation)`);
}

// Trained model
const models = fs.existsSync(path.join(root, "model")) ? fs.readdirSync(path.join(root, "model")).filter((f) => f.endsWith(".pt")) : [];
if (models.length) ok(`Model: model/${models.sort().slice(-1)[0]}`);
else fail("No trained model (*.pt) in search-automation/model/", "git pull (the model is committed) or train one, see README");

// Browsers
const found = BROWSER_KINDS.filter((k) => BROWSERS[k].exe);
for (const k of BROWSER_KINDS) {
  const b = BROWSERS[k];
  if (b.exe) ok(`${b.label}: ${b.exe}${b.src ? "" : "  (no profile folder yet: logged-in mode needs the browser opened once)"}`);
  else warn(notFoundHint(k) + " The option is disabled in the UI.");
}
if (!found.length) fail("No supported browser found", "install Google Chrome or Brave, or set CHROME_PATH / BRAVE_PATH");

if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)
  warn("No display (DISPLAY / WAYLAND_DISPLAY unset): runs are forced to headless.");

// Path server reachable?
const PATH_PORT = Number(process.env.PATH_SERVER_PORT || 3000);
const req = http.get(`http://127.0.0.1:${PATH_PORT}/generate_path?start_point=0,0&end_point=10,10`, (res) => {
  res.resume();
  if (res.statusCode === 200) ok(`Path server is running on :${PATH_PORT}`);
  else warn(`Path server on :${PATH_PORT} answered ${res.statusCode} (is another app using this port? set PATH_SERVER_PORT)`);
  done();
});
req.on("error", () => {
  warn(`Path server is not running on :${PATH_PORT} (start it with: npm run path-server)`);
  done();
});
req.setTimeout(3000, () => req.destroy());

function done() {
  console.log(failed ? `\n${failed} problem(s) to fix.` : "\nAll required checks passed.");
  process.exit(failed ? 1 : 0);
}
