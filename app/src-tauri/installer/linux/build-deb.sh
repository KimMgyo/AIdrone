#!/usr/bin/env bash
# Builds a .deb whose dependencies are correct for whatever Ubuntu this runs on.
#
# The problem this solves: the binary links a specific FFmpeg SONAME and Ubuntu
# renames the package along with it - libavcodec58 on 22.04, 60 on 24.04, 62 on
# 26.04 - so a hardcoded `depends` list in tauri.linux.conf.json is right for
# exactly one release and quietly wrong everywhere else. Rather than ask
# whoever builds it to remember, the list is derived from the binary that was
# just built and handed to the bundler through `--config`.
#
# GStreamer codec plugins are loaded dynamically, so they never appear in the
# executable's `DT_NEEDED` list. WebKitGTK needs the fixed runtime dependency
# declared below to decode the Tello's H.264 stream.
#
# Two passes, because the dependency list is a function of the binary and the
# binary does not exist until the first one. The second pass is cheap: Cargo is
# already warm, so only the bundling step runs again.
set -euo pipefail

cd "$(dirname "$0")/../.."          # src-tauri
APP_DIR=$(cd .. && pwd)             # the Tauri project root, where bun runs
cd "$APP_DIR"

# Only the libraries this project pulls in beyond the base system; glibc and
# friends are guaranteed present and naming them would be noise.
INTERESTING='^lib(av|sw|asound|webkit|gtk|soup|javascriptcore)'

# `avdec_h264` is supplied by the dynamically-loaded GStreamer libav plugin.
# Do not make this a Recommends: without it, the app can connect but WebKitGTK
# has no H.264 decoder to paint the Tello stream.
WEBKIT_H264_RUNTIME_DEPENDENCIES=(gstreamer1.0-libav)

echo "==> pass 1: build the binary"
bun run tauri build --bundles deb

BIN=$(find "${CARGO_TARGET_DIR:-src-tauri/target}/release" -maxdepth 1 -type f -name app -perm -u+x | head -1)
[ -n "$BIN" ] || { echo "no release binary found" >&2; exit 1; }

echo
echo "==> resolving dependencies from $BIN"
depends=()
while read -r soname; do
  [ -n "$soname" ] || continue
  owner=$(dpkg -S "$soname" 2>/dev/null | head -1 | cut -d: -f1)
  if [ -z "$owner" ]; then
    echo "  !! $soname is owned by no package - refusing to guess" >&2
    exit 1
  fi
  printf '  %-30s %s\n' "$soname" "$owner"
  depends+=("$owner")
done < <(objdump -p "$BIN" | awk '/NEEDED/ {print $2}' | grep -E "$INTERESTING" | sort -u)

# DT_NEEDED cannot reveal GStreamer plugins, which WebKitGTK looks up after it
# starts. Include the H.264 decoder explicitly and avoid duplicate control-file
# entries when a future binary also adds the same package.
depends+=("${WEBKIT_H264_RUNTIME_DEPENDENCIES[@]}")
mapfile -t depends < <(printf '%s\n' "${depends[@]}" | sort -u)

# JSON array without needing jq, which is not a build dependency anywhere else.
list=$(printf '"%s",' "${depends[@]}"); list="[${list%,}]"

# Pass 1 created a deliberately throwaway package. Remove only this app's
# previous packages before pass 2 so `find | head` can never verify an older
# version or architecture instead of the artifact we are about to release.
BUNDLE_DIR="${CARGO_TARGET_DIR:-src-tauri/target}/release/bundle/deb"
find "$BUNDLE_DIR" -maxdepth 1 -type f -name 'AIdrone_*.deb' -delete

echo
echo "==> pass 2: bundle with $list"
bun run tauri build --bundles deb --config "{\"bundle\":{\"linux\":{\"deb\":{\"depends\":$list}}}}"

mapfile -t packages < <(find "$BUNDLE_DIR" -maxdepth 1 -type f -name 'AIdrone_*.deb' -print)
if [ "${#packages[@]}" -ne 1 ]; then
  echo "expected exactly one pass-2 AIdrone .deb in $BUNDLE_DIR, found ${#packages[@]}" >&2
  exit 1
fi
DEB=${packages[0]}
echo
echo "==> verifying $DEB"
bash src-tauri/installer/linux/verify-deb.sh "$DEB"
