#!/usr/bin/env bash
# Fetch the Ollama binary for the current target triple and place it
# in src-tauri/binaries/ so Tauri can bundle it as a sidecar.
#
# Usage:
#   bun run scripts/fetch-ollama.sh              # auto-detect host
#   bun run scripts/fetch-ollama.sh universal    # universal-apple-darwin
#
# Ollama is MIT-licensed, distributed as a Go binary. We just grab the
# executable from inside their distributed .app / archive.

set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p src-tauri/binaries

ARG="${1:-auto}"
HOST_OS="$(uname -s)"
HOST_ARCH="$(uname -m)"

case "$ARG" in
  auto)
    case "$HOST_OS-$HOST_ARCH" in
      Darwin-arm64) TARGET=aarch64-apple-darwin ;;
      Darwin-x86_64) TARGET=x86_64-apple-darwin ;;
      Linux-x86_64) TARGET=x86_64-unknown-linux-gnu ;;
      Linux-aarch64) TARGET=aarch64-unknown-linux-gnu ;;
      *) echo "unsupported host: $HOST_OS-$HOST_ARCH"; exit 1 ;;
    esac ;;
  universal) TARGET=universal-apple-darwin ;;
  *) TARGET="$ARG" ;;
esac

echo "fetching Ollama for $TARGET..."

TMPDIR_R=$(mktemp -d)
trap "rm -rf $TMPDIR_R" EXIT

case "$TARGET" in
  aarch64-apple-darwin|x86_64-apple-darwin|universal-apple-darwin)
    URL="https://ollama.com/download/Ollama-darwin.zip"
    curl -fL -o "$TMPDIR_R/ollama.zip" "$URL"
    unzip -q "$TMPDIR_R/ollama.zip" -d "$TMPDIR_R/extract"
    # The binary lives at Ollama.app/Contents/Resources/ollama (universal).
    SRC="$TMPDIR_R/extract/Ollama.app/Contents/Resources/ollama"
    if [[ ! -f "$SRC" ]]; then
      # Newer Ollama distributions: binary is in Contents/MacOS/
      SRC="$TMPDIR_R/extract/Ollama.app/Contents/MacOS/ollama"
    fi
    if [[ ! -f "$SRC" ]]; then
      # Fallback: search anywhere for the executable
      SRC=$(find "$TMPDIR_R/extract" -type f -name ollama -perm +111 | head -n 1)
    fi
    ;;
  x86_64-unknown-linux-gnu)
    URL="https://ollama.com/download/ollama-linux-amd64.tgz"
    curl -fL -o "$TMPDIR_R/ollama.tgz" "$URL"
    tar -xzf "$TMPDIR_R/ollama.tgz" -C "$TMPDIR_R/extract" --strip-components=0
    SRC="$TMPDIR_R/extract/bin/ollama"
    ;;
  aarch64-unknown-linux-gnu)
    URL="https://ollama.com/download/ollama-linux-arm64.tgz"
    curl -fL -o "$TMPDIR_R/ollama.tgz" "$URL"
    tar -xzf "$TMPDIR_R/ollama.tgz" -C "$TMPDIR_R/extract" --strip-components=0
    SRC="$TMPDIR_R/extract/bin/ollama"
    ;;
  *) echo "unsupported target: $TARGET"; exit 1 ;;
esac

if [[ ! -f "$SRC" ]]; then
  echo "could not locate ollama binary in archive"; exit 1
fi

DEST="src-tauri/binaries/ollama-$TARGET"
cp "$SRC" "$DEST"
chmod +x "$DEST"
echo "wrote $DEST ($(du -h "$DEST" | awk '{print $1}'))"
