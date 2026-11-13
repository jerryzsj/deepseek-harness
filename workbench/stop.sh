#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
state="${HARNESS_STATE:-$root/workbench/.state}"
launcher="$state/launcher.json"

if [ ! -f "$launcher" ]; then
  echo "没有正在运行的工作台。"
  exit 0
fi

pid="$(node -e 'const fs=require("node:fs");try{console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).pid ?? "")}catch{console.log("")}' "$launcher")"

if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
  echo "记录的服务已不在运行，清理启动记录。"
  rm -f "$launcher"
  exit 0
fi

command="$(ps -o command= -p "$pid" 2>/dev/null || true)"
case "$command" in
  *server.mjs*) ;;
  *)
    echo "进程 $pid 不是本工作台服务，未停止。请手动检查。"
    exit 1
    ;;
esac

kill -TERM "$pid" 2>/dev/null || { echo "已停止工作台（进程 $pid 立即退出）。"; rm -f "$launcher"; exit 0; }
for _ in $(seq 1 50); do
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.1
done
if kill -0 "$pid" 2>/dev/null; then
  kill -KILL "$pid" 2>/dev/null || true
  echo "工作台进程 $pid 未响应，已强制结束。"
else
  echo "已停止工作台（进程 $pid）。"
fi
rm -f "$launcher"