// pm2 config for running both servers on a shared Linux server:
//   pm2 start ecosystem.config.js      (first time)
//   pm2 restart ecosystem.config.js    (after a git pull)
//   pm2 save                           (keep them after a server reboot)
//
// Uses the app's own Node from ../.node/bin when present (the server's default Node may be too old), so other
// apps on the server keep their Node version. Ports default to 3100 / 4100 so they don't clash with apps on 3000 / 4000;
// override with PATH_SERVER_PORT / UI_PORT in the shell before `pm2 start`.
const fs = require("fs");
const path = require("path");

const NODE_BIN = path.join(__dirname, "..", ".node", "bin");
const node = fs.existsSync(path.join(NODE_BIN, "node")) ? path.join(NODE_BIN, "node") : "node";

const env = {
  PATH: fs.existsSync(NODE_BIN) ? `${NODE_BIN}:${process.env.PATH}` : process.env.PATH,
  PATH_SERVER_PORT: process.env.PATH_SERVER_PORT || "3100",
  UI_PORT: process.env.UI_PORT || "4100",
  UI_HOST: process.env.UI_HOST || "127.0.0.1",
  ...(process.env.CHROME_PATH ? { CHROME_PATH: process.env.CHROME_PATH } : {}),
};

module.exports = {
  apps: [
    {
      name: "gsa-path-server", // Python path server (mouse paths), started through the cross-OS launcher
      cwd: __dirname,
      script: "scripts/path-server.js",
      interpreter: node,
      env,
      autorestart: true,
      max_restarts: 10,
    },
    {
      name: "gsa-ui", // UI + job worker + dashboard
      cwd: __dirname,
      script: "node_modules/ts-node/dist/bin.js",
      args: "ui/server.ts",
      interpreter: node,
      env,
      autorestart: true,
      max_restarts: 10,
    },
  ],
};
