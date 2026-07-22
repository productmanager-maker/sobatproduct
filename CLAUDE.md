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
belum ada entri
