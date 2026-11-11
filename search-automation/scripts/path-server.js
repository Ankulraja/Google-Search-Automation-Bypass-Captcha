// Start the Python path server (server/server.py) with the project's virtualenv, on any OS.
//   npm run path-server
// Looks for the venv at ../.venv (repo root) or ./.venv; falls back to python3 / python on PATH.
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const here = path.join(__dirname, "..");
const win = process.platform === "win32";
const venvPython = (dir) => path.join(dir, win ? "Scripts" : "bin", win ? "python.exe" : "python");

const candidates = [venvPython(path.join(here, "..", ".venv")), venvPython(path.join(here, ".venv"))];
let python = candidates.find((p) => fs.existsSync(p));
if (!python) {
  python = (win ? ["py", "python", "python3"] : ["python3", "python"]).find(
    (c) => spawnSync(c, ["--version"], { stdio: "ignore" }).status === 0
  );
  if (!python) {
    console.error("Python 3.10+ not found. Create the venv first (see SETUP in CLAUDE.md / README.md).");
    process.exit(1);
  }
  console.warn(`[path-server] No .venv found, using "${python}" from PATH.`);
}

console.log(`[path-server] ${python} server/server.py  (http://localhost:3000)`);
const child = spawn(python, [path.join("server", "server.py")], { cwd: here, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
