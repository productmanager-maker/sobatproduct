# sobatproduct — CLAUDE.md

## Apa ini
Bot Telegram tim `@sobatproductbot` — AI companion/chat internal Product SID, jalan sebagai grup member (jawab saat di-mention atau kena trigger keyword) plus command utilitas (`/muv`, `/status`, dll) dan broadcast terjadwal (ulang tahun, hari libur, payday).

## Stack
Node.js 22, plain JavaScript ESM (**bukan TypeScript**, **bukan Prisma**, **bukan Telegraf**) — koreksi dari asumsi awal. Library kunci:
- `node-telegram-bot-api` — polling bot
- `openai` SDK, `baseURL: https://api.deepseek.com` — panggil DeepSeek langsung, model `deepseek-v4-flash`
- `better-sqlite3` — storage lokal (`data/groups.db`, WAL mode)
- `googleapis` — baca Google Sheets (data staff/HR)
- `pdf-parse`, `mammoth` — parsing dokumen (PDF/Word) yang dikirim user
- Docker (single container, `node:22-alpine`)

Tidak ada `src/` folder besar/1236 file — codebase intinya cuma 4 file JS di root.

## Struktur Folder
| Path | Fungsi |
|---|---|
| `index.js` | Entry point: bot init, semua command handler (`bot.onText`), message handler utama, chat DeepSeek, OCR gambar, SQLite allowed-groups |
| `scheduler.js` | Cron internal (node-based, bukan OS cron) — broadcast ulang tahun/anniversary/holiday/payday ke grup, pakai data dari `sheets.js` |
| `sheets.js` | Semua akses Google Sheets — init auth, refresh cache staff, getter (birthday, holiday, payday, staff by agama, dll) |
| `triggers.js` | Daftar keyword yang bikin bot ikut nimbrung di grup tanpa di-mention |
| `data/` | SQLite runtime (`groups.db` — allowed group IDs tambahan di luar `.env`), volume-mounted ke Docker |
| `google-credentials.json` | Service account Google Sheets — **gitignored**, jangan commit |
| `*.bak*`, `*.codex-pre-*` | Backup manual sebelum edit besar — gitignored, boleh diabaikan/dibersihkan |

## Model Data
Tidak pakai Prisma/ORM. Satu tabel SQLite manual: `allowed_groups (id INTEGER PRIMARY KEY)` — daftar group ID yang boleh dipakai bot, digabung dengan `ALLOWED_GROUP_IDS` dari `.env`. Data staff/HR ada di Google Sheets eksternal (spreadsheet ID hardcoded di `index.js`), bukan di DB lokal.

## Cara Kerja Dev
```
npm run dev    # node --watch index.js
npm start      # node index.js
```
Tidak ada build step (plain JS). Butuh `.env` (lihat daftar key di bawah) + `google-credentials.json` di root sebelum jalan.

Env vars kunci (dari `.env`, jangan baca isinya langsung): `BOT_TOKEN`, `DEEPSEEK_API_KEY`, `ALLOWED_GROUP_IDS`, `ALLOWED_USER_IDS`, `SCHEDULE_GROUP_IDS`, `TEAM_MEMBERS`, `TIMEZONE`, `GOOGLE_CREDENTIALS_FILE`, `ADMIN_NOTIFY_TOKEN`/`ADMIN_NOTIFY_CHAT_ID`, `ENABLED_SLOTS`, `DISABLE_HOLIDAY_MSG`/`DISABLE_PAYDAY_MSG`, `OCR_SERVICE_URL`. Tidak ada `.env.example` di repo.

## Deploy
Dari `/home/product/sobatproduct` di VPS Contabo (`217.216.75.57`):
```
docker compose up -d --build
```
`docker-compose.yml`: single service `sobatproduct`, network `proxy` (external), volume mount `./index.js`, `./google-credentials.json` (ro), `./data`. Dockerfile cuma `COPY *.js .` — file lain (scheduler.js, sheets.js, triggers.js) ikut ke-copy tapi **tidak** ada di volume mount eksplisit seperti index.js (perhatikan kalau edit file itu, mungkin perlu rebuild, bukan cukup restart).

## Konvensi
- Commit message: Conventional Commits gaya ringkas (`fix: ...`, `chore: ...`) — history git masih pendek (baru 3 commit, initial backup Mei 2026).
- Backup manual via suffix file (`.bak`, `.bak-<konteks>-<tanggal>`) sebelum edit besar, bukan branch git.
- Komentar section pakai `// ─── Judul ───...` divider di `index.js`.

## Known WIP / Perlu Perhatian
**Migrasi ke Hermes SEDANG BERJALAN tapi lokasinya TERPISAH TOTAL dari repo ini.** Repo `/home/product/sobatproduct` ini murni arsitektur lama: Docker container + panggil DeepSeek API langsung (`openai` SDK → `api.deepseek.com`, model `deepseek-v4-flash`). Tidak ada satupun referensi Hermes di source (`index.js`/`scheduler.js`/`sheets.js`/`triggers.js`) — sudah dicek via grep, nihil.

Profile Hermes yang baru ada di `/home/product/.hermes/profiles/sobatproduct/` (di luar repo ini), pakai token Telegram bekas `@claudiacare_bot` untuk testing (BUKAN token `@sobatproductbot` asli — masih dipakai bot Docker production ini, akan bentrok 409 kalau dipakai bareng). Status per catatan terakhir: Fase 1 selesai, Fase 2 (MCP tools MUV/Sheets) **dipause** karena bug tool-calling `deepseek-v4-flash` (provider deepseek langsung) + OpenRouter kehabisan credit.

**Kesimpulan:** bot production yang aktif SEKARANG = Docker bot lama di repo ini. Hermes masih private testing, belum cutover. Jangan asumsikan Hermes sudah menggantikan apapun di sini sampai ada konfirmasi eksplisit — cek dulu status container `sobatproduct` (`docker ps`) dan token yang dipakai kalau ragu.

## Lab Notes

### 2026-09-11 — Notif "🟢 Sobat Product online." berulang (diperbaiki)
Keluhan user: bot nge-spam notif online padahal bukan kita yang restart. Penyebab: `bot.on('polling_error')` memanggil `process.exit(1)` untuk **semua** error `EFATAL` (jaringan/bentrok getUpdates), bukan cuma error fatal beneran → Docker (`restart: unless-stopped`) nyalain ulang container → tiap start kirim notif (18x exit dalam 1 log; notif tercatat 10–12 Sep).
Perbaikan di `index.js`:
1. EFATAL/konflik di-**retry in-process** (`stopPolling` → jeda 5s → `startPolling({restart:true})`); `process.exit(1)` cuma kalau gagal 2x dalam 5 menit (Docker tetap jaring terakhir, dan itu pun senyap).
2. **Notif online bergerbang**: hanya dikirim kalau `data/notify-online` ada (marker dikonsumsi/dihapus setelah dibaca) atau env `STARTUP_NOTIFY=1`. Auto-restart Docker = senyap → `[startup] mode SENYAP` di log.
3. Pesan error asli sekarang **di-log + disimpan** ke tabel `bot_state` key `last_polling_error` (sebelumnya ditelan, jadi sebab EFATAL tak terlacak). Error `409/Conflict` tidak lagi bikin exit (exit cuma memperparah loop; penyebabnya instance lain pakai token yang sama).
Cara restart yang benar sekarang: `scripts/restart-bot.sh` (bikin marker + `docker compose restart`, kirim notif) atau `NOTIFY=0 ./scripts/restart-bot.sh` (senyap). Backup: `index.js.bak-20260911-notifonline`.
Catatan: `index.js` owner `ican:product` (bukan product) → edit harus lewat docker mount + `chown 1000:1000`. Service `hermes-gateway-sobatproduct.service` (user systemd) sudah **failed & disabled** sejak 2026-09-09 — bukan pemicu konflik token.

### 2026-09-28 — 409 CONFLICT storm 9 hari: retry polling numpuk 16 loop (diperbaiki)
Gejala: log container `sobatproduct` berisi **283.542 baris** `[polling] 409 CONFLICT — ada instance lain pakai token ini` (mulai 19 Sep 2026 23:34 WIB), bot praktis nggak nerima pesan.
Diagnosa: **bukan** instance lain di luar container. Bukti dari dalam container — proses node (PID 1) pegang **16 socket ESTABLISHED** ke `149.154.166.110:443` (api.telegram.org); bot sehat cuma 1 (long-poll) + sesekali 1 request lain.
Akar masalah: fix 2026-09-11 memakai `bot.stopPolling({cancel:true})` lalu `startPolling({restart:true})`. Di `node-telegram-bot-api@0.66`, `stop({cancel:true})` hanya membatalkan request yang jalan dan **tidak** men-set `_abort`; loop lama karena itu menjadwalkan dirinya lagi di `.finally()` (`src/telegramPolling.js` baris 58-74 vs 163-170). Tiap recovery EFATAL ⇒ +1 loop, loop-loop itu saling bertabrakan (409) tapi kode 09-11 sengaja membuat 409 tidak fatal ⇒ numpuk tanpa henti sampai 16 loop.
Perbaikan di `index.js`:
1. `stopPollingCleanly()` → `bot.stopPolling()` **tanpa** `cancel` (men-set `_abort=true`), lalu tunggu `bot.isPolling()` benar-benar `false` sebelum start ulang. Ini yang menghentikan penumpukan loop.
2. 409 sekarang **dieskalasi**: throttle log 30s (dulu 283rb baris), dan kalau >20 konflik dalam 10 menit ⇒ `exit(1)` supaya Docker menyalakan proses **bersih dengan 1 poller** (senyap, tanpa notif). Ada cooldown 20 menit (`bot_state.last_poll_clean_restart`) supaya tidak jadi restart-storm kalau ternyata benar-benar ada instance luar.
3. Marker `bot_state.last_poll_clean_restart` disimpan di `data/groups.db`.
Verifikasi setelah restart: 1 proses node, **2 socket** ke Telegram (bukan 16), **0** log 409, dan probe `getUpdates` dari luar balas `409 Conflict` (artinya container inilah pemegang slot polling = bot hidup & satu-satunya).
Backup: `~/.backups/sobatproduct/index.js.20260928-pollfix` (sha256 `ccda2912…`).
Catatan hygiene: `data/groups.db*` akhirnya **di-untrack** dari git (`git rm --cached`, masuk `.gitignore`) — file runtime SQLite never should be in git; `scripts/` (berisi `restart-bot.sh`) di-commit.
Catatan akses: alias SSH `github-sobatproduct` **hilang** dari `~/.ssh/config` ⇒ `git fetch/push` ke `origin` gagal (hostname tak resolve). Sementara push dilakukan via `GIT_SSH_COMMAND` + key yang ada.

