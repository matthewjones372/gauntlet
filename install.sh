#!/bin/sh
# Installs the gauntlet binary for this machine from a GitHub release, after
# checking it against the release's checksums.txt.
#
#   curl -fsSL https://raw.githubusercontent.com/matthewjones372/gauntlet/main/install.sh | sh
#
# GAUNTLET_VERSION picks a release (default: the newest, prereleases included).
# GAUNTLET_INSTALL_DIR picks where it goes (default: /usr/local/bin if writable,
# else ~/.local/bin). GAUNTLET_RELEASE_URL replaces the download location, for
# testing a local build.
set -eu

REPO="matthewjones372/gauntlet"

fail() { echo "gauntlet install: $*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "no build for $(uname -s) yet. On Windows, run this inside WSL 2." ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "no build for $(uname -m) yet." ;;
esac
file="gauntlet-$os-$arch"
[ "$file" = "gauntlet-linux-arm64" ] && fail "no build for Linux on ARM yet."

if [ -n "${GAUNTLET_RELEASE_URL:-}" ]; then
  base="$GAUNTLET_RELEASE_URL"
else
  version="${GAUNTLET_VERSION:-}"
  if [ -z "$version" ]; then
    # The newest release, prereleases included (GitHub's "latest" skips them).
    releases=$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=1" 2>/dev/null) ||
      fail "couldn't reach GitHub to find the newest release. Check your internet connection, or that https://github.com/$REPO is public."
    version=$(printf '%s\n' "$releases" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)
    [ -n "$version" ] || fail "$REPO has no releases yet."
  fi
  base="https://github.com/$REPO/releases/download/$version"
fi

if command -v sha256sum >/dev/null 2>&1; then sha="sha256sum"
elif command -v shasum >/dev/null 2>&1; then sha="shasum -a 256"
else fail "need sha256sum or shasum to check the download."
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo "Downloading $file from $base"
download() {
  status=$(curl -sSL -w '%{http_code}' "$1" -o "$2" 2>/dev/null) || fail "couldn't download $1. Check your internet connection."
  case "$status" in
    200) ;;
    404) fail "$1 doesn't exist (404). The release may not be published yet, the version may be wrong, or the repository may be private." ;;
    *) fail "couldn't download $1 (HTTP $status)." ;;
  esac
}
download "$base/$file" "$tmp/$file"
download "$base/checksums.txt" "$tmp/checksums.txt"
expected=$(grep " $file\$" "$tmp/checksums.txt" | cut -d ' ' -f 1)
[ -n "$expected" ] || fail "checksums.txt has no entry for $file."
actual=$($sha "$tmp/$file" | cut -d ' ' -f 1)
[ "$expected" = "$actual" ] || fail "checksum mismatch for $file: the download is corrupt or was tampered with."

dir="${GAUNTLET_INSTALL_DIR:-}"
if [ -z "$dir" ]; then
  if [ -w /usr/local/bin ]; then dir=/usr/local/bin; else dir="$HOME/.local/bin"; fi
fi
mkdir -p "$dir"
chmod +x "$tmp/$file"
mv "$tmp/$file" "$dir/gauntlet"
echo "Installed $("$dir/gauntlet" --version) to $dir/gauntlet"

case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "Add $dir to your PATH, for example: echo 'export PATH=\"$dir:\$PATH\"' >> ~/.zprofile" ;;
esac
