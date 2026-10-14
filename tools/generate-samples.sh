#!/usr/bin/env bash
# Regenerates samples/*.bin with the real RestroX ESC/POS generator, so the
# emulator is tested against exactly the bytes the app sends through QZ.
#
#   tools/generate-samples.sh [path/to/restroXfrontend]
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
repo="${1:-$here/../restroXfrontend}"
web="$repo/apps/web"
esbuild="$(ls -d "$repo"/node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild | head -1)"
out="$(mktemp -d)"
trap 'rm -rf "$out"; rm -f "$web"/src/__emu_*.ts' EXIT

bundle() {
  # Inside apps/web so esbuild picks up its tsconfig paths (@/…).
  cp "$here/tools/$1.ts" "$web/src/__emu_$1.ts"
  (cd "$web" && "$esbuild" "src/__emu_$1.ts" --bundle --platform=node --format=esm \
    --outfile="$out/$1.mjs" --log-level=error \
    --banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);")
}

bundle test-print
bundle fixture
for paper in 80 58; do
  node "$out/test-print.mjs" "$here/samples/test-print-$paper.bin" "$paper"
  node "$out/fixture.mjs" "$here/samples" "$paper"
done
