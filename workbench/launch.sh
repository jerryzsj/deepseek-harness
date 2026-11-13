#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
state="${HARNESS_STATE:-$root/workbench/.state}"
launcher="$state/launcher.json"

restart=0
no_open=0
for argument in "$@"; do
  case "$argument" in
    --restart) restart=1 ;;
    --no-open) no_open=1 ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js。请安装 Node.js 24.9 或更新版本后重试。" >&2
  exit 1
fi

version="$(node -p 'process.versions.node')"
major="${version%%.*}"
if [ "$major" -lt 24 ]; then
  echo "当前 Node.js $version 过低，需要 24.9 或更新版本。" >&2
  exit 1
fi

if [ ! -f "$root/workbench/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js" ]; then
  echo "运行时尚未安装。请先执行：bash workbench/install.sh" >&2
  exit 1
fi

app="$root/workbench/native-mac/build/Harness.app"
if [ ! -d "$app" ]; then
  echo "原生窗口尚未构建，正在构建…"
  bash "$root/workbench/native-mac/build.sh"
fi

mkdir -p "$state"
chmod 700 "$state"

if [ "$restart" = 1 ]; then
  bash "$root/workbench/stop.sh"
fi

running=""
if [ -f "$launcher" ]; then
  running="$(node -e '
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

if [ -n "$running" ]; then
  echo "工作台已在运行，正在打开界面。重启请执行：bash workbench/launch.sh --restart"
  if [ "$no_open" = 1 ]; then
    exit 0
  fi
  if [ -d "$app" ]; then
    exec /usr/bin/open -a "$app" --args --attach "$running"
  fi
  exec /usr/bin/open "$running"
fi

exec node "$root/workbench/server.mjs" "$@"