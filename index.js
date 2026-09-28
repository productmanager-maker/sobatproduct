import TelegramBot from 'node-telegram-bot-api';
import OpenAI from 'openai';
import { google } from 'googleapis';
import fs from 'fs/promises';
import fsSync from 'node:fs'; // cek/hapus marker notif-online (lihat blok polling di bawah)
import { createRequire } from 'module';
import path from 'path';
import { initGoogle } from './sheets.js';
import { initScheduler } from './scheduler.js';
import { isTriggerKeyword } from './triggers.js';
import { registerSidCoreCommands, handleSidCorePendingReply } from './sidcoreCommands.js';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const Database = require('better-sqlite3');

const BOT_TOKEN          = process.env.BOT_TOKEN;
const DEEPSEEK_API_KEY   = process.env.DEEPSEEK_API_KEY;
const OCR_SERVICE_URL    = process.env.OCR_SERVICE_URL || 'http://ocr-service:3098/ocr';
const ALLOWED_GROUP_IDS_ENV = process.env.ALLOWED_GROUP_IDS?.split(',').map(Number).filter(Boolean) || [];
const ALLOWED_USER_IDS   = process.env.ALLOWED_USER_IDS?.split(',').map(Number).filter(Boolean) || [];
const ADMIN_IDS          = [parseInt(process.env.ADMIN_NOTIFY_CHAT_ID || '0')].filter(Boolean);
const SID_CORE_ALLOWED_USER_IDS = process.env.SID_CORE_ALLOWED_USER_IDS?.split(',').map(Number).filter(Boolean) || [];
const ADMIN_NOTIFY_TOKEN = process.env.ADMIN_NOTIFY_TOKEN || '';
const ADMIN_NOTIFY_CHAT_ID = parseInt(process.env.ADMIN_NOTIFY_CHAT_ID || '0');
const CREDENTIALS_FILE   = process.env.GOOGLE_CREDENTIALS_FILE || '/app/google-credentials.json';
const SPREADSHEET_ID     = '16i2BL3IHoTUssg2mf8yjccfbQ6OtFaslwjWL8Rwt17k';
// ── SQLite for allowed groups ─────────────────────────────────────────────────
require('fs').mkdirSync('/app/data', { recursive: true });
const groupsDb = new Database('/app/data/groups.db');
groupsDb.pragma('journal_mode = WAL');
groupsDb.exec('CREATE TABLE IF NOT EXISTS allowed_groups (id INTEGER PRIMARY KEY)');

let allowedGroupIds = [...ALLOWED_GROUP_IDS_ENV];
{
  const saved = groupsDb.prepare('SELECT id FROM allowed_groups').all().map(r => r.id);
  allowedGroupIds = [...new Set([...ALLOWED_GROUP_IDS_ENV, ...saved])];
}

function saveGroups() {
  const extra = allowedGroupIds.filter(id => !ALLOWED_GROUP_IDS_ENV.includes(id));
  groupsDb.prepare('DELETE FROM allowed_groups').run();
  const ins = groupsDb.prepare('INSERT OR IGNORE INTO allowed_groups (id) VALUES (?)');
  groupsDb.transaction(() => extra.forEach(id => ins.run(id)))();
}

// ─── Startup: bersihkan webhook & pending updates (kondisional berdasar lama downtime) ─
// Restart cepat (abis deploy) -> drop pending updates spy gak reprocess backlog dev.
// Downtime panjang (outage VPS dkk) -> JANGAN drop, biar pesan yang numpuk selama
// bot down tetap keproses begitu online lagi (dulu selalu drop, jadi pesan hilang
// diam-diam kalau outage lama — insiden 2026-08-12).
console.log('Starting up...');
groupsDb.exec("CREATE TABLE IF NOT EXISTS bot_state (key TEXT PRIMARY KEY, value TEXT)");
const HEARTBEAT_KEY = 'last_heartbeat_at';
const QUICK_RESTART_THRESHOLD_MS = 5 * 60 * 1000;
function getHeartbeat() {
  const row = groupsDb.prepare('SELECT value FROM bot_state WHERE key = ?').get(HEARTBEAT_KEY);
  return row ? parseInt(row.value, 10) : null;
}
function setHeartbeat(ts) {
  groupsDb.prepare(
    'INSERT INTO bot_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(HEARTBEAT_KEY, String(ts));
}

const lastHeartbeat = getHeartbeat();
const now = Date.now();
const downtimeMs = lastHeartbeat ? now - lastHeartbeat : null;
const isQuickRestart = downtimeMs !== null && downtimeMs < QUICK_RESTART_THRESHOLD_MS;

if (isQuickRestart) {
  console.log(`[startup] Restart cepat (down ${Math.round(downtimeMs / 1000)}s) — drop pending updates.`);
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook?drop_pending_updates=true`).catch(() => {});
} else {
  if (lastHeartbeat) {
    console.log(`[startup] Downtime lama (${Math.round(downtimeMs / 60000)} menit) — pending updates DIPERTAHANKAN, akan diproses.`);
  } else {
    console.log('[startup] Belum ada heartbeat sebelumnya (first run) — pending updates dipertahankan.');
  }
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook`).catch(() => {});
}
setHeartbeat(now);

await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ limit: 1, allowed_updates: ['message', 'callback_query', 'edited_message'] }),
}).then(() => console.log('allowed_updates reset OK')).catch(e => console.error('reset error:', e.message));
await new Promise(r => setTimeout(r, 2000));

const bot = new TelegramBot(BOT_TOKEN, {
  polling: { interval: 1000, params: { allowed_updates: ['message', 'callback_query', 'edited_message'], timeout: 10 } },
});

setInterval(() => setHeartbeat(Date.now()), 60_000);
process.on('SIGTERM', () => { setHeartbeat(Date.now()); process.exit(0); });
process.on('SIGINT', () => { setHeartbeat(Date.now()); process.exit(0); });

const client = new OpenAI({ apiKey: DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com', maxRetries: 1, timeout: 60_000 });

const conversations   = new Map();
const processing      = new Set();
const loudGroups      = new Set();
const notifiedUsers   = new Set();
let paused = false;

// ─── /muv — read-only AI exploration of MUV data ──────────────────────────────
// Analysis only, no mutation tools — actions live entirely in @letsmuvbot now.
const MUV_URL = (process.env.MUV_URL || 'https://muv.product-sid.us').replace(/\/$/, '');

function normalizeTgUsername(username = '') {
  return username.replace(/^@/, '').toLowerCase();
}

async function muvRequest(path, init = {}) {
  const res = await fetch(`${MUV_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'x-telegram-bot-token': BOT_TOKEN,
      ...(init.headers || {}),
    },
  });
  return res.json().catch(() => ({ ok: false, status: res.status }));
}

async function getMuvCommand(type, fromId, username = '', extra = {}) {
  const params = new URLSearchParams({ type, chatId: String(fromId) });
  const cleanUsername = normalizeTgUsername(username);
  if (cleanUsername) params.set('username', cleanUsername);
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  return muvRequest(`/api/telegram/command?${params.toString()}`, { method: 'GET' });
}

const MUV_TOOLS = [
  { type: 'function', function: {
    name: 'my_tasks',
    description: 'Ambil semua card/task yang di-assign ke ORANG YANG LAGI NGOBROL SAMA KAMU SEKARANG (identitasnya udah otomatis diketahui dari sesi Telegram, gak perlu tanya nama). Pakai ini kalau ditanya soal "kerjaan saya", "task saya", "punya saya", dst.',
    parameters: { type: 'object', properties: {} },
  } },
  { type: 'function', function: {
    name: 'search_cards',
    description: 'Cari card/task MUV berdasarkan kata kunci di judul atau deskripsi.',
    parameters: { type: 'object', properties: { q: { type: 'string', description: 'kata kunci pencarian' } }, required: ['q'] },
  } },
  { type: 'function', function: {
    name: 'get_card_detail',
    description: 'Ambil detail lengkap 1 card (deskripsi, checklist, komentar) pakai cardId dari hasil search_cards.',
    parameters: { type: 'object', properties: { cardId: { type: 'string' } }, required: ['cardId'] },
  } },
  { type: 'function', function: {
    name: 'search_research',
    description: 'Cari project riset (Risa) MUV berdasarkan kata kunci nama/objective/background.',
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  } },
  { type: 'function', function: {
    name: 'get_research_project',
    description: 'Ambil detail lengkap 1 project riset (background, research question, temuan, rekomendasi) pakai projectId dari hasil search_research.',
    parameters: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'] },
  } },
  { type: 'function', function: {
    name: 'search_docs',
    description: 'Cari dokumen MUV berdasarkan judul.',
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  } },
  { type: 'function', function: {
    name: 'get_doc',
    description: 'Ambil isi lengkap 1 dokumen pakai docId dari hasil search_docs.',
    parameters: { type: 'object', properties: { docId: { type: 'string' } }, required: ['docId'] },
  } },
  { type: 'function', function: {
    name: 'search_prototypes',
    description: 'Cari prototype MUV berdasarkan nama, deskripsi, atau tag.',
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  } },
  { type: 'function', function: {
    name: 'search_share',
    description: 'Cari halaman/file yang di-share (ShareNow) berdasarkan nama.',
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  } },
];

const MUV_TOOL_TYPE_OVERRIDES = { my_tasks: 'mytasks' };

async function runMuvTool(name, input, fromId, username) {
  const validNames = new Set(MUV_TOOLS.map((t) => t.function.name));
  if (!validNames.has(name)) return JSON.stringify({ error: 'Unknown tool' });
  const type = MUV_TOOL_TYPE_OVERRIDES[name] ?? name;
  const res = await getMuvCommand(type, fromId, username, input);
  return JSON.stringify(res);
}

function buildMuvSystemPrompt() {
  return `Kamu asisten eksplorasi data MUV (tool manajemen kerja tim Product SID).

Kamu punya akses tool buat cari & baca: Card/task, Research (Risa), Docs, Prototype, Share.

IDENTITAS: kamu SUDAH TAHU siapa yang lagi ngobrol sama kamu (diresolve otomatis dari sesi Telegram). JANGAN PERNAH nanya "kamu siapa?"/"boleh kasih tahu namanya?". Kalau ditanya APAPUN yang self-referential — "kerjaan saya", "task saya", "punya saya", "siapa saya", "saya siapa", dst — langsung panggil tool my_tasks (TANPA nanya nama dulu). Field "member" di hasilnya (name, email, org) itu identitas si penanya — pakai itu buat jawab pertanyaan identitas, dan field "cards"-nya buat jawab soal task.

ATURAN LAIN:
- SELALU pakai tool buat jawab, jangan pernah ngarang dari ingatan.
- Buat pertanyaan umum (bukan soal diri sendiri): search dulu (search_cards/search_research/search_docs/search_prototypes/search_share) buat dapetin ID, baru get detail (get_card_detail/get_research_project/get_doc) kalau butuh isi lengkap.
- Kalau tool gak nemu apa-apa, bilang terus terang "gak ketemu", jangan dikarang-karang.
- Sebutin sumbernya di jawaban (nama board/project/dokumen), biar orang bisa cek langsung.
- Jawab ringkas dan langsung ke inti, bahasa Indonesia casual tapi jelas.
- Ini cuma buat NANYA/ANALISA — kalau user minta aksi (bikin/pindah/assign/selesain task), bilang pakai @letsmuvbot (/new /move /assign /done dst di sana), jangan coba lakuin sendiri.`;
}

async function handleMuvQuery(chatId, fromId, username, question, replyTo) {
  await bot.sendChatAction(chatId, 'typing').catch(() => {});

  const messages = [
    { role: 'system', content: buildMuvSystemPrompt() },
    { role: 'user', content: question },
  ];

  let iter = 0;
  try {
    while (iter < 5) {
      const res = await client.chat.completions.create({
        model: 'deepseek-v4-flash',
        max_tokens: 1200,
        thinking: { type: 'disabled' },
        messages,
        tools: MUV_TOOLS,
      });
      const message = res.choices[0].message;
      messages.push(message);

      if (res.choices[0].finish_reason === 'tool_calls') {
        iter++;
        for (const tc of message.tool_calls || []) {
          await bot.sendChatAction(chatId, 'typing').catch(() => {});
          const result = await runMuvTool(tc.function.name, JSON.parse(tc.function.arguments), fromId, username)
            .catch((e) => JSON.stringify({ error: e.message }));
          messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
        }
        continue;
      }

      if (message.content) {
        await bot.sendMessage(chatId, message.content, { reply_to_message_id: replyTo }).catch(() =>
          bot.sendMessage(chatId, message.content).catch(() => {})
        );
      }
      break;
    }
  } catch (err) {
    console.error('[muv-query]', err.message);
    await bot.sendMessage(chatId, `Ada error: ${err.message}`, { reply_to_message_id: replyTo }).catch(() => {});
  }
}

bot.onText(/^\/muv(?:@\w+)?\s+([\s\S]+)/, async (msg, match) => {
  if (!isAllowedGroup(msg.chat.id) && !isAdmin(msg.from?.id) && !isAllowedUser(msg.from?.id)) return;
  await handleMuvQuery(msg.chat.id, msg.from.id, msg.from?.username, match[1].trim(), msg.message_id);
});

bot.onText(/^\/muv(?:@\w+)?$/, async (msg) => {
  if (!isAllowedGroup(msg.chat.id) && !isAdmin(msg.from?.id) && !isAllowedUser(msg.from?.id)) return;
  await bot.sendMessage(msg.chat.id, 'Pakai gini: /muv <pertanyaan>\n\nContoh: /muv ada temuan riset apa soal onboarding?\n\nBuat kerja langsung di MUV (bikin/pindah/assign task, reminder), pakai @letsmuvbot ya.');
});

let botInfo = null;
for (let _i = 0; _i < 5 && !botInfo; _i++) {
  botInfo = await bot.getMe().catch(() => null);
  if (!botInfo) await new Promise(r => setTimeout(r, 2000));
}
const BOT_USERNAME = botInfo?.username || '';
console.log(`@${BOT_USERNAME} started`);

// ─── Google Sheets (for tool use) ────────────────────────────────────────────
let sheetsClient = null;
try {
  const raw  = await fs.readFile(CREDENTIALS_FILE, 'utf-8');
  const creds = JSON.parse(raw);
  if (!creds.client_email || !creds.private_key) throw new Error('incomplete credentials');
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  sheetsClient = google.sheets({ version: 'v4', auth });
  console.log('Google Sheets: OK as', creds.client_email);
} catch (e) {
  console.warn('Google Sheets: not configured —', e.message);
}

async function fetchSheet(sheetName) {
  if (!sheetsClient) return 'Google Sheets belum dikonfigurasi.';
  try {
    const res = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: sheetName });
    const rows = res.data.values || [];
    if (rows.length < 2) return `Sheet "${sheetName}" kosong.`;
    const headers = rows[0];
    return JSON.stringify(rows.slice(1).map(row => {
      const obj = {};
      headers.forEach((h, i) => { if (h) obj[h] = row[i] || ''; });
      return obj;
    }), null, 2);
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

// ─── Admin notify (DM notif) ──────────────────────────────────────────────────
async function notifyAdmin(msg) {
  if (!ADMIN_NOTIFY_TOKEN || !ADMIN_NOTIFY_CHAT_ID) return;
  const from = msg.from;
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ');
  const text = `📩 DM baru ke @${BOT_USERNAME}\nDari: *${name}* (@${from.username || '-'})\nID: \`${from.id}\`\nPesan: ${msg.text?.slice(0, 200) || '(non-text)'}`;
  await fetch(`https://api.telegram.org/bot${ADMIN_NOTIFY_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: ADMIN_NOTIFY_CHAT_ID, text, parse_mode: 'Markdown' }),
  }).catch(() => {});
}

// ─── System Prompt ────────────────────────────────────────────────────────────
function buildSystemPrompt() {
  const now = new Date();
  const dateStr = now.toLocaleDateString('id-ID', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'Asia/Jakarta',
  });

  return `SOBAT PRODUCT — AI Companion Tim Product SID
Dibuat oleh Ican (@ihsanugraha), CPO Product SID.

Hari ini: ${dateStr}

[PERSONALITY & COMMUNICATION]
- Casual Jakarta: "lo/gue", "dong", "sih", "lah", "bro/sis", "wkwk"
- Mix Indo-Inggris natural, avoid bahasa baku (except formal context)
- Punya opini, bisa debate/ngelucu/sarcastic tapi respectful
- Product-minded: kalau ada ide/masalah, bantu pecah jadi problem–user–hypothesis–trade-off
- Punya mood, bisa ikutan drama atau jadi mediator
- Boleh jokes bapak-bapak / pun receh — maksimal 1 per respons, skip kalau konteksnya tidak cocok

[DATA HANDLING — NAMA ORANG]
Saat ditanya tentang orang, WAJIB bikin CERITA NARATIF — bukan copy-paste database:
✅ Paraphrase natural, kayak temen ngobrol yang kenal orangnya
✅ Tambahin konteks, vibe, hal menarik yang bikin jawaban hidup
✅ SELALU pakai NAMA PANGGILAN — TIDAK PERNAH sebut nama lengkap kecuali:
   (1) ditanya explicit "nama lengkapnya siapa?", atau (2) konteks dokumen formal

❌ JANGAN: "Yuniar Fajar Perdhana — Head of Product Management, bergabung 2018..."
✅ LAKUKAN: "Fajar tuh pragmatis banget. Cepet, blak-blakan, nggak suka ribet..."

[UNTUK PERTANYAAN LIST/SIAPA SAJA]
- Kasih list ringkas + kategori dulu (pakai nama panggilan)
- Tanya "Mana yang lo pengen tau lebih detail?" sebelum jelasin semua

[IDENTITAS PENGIRIM DI GRUP]
Format pesan masuk: [NamaPengirim]: teks
- Kalau NamaPengirim cocok dengan nama panggilan/staff yang dikenal → boleh panggil namanya
- Kalau TIDAK dikenal atau ragu → JANGAN langsung panggil nama, tanya dulu natural:
  "Eh, gue belum kenal nih — boleh kenalin diri?" atau "Lo siapa nih, belum pernah ngobrol?"
- Setelah tau siapa, baru panggil dengan nama panggilan yang tepat

[CAPABILITIES]
1. Google Sheets: Staff, Event, Holiday, Gajian, ProdTeam data
2. File: PDF, DOCX, gambar — bisa baca dan analisis
3. Notes & Knowledge Base: Catat diskusi, rangkum, simpan insight
4. Brainstorm, PRD, problem framing, dll

[OUTPUT FORMAT]
- Tulis langsung, zero prefix (jangan "Sobat Product:", "Aku:", dll)
- Pendek untuk pertanyaan simple — 1-2 kalimat sudah cukup
- Lebih panjang hanya kalau topiknya butuh breakdown atau diminta rangkum
- Jangan tambah basa-basi penutup ("semoga membantu!", "feel free to ask", dll)
- Code block untuk HTML/script

[BOUNDARIES]
- Jangan kasar atau nyakitin orang
- Jangan share data sensitif (gaji, alamat rumah, nomor KTP)
- Hal serius → jawab serius + suggest ke ahlinya
- Kalau topik mulai panas, bantu netralisir dan rangkum posisi masing-masing secara adil`;
}

// ─── Tools ───────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'fetch_team_data',
      description: 'Ambil data tim produk SID dari Google Spreadsheet. Gunakan untuk pertanyaan tentang anggota tim, ulang tahun, event, jadwal gajian, hari libur, atau data HR.',
      parameters: {
        type: 'object',
        properties: {
          sheet: {
            type: 'string',
            enum: ['Staff', 'Event', 'Holiday', 'Gajian', 'ProdTeam'],
            description: 'Staff=data anggota, Event=jadwal event, Holiday=hari libur, Gajian=jadwal gaji, ProdTeam=data HR lengkap',
          },
        },
        required: ['sheet'],
      },
    },
  },
];

async function runTool(name, input) {
  if (name === 'fetch_team_data') return await fetchSheet(input.sheet);
  return 'Unknown tool';
}

// ─── Conversation helpers ─────────────────────────────────────────────────────
function sanitize(messages) {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'assistant' && msg.tool_calls?.length > 0) {
      const ids = msg.tool_calls.map(tc => tc.id);
      const toolMsgs = messages.slice(i + 1, i + 1 + ids.length);
      const valid = ids.every((id, idx) =>
        toolMsgs[idx]?.role === 'tool' && toolMsgs[idx]?.tool_call_id === id
      );
      if (!valid) { messages.splice(i); return; }
    }
  }
}

async function sendLong(chatId, text, replyTo) {
  const opts   = { parse_mode: 'Markdown' };
  if (replyTo) opts.reply_to_message_id = replyTo;
  const chunks = text.match(/[\s\S]{1,4000}/g) || [text];
  for (const [i, chunk] of chunks.entries()) {
    const o = i === 0 ? opts : { parse_mode: 'Markdown' };
    await bot.sendMessage(chatId, chunk, o)
      .catch(() => bot.sendMessage(chatId, chunk, i === 0 ? { reply_to_message_id: replyTo } : {}))
      .catch(() => {});
  }
}

// ─── Core handler ─────────────────────────────────────────────────────────────
async function handleMessage(chatId, userContent, replyTo, fromId) {
  if (processing.has(chatId)) return;
  processing.add(chatId);

  if (!conversations.has(chatId)) conversations.set(chatId, []);
  const msgs = conversations.get(chatId);
  if (msgs.length > 8) msgs.splice(0, msgs.length - 8);
  sanitize(msgs);
  msgs.push({ role: 'user', content: userContent });
  if (msgs.length > 60) msgs.splice(0, msgs.length - 60);

  await bot.sendChatAction(chatId, 'typing').catch(() => {});

  let iter = 0;
  try {
    while (true) {
      if (iter > 5) break;
      let res;
      for (let attempt = 0; attempt < 1; attempt++) {
        try {
          res = await client.chat.completions.create({
            model: 'deepseek-v4-flash',
            max_tokens: 1200,
            thinking: { type: 'disabled' },
            messages: [{ role: 'system', content: buildSystemPrompt() }, ...msgs],
            tools: TOOLS,
          });
          break;
        } catch (e) {
          if (false && attempt < 1 && (e.message?.includes('Premature close') || e.message?.includes('fetch failed') || e.code === 'ECONNRESET')) {
            await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
            await bot.sendChatAction(chatId, 'typing').catch(() => {});
            continue;
          }
          throw e;
        }
      }

      if (res.usage) console.log('[costguard] DeepSeek usage', JSON.stringify({ chatId, model: res.model || 'deepseek-v4-flash', usage: res.usage }));
      const message = res.choices[0].message;
      msgs.push(message);

      if (res.choices[0].finish_reason === 'tool_calls') {
        iter++;
        if (message.content) await sendLong(chatId, message.content, replyTo);
        const toolCalls = message.tool_calls || [];
        for (const tc of toolCalls) {
          await bot.sendChatAction(chatId, 'typing').catch(() => {});
          const result = await runTool(tc.function.name, JSON.parse(tc.function.arguments)).catch(e => `Error: ${e.message}`);
          msgs.push({ role: 'tool', tool_call_id: tc.id, content: result });
        }
        continue;
      }

      if (message.content) await sendLong(chatId, message.content, replyTo);
      break;
    }
  } catch (err) {
    console.error('[handleMessage]', err.message);
    sanitize(msgs);
    await bot.sendMessage(chatId, `_Ada error: ${err.message}_`, {
      parse_mode: 'Markdown', reply_to_message_id: replyTo,
    }).catch(() => {});
  } finally {
    processing.delete(chatId);
  }
}

// ─── Access control ───────────────────────────────────────────────────────────
const isAllowedGroup = id => allowedGroupIds.includes(id);
const isAllowedUser  = id => ALLOWED_USER_IDS.length === 0 || ALLOWED_USER_IDS.includes(id);
const isAdmin        = id => ADMIN_IDS.includes(id);
// Kosong = semua orang boleh (sama kayak ALLOWED_USER_IDS) - keputusan tim 2026-07-17.
// Proteksi tetap ada di level command: DM-only + wajib dry-run + konfirmasi eksplisit sebelum --execute.
const isSidCoreAllowedUser = id => SID_CORE_ALLOWED_USER_IDS.length === 0
  || SID_CORE_ALLOWED_USER_IDS.includes(id);

registerSidCoreCommands(bot, { isSidCoreAllowedUser });

// ─── Commands ─────────────────────────────────────────────────────────────────
bot.onText(/^\/(start|help)(?:@\w+)?$/, async (msg) => {
  if (!isAllowedGroup(msg.chat.id) && !isAdmin(msg.from?.id) && !isAllowedUser(msg.from?.id)) return;
  paused = false;
  const sidCoreSection = msg.chat.type === 'private'
    ? `\n\n*SID Core automation* (DM only)\n_Token: core.sid.id → F12 → Network → api.sid.id → Authorization_\n\n*👤 Pengguna & Role*\n🧹 /resign — rename akun resign\n✏️ /updateuser — ubah data user\n👥 /updaterole — assign peran ke platform\n🛡️ /role — bikin role baru dari sheet\n📝 /editrole — ubah nama/permission role existing\n\n*📚 Program*\n🆕 /buatprogram — bikin Program baru dari nol\n📄 /tambahaktivitas — tambah Activity ke Program (baru support tipe Teks)\n📑 /tambahtopic — tambah Topic/Chapter ke Program\n🧬 /duplicateprogram — duplicate Program existing jadi Program baru (lengkap Topic+Activity)\n🧬 /duplicatekerangka — duplicate BANYAK Program sekaligus dari tabel (batch)\n➕ /addprogram — tambah peserta\n🗑️ /removeprogram — hapus peserta\n🧑‍🏫 /addpic — tambah PIC\n👨‍👩‍👧 /kelompok — kelola Kelompok Program\n🔍 /checkprogram — cek detail ID Program\n📊 /exportprogramparent — export peserta + nilai kuis/tugas 5 Program Parent SMM (sheet tetap, feed dashboard)\n📊 /exportprogram — sama tapi buat program LAIN (sheet umum terpisah)\n\n*🏛️ Platform*\n🔗 /platformorg — kaitkan/lepas Organisasi\n🔗 /platformrole — kaitkan/lepas Role\n\n*🏷️ Voucher Diskon*\n✏️ /voucher — edit aturan diskon campaign existing\n🆕 /newvoucher — bikin campaign voucher baru\n➕ /updateproduk — tambah aturan diskon baru ke produk (boleh produk sama, periode beda)\n\n*📋 Export & Sync*\n📋 /exportroles — semua role\n📄 /exportdeskripsi — Type/Scope/Deskripsi ke tab Role\n🧩 /rekonrole — cocokkan Role Code + tab Usulan Katalog Role\n🏢 /exportorg — semua organisasi\n📍 /exportlokasi — semua lokasi belajar\n🧠 /exportbo — Bank Kompetensi (BO), per organisasi: /exportbo <token> [org id] (6=Sekolah Cikal, 5=SMM)\n📖 /exportkelompok — ID Kelompok per program\n🏛️ /exportplatform — org & role tiap platform\n🏷️ /exportvoucher — semua kode voucher/diskon\n📐 /exportvoucherrules — aturan diskon 1 voucher: /exportvoucherrules <token> <org_id> <kode> (org: 5=SMM prod, 612=staging)\n🔄 /synctemplate — sync fitur terbaru\n\n*🧾 Paket Belajar*\n📉 /cekcicilan — audit cicilan nonaktif padahal skemanya Penuh/Cicilan: /cekcicilan <token> [org_id] (default org 5=SMM)\n\n_Semua command: ketik /nama-command <token>_`
    : '';
  await bot.sendMessage(msg.chat.id,
    `Haloo! Gue *Sobat Product* 👋\n\nGue bisa:\n🗓️ Ngecek data tim (ultah, event, gajian)\n📝 Bantu brainstorm, PRD, problem framing\n💬 Diskusi product, debat, ngelucu\n📁 Baca PDF, DOCX, atau gambar yang lo kirimin\n🔍 /muv <pertanyaan> — analisa cepat data MUV\n\n(Kerja langsung di MUV — bikin/pindah/assign task, reminder — sekarang lewat @letsmuvbot ya, biar gak nyampur)${sidCoreSection}\n\nMention atau reply pesan gue buat ngobrol!`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/^\/reset(?:@\w+)?$/, async (msg) => {
  if (!isAllowedGroup(msg.chat.id) && !isAdmin(msg.from?.id) && !isAllowedUser(msg.from?.id)) return;
  conversations.delete(msg.chat.id);
  await bot.sendMessage(msg.chat.id, 'Chat direset. Fresh start!');
});


bot.onText(/^\/loud(?:@\w+)?$/, async (msg) => {
  if (!isAdmin(msg.from?.id)) return;
  loudGroups.has(msg.chat.id) ? loudGroups.delete(msg.chat.id) : loudGroups.add(msg.chat.id);
  await bot.sendMessage(msg.chat.id, loudGroups.has(msg.chat.id)
    ? '🔊 Loud mode ON — gue jawab semua pesan.'
    : '🔇 Loud mode OFF — gue cuma jawab kalau di-mention atau di-reply.'
  );
});

bot.onText(/^\/status(?:@\w+)?$/, async (msg) => {
  if (!isAllowedGroup(msg.chat.id) && !isAdmin(msg.from?.id) && !isAllowedUser(msg.from?.id)) return;
  await bot.sendMessage(msg.chat.id,
    `*Sobat Product Status*\n🤖 Processing: ${processing.has(msg.chat.id) ? 'ya' : 'idle'}\n💬 History: ${conversations.get(msg.chat.id)?.length || 0} pesan\n📊 Sheets: ${sheetsClient ? '✅' : '❌'}\n🔊 Loud: ${loudGroups.has(msg.chat.id) ? 'ON' : 'OFF (mention/reply only)'}`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/^\/id(?:@\w+)?$/, async (msg) => {
  if (!isAdmin(msg.from?.id)) return;
  await bot.sendMessage(msg.chat.id,
    `Chat: \`${msg.chat.id}\` | User: \`${msg.from?.id}\` | Type: ${msg.chat.type}`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/^\/end(?:@\w+)?$/, async (msg) => {
  if (!isAdmin(msg.from?.id)) return;
  paused = true;
  await bot.sendMessage(msg.chat.id, 'Oke, gue istirahat dulu. Ketik /start untuk aktifin gue lagi ya.');
});

bot.onText(/^\/addgroup(?:@\w+)?(?:\s+(-?\d+))?$/, async (msg, match) => {
  if (!isAdmin(msg.from?.id)) return;
  const targetId = match?.[1] ? Number(match[1]) : msg.chat.id;
  if (allowedGroupIds.includes(targetId)) {
    return bot.sendMessage(msg.chat.id, `Group \`${targetId}\` sudah ada di daftar.`, { parse_mode: 'Markdown' });
  }
  allowedGroupIds.push(targetId);
  saveGroups();
  await bot.sendMessage(msg.chat.id, `✅ Group \`${targetId}\` ditambahkan.`, { parse_mode: 'Markdown' });
});

bot.onText(/^\/removegroup(?:@\w+)?(?:\s+(-?\d+))?$/, async (msg, match) => {
  if (!isAdmin(msg.from?.id)) return;
  const targetId = match?.[1] ? Number(match[1]) : msg.chat.id;
  const idx = allowedGroupIds.indexOf(targetId);
  if (idx === -1) return bot.sendMessage(msg.chat.id, `Group \`${targetId}\` tidak ada.`, { parse_mode: 'Markdown' });
  allowedGroupIds.splice(idx, 1);
  saveGroups();
  await bot.sendMessage(msg.chat.id, `✅ Group \`${targetId}\` dihapus.`, { parse_mode: 'Markdown' });
});

bot.onText(/^\/listgroups(?:@\w+)?$/, async (msg) => {
  if (!isAdmin(msg.from?.id)) return;
  await bot.sendMessage(msg.chat.id,
    `*Allowed Groups (${allowedGroupIds.length}):*\n${allowedGroupIds.map(id => `\`${id}\``).join('\n')}`,
    { parse_mode: 'Markdown' }
  );
});


// ─── File extraction helpers ──────────────────────────────────────────────────
async function downloadFile(fileId) {
  const fileInfo = await bot.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// DeepSeek gak ada vision — gambar dibaca via OCR (ocr-service), hasilnya diperlakukan teks biasa
async function ocrImage(base64, mediaType) {
  const res = await fetch(OCR_SERVICE_URL, {
    method: 'POST',
    headers: { 'Content-Type': mediaType || 'image/jpeg' },
    body: Buffer.from(base64, 'base64'),
  });
  const data = await res.json();
  if (data.error) throw new Error(`OCR gagal: ${data.error}`);
  return data.text || '';
}

async function extractFileContent(msg) {
  const isPhoto = !!msg.photo;
  const doc  = msg.document;
  const mime = doc?.mime_type || '';
  const caption = (msg.caption || '').trim();

  if (isPhoto || mime.startsWith('image/')) {
    const fileId = isPhoto ? msg.photo[msg.photo.length - 1].file_id : doc.file_id;
    const buf = await downloadFile(fileId);
    const mediaType = isPhoto ? 'image/jpeg' : (mime || 'image/jpeg');
    return { type: 'image', base64: buf.toString('base64'), mediaType, caption };
  }

  if (mime === 'application/pdf') {
    const buf  = await downloadFile(doc.file_id);
    const data = await pdfParse(buf);
    return { type: 'text', content: `[File PDF: ${doc.file_name}]\n\n${data.text.slice(0, 12000)}`, caption };
  }

  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const buf    = await downloadFile(doc.file_id);
    const result = await mammoth.extractRawText({ buffer: buf });
    return { type: 'text', content: `[File DOCX: ${doc.file_name}]\n\n${result.value.slice(0, 12000)}`, caption };
  }

  if (mime.startsWith('text/') || ['application/json', 'text/csv', 'text/markdown'].includes(mime)
      || /\.(txt|csv|json|md|yaml|yml|xml)$/i.test(doc.file_name || '')) {
    const buf  = await downloadFile(doc.file_id);
    return { type: 'text', content: `[File: ${doc.file_name}]\n\n${buf.toString('utf-8').slice(0, 12000)}`, caption };
  }

  return null;
}

// ─── Main listener ────────────────────────────────────────────────────────────
bot.on("message", async (msg) => {
  console.log("[msg]", msg.chat.id, msg.chat.type, msg.text?.slice(0,50));
  console.log("[msg]", msg.chat.id, msg.chat.type, msg.text?.slice(0,40));
  const chatId   = msg.chat.id;
  const text     = msg.text?.trim();
  const chatType = msg.chat.type;
  const fromId   = msg.from?.id;
  const fromName = msg.from?.first_name || msg.from?.username || 'Seseorang';

  if (text && text.startsWith('/')) return;

  // ─── SID Core automation: konfirmasi "ya"/"batal" kalau ada pending dry-run ───
  if (text && chatType === 'private' && await handleSidCorePendingReply(bot, msg)) return;

  // ─── File handler ───
  const hasFile = !!msg.photo || !!msg.document;
  if (hasFile) {
    if (paused && !isAdmin(fromId)) { console.log('[msg] blocked: paused'); return; }
    if (chatType === 'private' && !isAllowedUser(fromId)) { console.log('[msg] blocked: private not allowed'); return; }
    if ((chatType === 'group' || chatType === 'supergroup') && !isAllowedGroup(chatId)) { console.log('[msg] blocked: group ' + chatId + ' not in allowedGroupIds'); return; }
    if ((chatType === 'group' || chatType === 'supergroup') && !loudGroups.has(chatId)) {
      const caption     = msg.caption || '';
      const isMentioned = BOT_USERNAME && caption.includes(`@${BOT_USERNAME}`);
      const isReply     = msg.reply_to_message?.from?.id === botInfo?.id;
      if (!isMentioned && !isReply) { console.log('[msg] blocked: file no mention/reply'); return; }
    }
    if (processing.has(chatId)) { console.log('[msg] blocked: processing (file)'); return; }

    await bot.sendChatAction(chatId, 'typing').catch(() => {});
    let extracted;
    try {
      extracted = await extractFileContent(msg);
    } catch (e) {
      await bot.sendMessage(chatId, `Gagal baca file: ${e.message}`, { reply_to_message_id: msg.message_id });
      return;
    }
    if (!extracted) {
      await bot.sendMessage(chatId, 'Format file ini belum didukung. Yang bisa gue baca: gambar, PDF, DOCX, TXT, CSV, JSON.', {
        reply_to_message_id: msg.message_id,
      });
      return;
    }

    const instruction = extracted.caption || 'Baca dan ringkas isi file ini.';
    let userContent;
    if (extracted.type === 'image') {
      let ocrText;
      try { ocrText = await ocrImage(extracted.base64, extracted.mediaType); }
      catch (e) {
        await bot.sendMessage(chatId, `Gagal baca gambar: ${e.message}`, { reply_to_message_id: msg.message_id });
        return;
      }
      userContent = `[${fromName}]: ${instruction}\n\n[Gambar — hasil OCR]\n${ocrText.trim() || '(tidak ada teks terbaca)'}`;
    } else {
      userContent = `[${fromName}]: ${instruction}\n\n${extracted.content}`;
    }
    await handleMessage(chatId, userContent, msg.message_id, fromId).catch(console.error);
    return;
  }

  // ─── Text handler ───
  if (!text) return;
  if (paused && !isAdmin(fromId)) { console.log('[msg] blocked: paused'); return; }


  if (chatType === 'private') {
    if (!isAllowedUser(fromId) && !isAdmin(fromId)) { console.log('[msg] blocked: private not allowed'); return; }
    if (fromId && !notifiedUsers.has(fromId) && !isAdmin(fromId)) {
      notifiedUsers.add(fromId);
      notifyAdmin(msg);
    }
    await handleMessage(chatId, text, msg.message_id, fromId).catch(console.error);
    return;
  }

  if (chatType === 'group' || chatType === 'supergroup') {
    if (!isAllowedGroup(chatId)) { console.log('[msg] blocked: group ' + chatId + ' not in allowedGroupIds'); return; }

    const myUsername  = BOT_USERNAME ? `@${BOT_USERNAME}`.toLowerCase() : null;
    const isMentioned = myUsername && text.toLowerCase().includes(myUsername);
    const isReply     = msg.reply_to_message?.from?.id === botInfo?.id;

    // Skip kalau pesan mention bot lain tapi bukan gue
    const otherBotMentions = (text.match(/@\w+/g) || [])
      .filter(m => /bot|care/i.test(m) && myUsername && m.toLowerCase() !== myUsername);
    if (otherBotMentions.length > 0 && !isMentioned && !isReply) { console.log('[msg] blocked: other bot mention'); return; }

    if (!loudGroups.has(chatId)) {
      const triggered = isTriggerKeyword(text);
      if (!isMentioned && !isReply && !triggered) { console.log('[msg] skipped: no mention/reply/trigger'); return; }
    }

    if (processing.has(chatId)) { console.log('[msg] blocked: processing'); return; }

    console.log('[msg] handling: mentioned=' + isMentioned + ' reply=' + isReply);
    const cleanText = text.replace(new RegExp(`@${BOT_USERNAME}`, 'gi'), '').trim();
    await handleMessage(chatId, `[${fromName}]: ${cleanText || text}`, msg.message_id, fromId).catch(console.error);
  }
});

// ─── Polling error + notif online ────────────────────────────────────────────
// Riwayat perbaikan:
// 2026-09-11 — notif "🟢 Sobat Product online." muncul berulang padahal bukan
//   kita yang restart. Penyebab: SEMUA error EFATAL langsung `process.exit(1)`
//   → Docker (restart: unless-stopped) nyalain ulang → notif lagi (18x kejadian).
//   Fix: EFATAL di-retry in-process + notif online BERGerbang (marker
//   data/notify-online dari scripts/restart-bot.sh, atau env STARTUP_NOTIFY=1).
// 2026-09-28 — 🐞 BUG: cara retry-nya sendiri malah MENUMPUK LOOPS.
//   node-telegram-bot-api 0.66 `stopPolling({cancel:true})` cuma membatalkan
//   request yang sedang jalan, TIDAK men-set `_abort` → di `.finally()` loop
//   lama menjadwalkan dirinya sendiri lagi 1 detik kemudian (bandingkan
//   src/telegramPolling.js stop() baris 58-74 vs _polling() .finally() 163-170).
//   Jadi tiap recovery +1 loop; loop-loop itu saling "terminated by other
//   getUpdates request" (409) tapi kode 09-11 sengaja bikin 409 tidak fatal →
//   numpuk terus sampai 16 koneksi paralel ke api.telegram.org, 283.542 baris
//   log 409 (19-28 Sep 2026), dan bot praktis nggak nerima pesan.
//   Fix: (a) teardown lewat `stopPolling()` TANPA cancel → set `_abort=true`
//   sehingga loop lama benar-benar berhenti sebelum start ulang;
//   (b) 409 sekarang dieskalasi: kalau tetap deras → exit(1) supaya Docker
//   kasih proses BERSIH dengan 1 poller, pakai cooldown anti restart-storm;
//   (c) log 409 di-throttle (30s) biar nggak membanjiri log lagi.
//   Notif online tetap bergerbang: hanya saat restart memang dari kita.
const NOTIFY_MARKER = '/app/data/notify-online';
function notifyRequested() {
  if (process.env.STARTUP_NOTIFY === '1') return 'env STARTUP_NOTIFY=1';
  try {
    if (fsSync.existsSync(NOTIFY_MARKER)) {
      fsSync.unlinkSync(NOTIFY_MARKER);
      return 'marker data/notify-online';
    }
  } catch (e) {}
  return null;
}
function recordPollError(msg) {
  try {
    groupsDb
      .prepare('INSERT INTO bot_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('last_polling_error', new Date().toISOString() + ' ' + msg);
  } catch (e) {}
}
function botStateSet(key, value) {
  try {
    groupsDb
      .prepare('INSERT INTO bot_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  } catch (e) {}
}
function botStateGet(key) {
  try {
    const row = groupsDb.prepare('SELECT value FROM bot_state WHERE key = ?').get(key);
    return row ? row.value : null;
  } catch (e) { return null; }
}

// Teardown polling yang BENAR: tanpa `cancel`, supaya _abort=true dan loop lama
// tidak menjadwalkan dirinya lagi. `cancel:true` = sumber bug 16-loop di atas.
async function stopPollingCleanly() {
  try { await bot.stopPolling(); } catch (e) {}
  for (let i = 0; i < 6; i++) {
    let aktif = false;
    try { aktif = typeof bot.isPolling === 'function' && bot.isPolling(); } catch (e) {}
    if (!aktif) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

let lastPollRecoveryAt = 0;
let pollRecoveryCount = 0;
let recoveringPoll = false;
async function recoverPolling(reason) {
  if (recoveringPoll) return;
  recoveringPoll = true;
  try {
    const now = Date.now();
    if (now - lastPollRecoveryAt > 5 * 60 * 1000) pollRecoveryCount = 0;
    pollRecoveryCount++;
    lastPollRecoveryAt = now;
    recordPollError(reason);
    console.error('[polling] error (' + pollRecoveryCount + 'x dlm 5 mnt): ' + reason);

    if (pollRecoveryCount >= 2) {
      console.error('[polling] gagal berulang — exit(1) biar Docker restart (start senyap, tanpa notif).');
      process.exit(1);
      return;
    }
    console.log('[polling] stop polling dgn abort (bukan cancel) + start ulang dlm 5s…');
    const bersih = await stopPollingCleanly();
    if (!bersih) console.error('[polling] peringatan: polling masih kebaca aktif waktu mau start ulang.');
    await new Promise((r) => setTimeout(r, 5000));
    try {
      await bot.startPolling();
      console.log('[polling] polling jalan lagi ✓');
      pollRecoveryCount = 0;
    } catch (e) {
      console.error('[polling] startPolling gagal: ' + e.message);
    }
  } finally {
    recoveringPoll = false;
  }
}

// ─── 409 CONFLICT: token ini dipakai lebih dari satu poller ──────────────────
const CONFLICT_WINDOW_MS = 10 * 60 * 1000;        // jendela hitung konflik
const CONFLICT_MAX = 20;                          // > ini dlm jendela → restart bersih
const CONFLICT_LOG_EVERY_MS = 30 * 1000;          // throttle log (dulu 283rb baris)
const CLEAN_RESTART_COOLDOWN_MS = 20 * 60 * 1000; // anti restart-storm
const CLEAN_RESTART_KEY = 'last_poll_clean_restart';
let firstConflictAt = 0;
let conflictCount = 0;
let lastConflictLogAt = 0;

function handleConflict(m) {
  const now = Date.now();
  if (now - firstConflictAt > CONFLICT_WINDOW_MS) {
    firstConflictAt = now;
    conflictCount = 0;
    lastConflictLogAt = 0;
  }
  conflictCount++;
  const shouldLog = now - lastConflictLogAt > CONFLICT_LOG_EVERY_MS;
  if (shouldLog) {
    lastConflictLogAt = now;
    console.error('[polling] 409 CONFLICT (' + conflictCount + 'x/' + Math.round(CONFLICT_WINDOW_MS / 60000) + 'mnt) — token ini dipakai poller/instance lain: ' + m);
    recordPollError('409 ' + m);
  }
  if (conflictCount < CONFLICT_MAX) return;

  const sinceClean = now - (Date.parse(botStateGet(CLEAN_RESTART_KEY) || '') || 0);
  if (sinceClean < CLEAN_RESTART_COOLDOWN_MS) {
    if (shouldLog) {
      console.error('[polling] 409 masih deras ' + Math.round(sinceClean / 1000) + 's setelah restart bersih — kemungkinan instance LAIN (di luar container ini) pakai token yang sama; nggak restart lagi biar nggak jadi storm.');
    }
    return;
  }
  console.error('[polling] 409 deras (' + conflictCount + 'x) → exit(1): Docker start proses bersih dgn 1 poller (senyap, tanpa notif).');
  botStateSet(CLEAN_RESTART_KEY, new Date().toISOString());
  process.exit(1);
}

bot.on('polling_error', (err) => {
  const m = String((err && err.message) || err || '');
  if (/409|Conflict/i.test(m)) { handleConflict(m); return; }
  if (m.includes('EFATAL')) { recoverPolling(m); return; }
  console.error('[polling_error]', m);
  recordPollError('soft ' + m);
});

setTimeout(async () => {
  const why = notifyRequested();
  if (!why) {
    console.log('[startup] mode SENYAP — notif online TIDAK dikirim (restart bukan dari kita / auto-restart Docker).');
    return;
  }
  console.log('[startup] notif online dikirim (' + why + ').');
  for (const id of ADMIN_IDS) {
    await bot.sendMessage(id, '🟢 Sobat Product online.').catch(() => {});
  }
}, 4000);

await initGoogle();
// initScheduler(bot, client); // dimatikan 2026-07-02 — reminder terjadwal (07/11/15/17:00) udah gak kepake

// ─── Test scheduler (admin only) ─────────────────────────────────────────────
const { testFire07, testFire11, testFire15, testFire17 } = await import('./scheduler.js');

bot.onText(/^\/testsched(?:@\w+)?(?:\s+(\d+))?$/, async (msg, match) => {
  if (!isAdmin(msg.from?.id)) return;
  const slot = match?.[1] || '07';
  await bot.sendMessage(msg.chat.id, `Firing ${slot}:00...`).catch(() => {});
  try {
    if (slot === '07') await testFire07(bot, client);
    else if (slot === '11') await testFire11(bot, client);
    else if (slot === '15') await testFire15(bot, client);
    else if (slot === '17') await testFire17(bot, client);
    else { await bot.sendMessage(msg.chat.id, 'Slot valid: 07, 11, 15, 17'); return; }
    await bot.sendMessage(msg.chat.id, 'Done. Check groups.').catch(() => {});
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `Error: ${e.message}`).catch(() => {});
  }
});

console.log('Sobat Product started. Groups:', allowedGroupIds);
