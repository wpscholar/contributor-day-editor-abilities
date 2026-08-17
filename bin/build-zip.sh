#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_SLUG="contributor-day"
DIST_DIR="${ROOT}/dist"
ZIP_PATH="${DIST_DIR}/${PLUGIN_SLUG}.zip"

mkdir -p "${DIST_DIR}"
rm -f "${ZIP_PATH}"

STAGE="$(mktemp -d)"
cleanup() {
	rm -rf "${STAGE}"
}
trap cleanup EXIT

mkdir -p "${STAGE}/${PLUGIN_SLUG}"

cp "${ROOT}/contributor-day.php" "${STAGE}/${PLUGIN_SLUG}/"
cp -R "${ROOT}/js" "${STAGE}/${PLUGIN_SLUG}/js"
cp -R "${ROOT}/css" "${STAGE}/${PLUGIN_SLUG}/css"
cp -R "${ROOT}/includes" "${STAGE}/${PLUGIN_SLUG}/includes"

(
	cd "${STAGE}"
	zip -r "${ZIP_PATH}" "${PLUGIN_SLUG}" \
		-x "*.DS_Store" \
		-x "*/.git/*" \
		-x "*/node_modules/*"
)

echo "Created ${ZIP_PATH}"
unzip -l "${ZIP_PATH}"
