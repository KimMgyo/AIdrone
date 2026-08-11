#!/usr/bin/env bash
# Checks a built .deb declares every shared library it actually links.
#
# This exists because the FFmpeg packages cannot be named once and be right
# everywhere: the binary links a specific SONAME, and Ubuntu renames the
# package with it - 22.04 has libavcodec58, 24.04 libavcodec60, and a future
# release will have another. A .deb is therefore built per Ubuntu release, and
# the failure mode of getting that wrong is the worst kind: `apt install`
# succeeds against a satisfiable-looking name and the app dies at exec time
# with a missing .so. Run this after `tauri build --bundles deb` and that
# becomes a build failure with the exact name to put in tauri.linux.conf.json.
#
# The t64 renames (libasound2 -> libasound2t64, libgtk-3-0 -> libgtk-3-0t64)
# deliberately do NOT need per-release handling: the new packages Provide the
# old names, which this script resolves the same way apt would.
set -u

DEB=${1:-}
if [ -z "$DEB" ] || [ ! -f "$DEB" ]; then
  echo "usage: $0 <path to .deb>" >&2
  exit 2
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
dpkg-deb -x "$DEB" "$WORK/root"
dpkg-deb -f "$DEB" Depends | tr ',' '\n' | sed 's/^ *//;s/ .*//' | grep -v '^$' | sort -u > "$WORK/declared"

BIN=$(find "$WORK/root/usr/bin" -maxdepth 1 -type f -perm -u+x | head -1)
if [ -z "$BIN" ]; then
  echo "no executable found in usr/bin" >&2
  exit 1
fi

# Only the libraries this project pulls in beyond the base system: glibc and
# friends are guaranteed present and listing them would be noise.
objdump -p "$BIN" | awk '/NEEDED/ {print $2}' \
  | grep -E '^lib(av|sw|asound|webkit|gtk|soup|javascriptcore)' | sort -u > "$WORK/needed"

status=0
echo "binary: ${BIN#"$WORK/root"}"
while read -r soname; do
  [ -n "$soname" ] || continue
  # The package owning the SONAME on this machine is the one to depend on.
  owner=$(dpkg -S "$soname" 2>/dev/null | head -1 | cut -d: -f1)
  if [ -z "$owner" ]; then
    printf '  ?? %-26s no package owns it here - is it a build-tree artefact?\n' "$soname"
    status=1
    continue
  fi
  # Accept either the owning package or any name it Provides, because that is
  # exactly what apt will accept when resolving the dependency.
  provides=$(dpkg-query -W -f='${Provides}' "$owner" 2>/dev/null | tr ',' '\n' | sed 's/^ *//;s/ .*//')
  if grep -qxF "$owner" "$WORK/declared" || { [ -n "$provides" ] && echo "$provides" | grep -qxFf - "$WORK/declared"; }; then
    printf '  ok %-26s %s\n' "$soname" "$owner"
  else
    printf '  MISSING %-21s add "%s" to bundle.linux.deb.depends\n' "$soname" "$owner"
    status=1
  fi
done < "$WORK/needed"

# The reverse direction matters too: a name left over from another release
# resolves to nothing and makes the package uninstallable rather than broken.
while read -r dep; do
  [ -n "$dep" ] || continue
  if ! apt-cache policy "$dep" 2>/dev/null | grep -q 'Candidate: [^(]' \
     && ! apt-cache showpkg "$dep" 2>/dev/null | sed -n '/^Reverse Provides:/,$p' | tail -n +2 | grep -q .; then
    printf '  STALE   %-21s declared but no package on this release provides it\n' "$dep"
    status=1
  fi
done < "$WORK/declared"

[ "$status" -eq 0 ] && echo "deb dependencies match the binary" || echo "deb dependencies are wrong for this release" >&2
exit "$status"
