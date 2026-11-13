#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
state="${HARNESS_STATE:-$root/workbench/.state}"
launcher="$state/launcher.json"
app="${HARNESS_APP:-$root/workbench/native-mac/build/Harness.app}"

url=""
if [ -f "$launcher" ]; then
  url="$(node -e '
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
let record;
try { record = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { process.exit(0); }
if (!record || !Number.isInteger(record.pid) || typeof record.url !== "string") process.exit(0);
try { process.kill(record.pid, 0); } catch { process.exit(0); }
let command = "";
try { command = execFileSync("ps", ["-o", "command=", "-p", String(record.pid)], { encoding: "utf8" }); } catch { process.exit(0); }
if (!command.includes("server.mjs")) process.exit(0);
process.stdout.write(record.url);
' "$launcher")"
fi

if [ -z "$url" ]; then
  echo "工作台没有在运行。请先执行：bash $root/workbench/launch.sh" >&2
  exit 1
fi

if [ -d "$app" ]; then
  exec /usr/bin/open -a "$app" --args --attach "$url"
fi
exec /usr/bin/open "$url"