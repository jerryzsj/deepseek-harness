#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")" && pwd)"
build="$root/build"
app="$build/Harness.app"
contents="$app/Contents"

rm -rf "$app"
mkdir -p "$contents/MacOS" "$contents/Resources"

cat > "$contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Harness</string>
  <key>CFBundleDisplayName</key><string>DeepSeek Harness</string>
  <key>CFBundleExecutable</key><string>Harness</string>
  <key>CFBundleIdentifier</key><string>local.mycodex.harness</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.2.2</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
</dict>
</plist>
PLIST

swiftc \
  -O \
  -target "arm64-apple-macos13.0" \
  -framework AppKit \
  -framework WebKit \
  -o "$contents/MacOS/Harness" \
  "$root/Sources/HarnessApp/main.swift"

codesign --force --sign - "$app" >/dev/null 2>&1 || true
echo "$app"