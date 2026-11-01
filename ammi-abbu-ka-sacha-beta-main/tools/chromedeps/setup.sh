#!/usr/bin/env bash
# Screenshot-only Chromium deps (dekho README.md). Idempotent.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$DIR/libnss-stub"
REPO="Raspberrynani/darkly-patched"
BASE="squashfs-data/usr/lib/x86_64-linux-gnu"
mkdir -p "$OUT"

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI chahiye (public repo se libs laane ke liye)." >&2; exit 1
fi

for f in libnspr4.so libnssutil3.so libplc4.so libplds4.so libssl3.so libsmime3.so; do
  [ -s "$OUT/$f" ] || gh api "repos/$REPO/contents/$BASE/$f?ref=main" -H "Accept: application/vnd.github.raw" > "$OUT/$f"
done

# Chromium ka asli NSS symbol set nikaalo, phir stub banao.
CHROME="${CHROME_PATH:-/tmp/chromium}"
if [ -x "$CHROME" ]; then
  objdump -T "$CHROME" | grep UND | grep "NSS_" | awk '{print $NF, $(NF-1)}' | sed 's/[()]//g' > "$DIR/nss_syms.txt"
  python3 - "$DIR" <<'PY'
import re, sys, collections, pathlib
d = pathlib.Path(sys.argv[1])
rows = [l.split() for l in (d / 'nss_syms.txt').read_text().splitlines() if l.strip()]
byver = collections.OrderedDict()
for sym, ver in rows:
    if ver.startswith('NSSUTIL'):
        continue
    byver.setdefault(ver, []).append(sym)
src = ['/* Screenshot-only NSS stub — local HTTP preview ke liye. Kabhi ship nahi hota. */']
for syms in byver.values():
    src += [f'long {s}(void){{ return 0; }}' for s in syms]
(d / 'stub_nss3.c').write_text('\n'.join(src) + '\n')
order = sorted(byver, key=lambda v: [int(x) for x in re.findall(r'\d+', v)])
map_, prev = [], None
for ver in order:
    map_.append(f"{ver} {{ global: {'; '.join(byver[ver])}; }}{(' ' + prev) if prev else ''};")
    prev = ver
(d / 'stub_nss3.map').write_text('\n'.join(map_) + '\n')
PY
  gcc -shared -fPIC -O1 -o "$OUT/libnss3.so" "$DIR/stub_nss3.c" -Wl,--version-script="$DIR/stub_nss3.map"
  echo "stub ready: $OUT/libnss3.so"
else
  echo "warning: $CHROME nahi mila — stub libnss3.so skip. (CHROME_PATH set karo)" >&2
fi
echo "done → $OUT"
