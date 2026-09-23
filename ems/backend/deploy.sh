#!/usr/bin/env bash
# deploy.sh — upload a built .tapp to a Tasmota device and remove the stale ones.
#
# Tasmota executes autoexec.be from EVERY *.tapp in the filesystem root. The
# build stamps the version into the filename (ems-v1.0.9.tapp), so a plain
# upload does NOT replace the previous release: both apps boot, the whole
# module graph is built twice, two multicast sockets are opened, and the boot
# heap roughly doubles on an ESP32-C3 — a crash inside Tasmota's 10 s
# fast-reboot window, i.e. a boot loop ("FRC: Some settings have been reset").
# So: delete first, upload second.
#
# Usage:
#   ./deploy.sh <device> [tapp]          # defaults to the newest build/*.tapp
#   DRYRUN=1 ./deploy.sh <device>        # show what would be deleted, do nothing
#   WEBUSER=admin WEBPASS=secret ./deploy.sh <device>
set -euo pipefail

DEVICE="${1:-}"
TAPP="${2:-}"
[ -n "$DEVICE" ] || { echo "usage: $0 <device-ip-or-host> [file.tapp]" >&2; exit 2; }

if [ -z "$TAPP" ]; then
    TAPP=$(ls -t build/*.tapp 2>/dev/null | head -1 || true)
fi
[ -n "$TAPP" ] && [ -f "$TAPP" ] || { echo "no .tapp found — run 'make' first" >&2; exit 2; }
NEW=$(basename "$TAPP")

AUTH=""
if [ -n "${WEBUSER:-}" ]; then
    AUTH="&user=${WEBUSER}&password=${WEBPASS:-}"
fi

cmnd() {   # cmnd <tasmota-command>
    curl -fsS --get "http://${DEVICE}/cm" \
         --data-urlencode "cmnd=$1" ${AUTH:+--data "${AUTH#&}"}
}

echo "device : ${DEVICE}"
echo "upload : ${NEW} ($(wc -c <"$TAPP" | tr -d ' ') bytes)"

# The file-manager page is the only listing stock Tasmota exposes; scrape the
# .tapp names out of it.
LISTING=$(curl -fsS "http://${DEVICE}/ufsd?${AUTH}" || true)
STALE=$(printf '%s' "$LISTING" \
        | grep -oE '[A-Za-z0-9._-]+\.tapp' \
        | sort -u \
        | grep -vx "$NEW" || true)

if [ -z "$STALE" ]; then
    echo "stale  : none"
else
    echo "stale  : $(printf '%s' "$STALE" | tr '\n' ' ')"
fi

if [ -n "${DRYRUN:-}" ]; then
    echo "DRYRUN set — nothing uploaded or deleted."
    exit 0
fi

for f in $STALE; do
    echo "deleting /$f"
    cmnd "Ufsdelete /$f" >/dev/null
done

echo "uploading $NEW"
curl -fsS -F "file=@${TAPP}" "http://${DEVICE}/ufsu?${AUTH}" >/dev/null

echo "restarting"
cmnd "Restart 1" >/dev/null || true
echo "done — watch the serial/web console for 'boot mem:' marks"
