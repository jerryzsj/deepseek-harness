#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
runtime="$root/workbench/runtime"

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
unset npm_config_registry npm_config_offline npm_config_fetch_retries npm_config_user_agent

version="$(node -p 'process.versions.node')"
major="${version%%.*}"
if [ "$major" -lt 24 ]; then
  echo "当前 Node.js $version 过低，需要 24.9 或更新版本。" >&2
  exit 1
fi

for manifest in package.json package-lock.json; do
  if [ ! -f "$runtime/$manifest" ]; then
    echo "运行时清单缺失：${runtime}/${manifest}。请从当前仓库恢复该文件后重试。" >&2
    exit 1
  fi
done

cd "$runtime"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund

node -e '
const read = file => require("node:fs").readFileSync(file, "utf8");
const pkg = name => JSON.parse(read(`node_modules/${name}/package.json`));
const manifest = pkg("@deepseek-ai/dsh");
const context = pkg("dsh-context");
if (manifest.version !== "0.2.2-rc.1" || context.version !== "0.82.2") {
  console.error(`版本不匹配：dsh ${manifest.version} / dsh-context ${context.version}`);
  process.exit(1);
}
'

cd "$root"
state="${HARNESS_STATE:-$root/workbench/.state}"
mkdir -p "$state"
node workbench/context-patch.mjs workbench/runtime/node_modules/dsh-context "$state/context-patches"

bash workbench/native-mac/build.sh
echo "Harness 运行时与原生窗口已就绪。"