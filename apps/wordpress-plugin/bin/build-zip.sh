#!/usr/bin/env bash
# Build a WordPress.org-ready zip of the plugin: dist/branchharbor.zip (folder "branchharbor/" inside).
# Runs `php -l` on every PHP file and the standalone unit tests first; aborts on any failure.
#
#   bash bin/build-zip.sh            # from apps/wordpress-plugin
#   SKIP_TESTS=1 bash bin/build-zip.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/branchharbor"
DIST="$ROOT/dist"
OUT="$DIST/branchharbor.zip"

command -v php >/dev/null || { echo "php is required" >&2; exit 1; }

echo "› php -l"
fail=0
while IFS= read -r -d '' f; do
	php -l "$f" >/dev/null || { echo "  syntax error: $f" >&2; fail=1; }
done < <(find "$SRC" "$ROOT/tests" -name '*.php' -print0)
[ "$fail" -eq 0 ] || exit 1

if [ "${SKIP_TESTS:-0}" != "1" ]; then
	echo "› unit tests"
	php "$ROOT/tests/run.php" >/dev/null || { php "$ROOT/tests/run.php" | tail -20; exit 1; }
fi

VERSION="$(sed -n 's/^ \* Version: *//p' "$SRC/branchharbor.php" | tr -d '[:space:]')"
STABLE="$(sed -n 's/^Stable tag: *//p' "$SRC/readme.txt" | tr -d '[:space:]')"
CONST="$(sed -n "s/^define( 'BRANCHHARBOR_VERSION', '\(.*\)' );/\1/p" "$SRC/branchharbor.php")"
if [ "$VERSION" != "$STABLE" ] || [ "$VERSION" != "$CONST" ]; then
	echo "Version mismatch: header=$VERSION readme=$STABLE constant=$CONST" >&2
	exit 1
fi

echo "› packaging $VERSION"
mkdir -p "$DIST"
rm -f "$OUT"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
# Copy without dev clutter (the plugin folder contains only distributable files, but be defensive).
tar -C "$ROOT" \
	--exclude='.DS_Store' --exclude='*.map' --exclude='node_modules' --exclude='.git*' \
	-cf - branchharbor | tar -C "$STAGE" -xf -

if command -v zip >/dev/null; then
	(cd "$STAGE" && zip -qr -X "$OUT" branchharbor)
else
	php -r '
		$stage = $argv[1]; $out = $argv[2];
		$zip = new ZipArchive();
		$zip->open( $out, ZipArchive::CREATE | ZipArchive::OVERWRITE ) || exit( 1 );
		$it = new RecursiveIteratorIterator( new RecursiveDirectoryIterator( "$stage/branchharbor", FilesystemIterator::SKIP_DOTS ) );
		foreach ( $it as $file ) { $zip->addFile( $file->getPathname(), substr( $file->getPathname(), strlen( $stage ) + 1 ) ); }
		$zip->close();
	' "$STAGE" "$OUT"
fi

echo "› $OUT ($(du -h "$OUT" | cut -f1))"
