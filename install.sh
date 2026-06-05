#!/bin/sh
# stet installer — builds the single-file binary and puts it on your PATH.
set -e
command -v node >/dev/null 2>&1 || { echo "stet requires Node.js >= 18" >&2; exit 1; }
cd "$(dirname "$0")"
node build.mjs
BIN_DIR="${STET_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$BIN_DIR"
cp dist/stet "$BIN_DIR/stet"
chmod +x "$BIN_DIR/stet"
echo "installed $BIN_DIR/stet"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "note: $BIN_DIR is not on your PATH — add: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
