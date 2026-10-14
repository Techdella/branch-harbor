#!/usr/bin/env bash
# Syntax-check every PHP file, then run WordPress Coding Standards if phpcs is installed
# (composer install in this folder provides vendor/bin/phpcs).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail=0
while IFS= read -r -d '' f; do
	php -l "$f" >/dev/null || { echo "syntax error: $f" >&2; fail=1; }
done < <(find "$ROOT/branchharbor" "$ROOT/tests" -name '*.php' -print0)
[ "$fail" -eq 0 ] || exit 1
echo "php -l: ok"

PHPCS="${PHPCS:-$ROOT/vendor/bin/phpcs}"
if [ -x "$PHPCS" ]; then
	"$PHPCS" --standard="$ROOT/phpcs.xml.dist" -q
	echo "phpcs (WordPress-Extra + PHPCompatibilityWP): ok"
else
	echo "phpcs not installed; run 'composer install' in apps/wordpress-plugin to enable WordPress Coding Standards."
fi
