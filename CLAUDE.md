# sobatproduct — CLAUDE.md

## ⛔ STATUS (28 Sep 2026): BOT DOCKER INI SUDAH DIPENSIUNKAN

Bot produksi `@sobatproductbot` **sekarang jalan sebagai Hermes Agent**, bukan container Docker ini:

| | Sebelum | Sekarang |
|---|---|---|
| Runtime | container `sobatproduct` (`docker compose`) | Hermes profile **`sobatproduct`** (`~/.hermes/profiles/sobatproduct`) |
| Service | `docker compose up -d` + `scripts/restart-bot.sh` | `systemctl --user restart hermes-gateway-sobatproduct.service` |
| Cara kerja | command hardcoded (`/muv`, `/exportroles`, …) | agent bebas: terminal, file, browser, MCP MUV/Sheets, product-brain |
| Otomasi SID Core | `sidcoreCommands.js` (39 command DM) | **web `robot.product-sid.us/semesta`** + sheet tim (surface bot dilepas 28 Sep) |

- Container sudah di-`docker compose down`; `docker-compose.yml` diberi header "JANGAN UP" +
  `restart: "no"`. **Jangan `up` lagi** — token Telegram-nya sekarang dipegang gateway Hermes,
  dua poller = 409 storm (insiden 19–28 Sep 2026).
- `sidcoreCommands.js` **sudah dihapus** dari repo ini (ada di git history); referensinya di
  `index.js` juga sudah dibersihkan.
- Notif ke Ican: hook `notify-teleclaude` di profil Hermes (tiap chat masuk → DM via bot teleclaude)
  + hook `ack-slow` (pesan "sedang diproses" kalau agent >8 detik).
- Isi repo ini tetap berguna sebagai **arsip** (logika DeepSeek/Sheets/OCR-nya masih jadi acuan),
  tapi jangan dijalankan sebagai service.

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

## Deploy — ⚠️ SUDAH TIDAK RELEVAN (lihat banner di atas)
Container Docker sudah dipensiunkan 28 Sep 2026; **jangan** `docker compose up -d --build` lagi.
Kalau perlu ngejalanin code lama ini untuk debugging lokal, ingat: token Telegram-nya bakal rebutan
dengan gateway Hermes → matikan dulu `systemctl --user stop hermes-gateway-sobatproduct.service`.

Catatan arsip (cara lama): `docker-compose.yml` single service `sobatproduct`, network `proxy`
(external), volume mount `./index.js`, `./google-credentials.json` (ro), `./data`.

## Konvensi
- Commit message: Conventional Commits gaya ringkas (`fix: ...`, `chore: ...`) — history git masih pendek (baru 3 commit, initial backup Mei 2026).
- Backup manual via suffix file (`.bak`, `.bak-<konteks>-<tanggal>`) sebelum edit besar, bukan branch git.
- Komentar section pakai `// ─── Judul ───...` divider di `index.js`.

## Known WIP / Perlu Perhatian
**CUTOVER SELESAI 28 Sep 2026.** Bot produksi `@sobatproductbot` sekarang = Hermes profile
`/home/product/.hermes/profiles/sobatproduct` (systemd user unit `hermes-gateway-sobatproduct.service`,
token Telegram yang sama). Repo ini jadi arsip — jangan dijalankan sebagai service.

Yang perlu diingat saat kerja di area ini:
- **Token Telegram** ada di `.env` repo ini DAN di `.env` profil Hermes. Yang hidup cuma yang di
  profil Hermes; kalau ada dua poller (mis. container dinyalakan lagi) → 409 storm, bot bisu.
- Profil Hermes-nya lengkap: MCP `muv-sheets` (tool MUV + lookup staff/holiday dari Google Sheets)
  dan `product-brain` (wiki Product Org), skills hasil clone dari profil `kerjabakti`, blocklist
  domain `afteroffice.dev`, plus hook notif (`notify-teleclaude`, `ack-slow`).
- `data/groups.db*` (SQLite runtime) **sudah di-untrack** dari git + masuk `.gitignore`. File di
  disk tetap ada; jangan pernah `git checkout` folder `data/`.

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

### 2026-09-28 (siang) — CUTOVER: bot pindah dari Docker ke Hermes + surface otomasi jadi 2
Keputusan owner: automation SID Core fokus lewat **web** (`robot.product-sid.us/semesta`) + sheet, dan
bot `@sobatproductbot` diganti agent Hermes general-purpose (pola sama seperti `@kerjabaktibot`).
Yang dikerjakan:
1. **Hermes profile `sobatproduct`** dibuat (clone dari profile `kerjabakti` biar mewarisi kebijakan
   keamanan: `security.website_blocklist` = `afteroffice.dev` + `*.afteroffice.dev`,
   `allow_private_urls: false`, `tirith_enabled: true`, `approvals.mode: smart`).
   `.env` diarahkan ke token Telegram `@sobatproductbot` (token yang sama dengan bot Docker lama),
   home channel = DM Ican. `SOUL.md` ditulis ulang (agent bebas, guard: no `afteroffice.dev`,
   no intip profil lain, no sebar kredensial).
2. **MCP** dipindah jadi milik profil ini (sebelumnya nunjuk ke path profil `kerjabakti`):
   `tools/muv_sheets_mcp.py` (tool MUV: task/board/create + `staff_lookup`/`holiday_check`),
   `tools/brain_wiki_mcp.py` + clone repo `product-brain-git`, `google-credentials.json`.
3. **Cutover**: `docker compose stop` → `systemctl --user enable --now hermes-gateway-sobatproduct.service`
   → container di-`docker compose down` (dihapus, `restart: "no"` + header "JANGAN UP" di compose).
4. **Hook notif** (permintaan owner, pola "kaya kerjabakti"): `hooks/notify-teleclaude` (tiap
   `agent:start` → DM Ican via bot teleclaude; token/chat dibaca runtime dari
   `/opt/deepseek-monitor/check_balance.sh`, chat pribadi Ican di-skip) + `hooks/ack-slow`
   (pesan "sedang diproses" kalau agent >8s, salinan dari kerjabakti).
5. **Surface otomasi dilepas**: `sidcoreCommands.js` dihapus, `index.js` dibersihkan dari
   import/registrasi/pending-reply/help-text SID Core, `docker-compose.yml` tak lagi me-mount
   `/home/product/sid-core-automation` + JSON `role-dashboard`.
Verifikasi: gateway `telegram connected`, `[hooks] Loaded hook 'ack-slow'` + `'notify-teleclaude'`,
probe `getUpdates` dari luar balas 409 (gateway pemegang slot), uji HP: `/status` dibalas.
Rollback: `~/.hermes/rollback/ROLLBACK-20260928-cutover-hermes.md`.

