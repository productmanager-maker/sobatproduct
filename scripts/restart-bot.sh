#!/usr/bin/env bash
# Restart bot sobatproduct DENGAN notif "🟢 Sobat Product online." ke admin.
#
# Kenapa ada file ini: sejak 2026-09-11 bot cuma kirim notif online kalau
# restart-nya memang dari kita, bukan auto-restart Docker (crash/OOM/hiccup
# jaringan) — lihat blok "Polling error + notif online" di index.js.
# Jadi kalau mau tim dapet notif "udah online lagi", pakai script ini.
#
# Pakai:  ./scripts/restart-bot.sh            (restart container, kirim notif)
#         NOTIFY=0 ./scripts/restart-bot.sh   (restart senyap, tanpa notif)
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "${NOTIFY:-1}" = "1" ]; then
  mkdir -p data
  touch data/notify-online
  echo "[restart-bot] marker data/notify-online dibuat -> bot akan kirim notif online."
else
  echo "[restart-bot] mode senyap (NOTIFY=0) -> tanpa notif online."
fi

docker compose restart sobatproduct
echo "[restart-bot] selesai. Cek log: docker logs sobatproduct --tail 20"
