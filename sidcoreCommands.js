// ─── SID Core Automation (resign-cleanup / create-roles) ─────────────────────
// Trigger script di ../sid-core-automation (di-mount read-only ke container).
// Cuma bisa dipakai lewat DM (private chat) + user yang ada di SID_CORE_ALLOWED_USER_IDS,
// biar SID_CORE_TOKEN gak ke-expose ke grup. Selalu dry-run dulu, baru minta konfirmasi
// eksplisit ("ya"/"batal") sebelum --execute.

import { spawn } from 'child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const AUTOMATION_DIR = process.env.SID_CORE_AUTOMATION_DIR || '/app/sid-core-automation';
const TIMEOUT_MS = 15 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_MSG_LEN = 3500;

// chatId -> { script, token, label, ts }
export const sidCorePending = new Map();

// chatId -> true selama ada script sid-core-automation lagi jalan. Cegah user nge-spam command
// yang sama berkali-kali (kejadian 2026-07-20: 3x /updaterole ditembak beruntun karena kelihatan
// lambat, 3-3nya jalan BARENGAN rebutan API SID Core + Sheets sampe akhirnya kena timeout 5 menit
// bareng-bareng - user cuma liat 3x pesan "Dry-run error" tanpa penjelasan).
const runningChats = new Set();

function isRunning(chatId) {
  return runningChats.has(chatId);
}

function runScript(scriptName, token, execute, extraArgs = [], timeoutMs = TIMEOUT_MS, extraEnv = {}) {
  return new Promise((resolve) => {
    const args = [scriptName, ...extraArgs];
    if (execute) args.push('--execute');
    const child = spawn('node', args, {
      cwd: AUTOMATION_DIR,
      env: { ...process.env, SID_CORE_TOKEN: token, ...extraEnv },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: -1, output: out + `\n[timeout, script dihentikan paksa setelah ${timeoutMs / 60000} menit]` });
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output: out });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, output: out + `\n[gagal jalanin script: ${err.message}]` });
    });
  });
}

function truncate(text) {
  return text.length > MAX_MSG_LEN ? text.slice(0, MAX_MSG_LEN) + '\n... (dipotong)' : text;
}

// Kirim teks panjang sebagai beberapa pesan berurutan (bukan dipotong kayak truncate()) -
// dipakai buat /cekcicilan yang laporannya bisa lebih panjang dari batas Telegram (4096 char).
async function sendChunked(bot, chatId, text, opts = {}) {
  const chunks = text.match(/[\s\S]{1,3500}/g) || [text];
  for (const chunk of chunks) {
    await bot.sendMessage(chatId, chunk, opts).catch(() => bot.sendMessage(chatId, chunk).catch(() => {}));
  }
}

// ── /cekcicilan: audit paket belajar yang skema pembayarannya "Penuh atau Cicilan" tapi opsi
// cicilan-nya "Tidak Aktif" (period_time_start/end sudah lewat atau belum mulai). Baca-saja,
// fetch langsung ke api.sid.id (bukan spawn ke sid-core-automation, karena command ini gak
// nulis ke sheet - laporannya balik ke chat aja). Ref: audit manual 2026-09-19 org 5 + turunan SMM.
const CICILAN_API_BASE = 'https://api.sid.id/payment/service-learning-package/v1';

async function cicilanFetchJson(url, token) {
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.status !== 200) {
    const msg = body?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

async function cicilanListAllPackages(orgId, token) {
  const items = [];
  let page = 1;
  let totalPage = 1;
  while (page <= totalPage) {
    const url = `${CICILAN_API_BASE}/list/${orgId}/${page}/100?payment_scheme_type=full_or_installment&status=active`;
    const body = await cicilanFetchJson(url, token);
    totalPage = body.total_page || 1;
    items.push(...body.data);
    page += 1;
  }
  return items;
}

// Batasi concurrency biar gak digebok rate-limit / bikin API kelabakan (10 request sekaligus).
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function cicilanKondisi(template, now) {
  const enabled = template.is_period_time_enabled;
  const start = template.period_time_start ? new Date(template.period_time_start) : null;
  const end = template.period_time_end ? new Date(template.period_time_end) : null;
  const isActive = !enabled || (start && end && start <= now && now < end);
  if (isActive) return null;
  if (end && end <= now) return 'lewat';
  if (start && start > now) return 'belum';
  return 'lain';
}

function fmtTgl(d) {
  if (!d) return '';
  return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

async function cicilanAuditOrg(orgId, token) {
  const items = await cicilanListAllPackages(orgId, token);
  const now = new Date();
  const details = await mapWithConcurrency(items, 10, async (it) => {
    const body = await cicilanFetchJson(`${CICILAN_API_BASE}/detail/${it.id}`, token);
    return body.data;
  });
  const rows = [];
  for (const d of details) {
    const templates = d?.installment?.templates || [];
    for (const t of templates) {
      const kondisi = cicilanKondisi(t, now);
      if (!kondisi) continue;
      rows.push({
        packageId: d.id,
        name: d.name,
        academicYear: d.academic_year,
        templateName: t.name,
        start: t.period_time_start ? new Date(t.period_time_start) : null,
        end: t.period_time_end ? new Date(t.period_time_end) : null,
        kondisi,
      });
    }
  }
  return { totalChecked: items.length, rows };
}

// ── Baris DITOLAK pasca dry-run (aksi voucher/diskon) ────────────────────────────────────────
// Script voucher/diskon nulis artifact JSON + CSV berisi baris yang ditolak (lihat
// sid-core-automation/src/rejectionExport.js) ke SIDOPS_REJECTIONS_OUT. Kalau ada isinya,
// file CSV-nya dikirim ke DM sebagai dokumen — biar tim bisa langsung benerin barisnya.
async function kirimBarisDitolak(bot, chatId, outPath) {
  try {
    if (!outPath || !fs.existsSync(outPath)) return;
    const art = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    const jumlah = art.jumlah ?? (art.rejections || []).length;
    if (!jumlah) return;
    const csvPath = art.csvPath || outPath.replace(/\.json$/i, '') + '.csv';
    if (!fs.existsSync(csvPath)) return;
    const perKategori = (art.ringkasan?.perKategori || []).map((k) => `${k.label}: ${k.jumlah}`).join(' · ');
    const top = (art.ringkasan?.teratas || []).slice(0, 3).map((t) => `• ${t.jumlah}x ${String(t.alasan).slice(0, 90)}`).join('\n');
    await bot.sendDocument(chatId, csvPath, {
      caption: `⚠️ ${jumlah} baris DITOLAK (${art.mode === 'dry' ? 'dry-run' : art.mode})${perKategori ? `\n${perKategori}` : ''}${top ? `\n\nAlasan terbanyak:\n${top}` : ''}\n\nBuka di Excel/Sheets — ada kolom Alasan + Saran per baris. Daftar ini TIDAK ditulis ke sheet; ambil dari file ini atau tombol unduh di web /semesta.`,
    }, { filename: `perlu-diperbaiki-${art.tool || 'voucher'}.csv`, contentType: 'text/csv' });
  } catch (err) {
    try { await bot.sendMessage(chatId, `(daftar baris ditolak gagal dikirim: ${err.message})`); } catch { /* diabaikan */ }
  }
}

export function registerSidCoreCommands(bot, { isSidCoreAllowedUser }) {
  async function handleCommand(msg, scriptFile, label, opts = {}) {
    const chatId = msg.chat.id;
    const fromId = msg.from?.id;

    if (msg.chat.type !== 'private') {
      return bot.sendMessage(chatId, 'Command ini cuma bisa dipakai lewat chat pribadi (DM) ke bot, biar token gak ke-expose ke grup.');
    }
    if (!isSidCoreAllowedUser(fromId)) {
      return bot.sendMessage(chatId, 'Kamu belum diizinkan pakai command ini. Hubungi admin buat ditambahin ke SID_CORE_ALLOWED_USER_IDS.');
    }
    if (isRunning(chatId)) {
      return bot.sendMessage(chatId, 'Masih ada proses SID Core lain yang jalan buat kamu, tunggu selesai dulu ya (jangan kirim command yang sama berkali-kali, malah bikin rebutan API dan tambah lambat).');
    }

    const match = msg.text.match(/^\/\w+(?:@\w+)?\s+(\S+)/);
    const token = match?.[1];
    if (!token) {
      return bot.sendMessage(chatId,
        `Kirim tokennya juga ya, format:\n/${label} <SID_CORE_TOKEN>\n\n` +
        'Cara ambil token: login core.sid.id di browser -> F12 -> Network -> klik aksi apapun di halaman Pengguna -> cari request ke api.sid.id -> tab Headers -> copy value Authorization (bagian setelah "Bearer "). Token cuma valid ~1 jam.'
      );
    }

    runningChats.add(chatId);
    // Aksi voucher/diskon (opts.rejections): minta script nulis daftar baris yang DITOLAK ke file,
    // biar setelah dry-run bisa dikirim sebagai CSV ke DM (fitur 2026-09-14).
    const rejPath = opts.rejections ? path.join(os.tmpdir(), `sidops-rejections-${chatId}-${Date.now().toString(36)}.json`) : null;
    try {
      await bot.sendMessage(chatId, `Jalanin dry-run ${label}... (bisa beberapa menit kalau baris di sheet banyak, tunggu aja gak perlu kirim ulang)`);
      const { code, output } = await runScript(scriptFile, token, false, [], TIMEOUT_MS, rejPath ? { SIDOPS_REJECTIONS_OUT: rejPath } : {});
      await bot.sendMessage(chatId, truncate(output || '(kosong)'));

      if (code !== 0) {
        return bot.sendMessage(chatId, 'Dry-run error, cek log di atas. Gak lanjut ke eksekusi.');
      }

      if (rejPath) await kirimBarisDitolak(bot, chatId, rejPath);

      sidCorePending.set(chatId, { script: scriptFile, token, label, ts: Date.now() });
      await bot.sendMessage(chatId, `Itu hasil dry-run. Balas "ya" buat eksekusi beneran, atau "batal" buat cancel. (berlaku 10 menit)`);
    } finally {
      runningChats.delete(chatId);
    }
  }

  bot.onText(/^\/resign(?:@\w+)?(?:\s+(\S+))?$/, (msg) => handleCommand(msg, 'resign-cleanup.js', 'resign-cleanup'));
  bot.onText(/^\/role(?:@\w+)?(?:\s+(\S+))?$/, (msg) => handleCommand(msg, 'create-roles.js', 'create-roles'));
  // edit-role.js: ubah nama + permission role YANG SUDAH ADA, sumbernya sheet
  // "EDIT Role & Permission" tab "Ganti Nama" (semua role udah pre-listed, isi kolom Nama
  // Peran Baru) + tab "Ganti Permission" (append baris ID Role/Hak Akses/Slug) - beda dari
  // /role yang cuma bisa bikin role baru.
  bot.onText(/^\/editrole(?:@\w+)?(?:\s+(\S+))?$/, (msg) => handleCommand(msg, 'edit-role.js', 'edit-role'));
  bot.onText(/^\/updateuser(?:@\w+)?(?:\s+(\S+))?$/, (msg) => handleCommand(msg, 'update-user-data.js', 'update-user-data'));
  // update-user-role.js: Aksi "Tambah" full-support (dry-run + execute, resolve platform_role_id
  // dari role/platform/{id} per platform - lihat CLAUDE.md). Aksi "Hapus" tetap ditunda ("Ditunda"
  // di kolom Status) - endpoint hapus role yang benar belum ketemu.
  bot.onText(/^\/updaterole(?:@\w+)?(?:\s+(\S+))?$/, (msg) => handleCommand(msg, 'update-user-role.js', 'update-user-role'));
  // delete-program-participant.js: hapus user dari Program (learning-catalog service, beda dari
  // SID Core biasa). Dry-run nulis Completion % ke sheet dulu (informasi progress peserta) SEBELUM
  // minta konfirmasi "ya" - biar tim gak salah hapus peserta yang udah jauh progressnya.
  bot.onText(/^\/removeprogram(?:@\w+)?(?:\s+(\S+))?$/, (msg) => handleCommand(msg, 'delete-program-participant.js', 'remove-program-participant'));
  // change-program-status.js: ubah Status Program (Dalam Rencana/Aktif Pendaftaran/Aktif/Arsip/
  // Tutup). Endpoint submit-nya (program/manage/basic) FULL-REPLACE seluruh objek program
  // (bo_list/program_bo_dimensions/pic/dst ikut kekirim ulang) - script fetch state FRESH
  // (get/basic/{id}) tiap baris, ganti cuma field status, sisanya passthrough apa adanya.
  bot.onText(/^\/programstatus(?:@\w+)?(?:\s+(\S+))?$/, (msg) => handleCommand(msg, 'change-program-status.js', 'change-program-status'));
  // add-program-participant.js: tambah user ke Program (skip otomatis kalau udah jadi peserta).
  bot.onText(/^\/addprogram(?:@\w+)?(?:\s+(\S+))?$/, (msg) => handleCommand(msg, 'add-program-participant.js', 'add-program-participant'));
  // manage-platform-org.js / manage-platform-role.js: kaitkan/lepas Organisasi/Role dari
  // Platform. Endpoint submit-nya FULL-REPLACE seluruh config platform (modules/features/dll,
  // BUKAN cuma org/role) - SERIAL (bukan concurrency), fetch state FRESH tiap baris.
  bot.onText(/^\/platformorg(?:@\w+)?(?:\s+(\S+))?$/, (msg) => handleCommand(msg, 'manage-platform-org.js', 'manage-platform-org'));
  bot.onText(/^\/platformrole(?:@\w+)?(?:\s+(\S+))?$/, (msg) => handleCommand(msg, 'manage-platform-role.js', 'manage-platform-role'));
  // manage-pic-program.js: tambah PIC (Desainer/Fasilitator) ke Program, skip kalau udah jadi PIC.
  bot.onText(/^\/addpic(?:@\w+)?(?:\s+(\S+))?$/, (msg) => handleCommand(msg, 'manage-pic-program.js', 'manage-pic-program'));
  // manage-group-program.js: Tambah/Ubah/Hapus Kelompok + Tambah/Pindah Anggota, 1 sheet Aksi.
  bot.onText(/^\/kelompok(?:@\w+)?(?:\s+(\S+))?$/, (msg) => handleCommand(msg, 'manage-group-program.js', 'manage-group-program'));
  // create-program.js / add-program-activity.js / add-program-topic.js: BARU 2026-09-13 dari
  // HAR capture (reverse-engineer flow "Buat Program dari nol" - lihat
  // sid-core-automation/src/programCreateApi.js). Full round-trip test live SUKSES sekali
  // (Program 71454, Activity 1027877/1027927, Topic 407654) tapi belum dipakai rutin oleh tim.
  // add-program-activity.js HANYA support content type "Teks" - tipe lain ditolak eksplisit.
  bot.onText(/^\/buatprogram(?:@\w+)?(?:\s+(\S+))?$/, (msg) => handleCommand(msg, 'create-program.js', 'create-program'));
  bot.onText(/^\/tambahaktivitas(?:@\w+)?(?:\s+(\S+))?$/, (msg) => handleCommand(msg, 'add-program-activity.js', 'add-program-activity'));
  bot.onText(/^\/tambahtopic(?:@\w+)?(?:\s+(\S+))?$/, (msg) => handleCommand(msg, 'add-program-topic.js', 'add-program-topic'));
  bot.onText(/^\/duplicateprogram(?:@\w+)?(?:\s+(\S+))?$/, (msg) => handleCommand(msg, 'duplicate-program.js', 'duplicateprogram'));
  bot.onText(/^\/duplicatekerangka(?:@\w+)?(?:\s+(\S+))?$/, (msg) => handleCommand(msg, 'batch-duplicate-program.js', 'duplicatekerangka'));
  // manage-voucher-discount.js: tambah/update aturan diskon (produk+persentase) di campaign
  // voucher yang sudah ada (sheet Manage Voucher Diskon, tab Template). v1 khusus pola HRSID
  // (org Sekolah Murid Merdeka id 5, 3 produk fixed) - lihat CLAUDE.md utk detail & gotcha.
  bot.onText(/^\/voucher(?:@\w+)?(?:\s+(\S+))?$/, (msg) => handleCommand(msg, 'manage-voucher-discount.js', 'manage-voucher-discount'));
  // create-voucher-campaign.js: bikin campaign voucher BARU dari nol (sheet Manage Voucher
  // Diskon, tab "Buat Baru") - khusus pola HRSID juga, endpoint create sekaligus bikin rules.
  bot.onText(/^\/newvoucher(?:@\w+)?(?:\s+(\S+))?$/, (msg) => handleCommand(msg, 'create-voucher-campaign.js', 'create-voucher-campaign', { rejections: true }));
  // update-voucher-products.js (2026-09-08): TAMBAH aturan diskon BARU ke produk di campaign
  // yang SUDAH ADA, beda dari /voucher yang treat product_id sbg key unik (upsert 1 rule/produk)
  // - command ini boleh produk SAMA berulang (periode/skema-bayar/termin/email beda), sheet
  // Manage Voucher Diskon tab "Template Product". Lihat CLAUDE.md utk gotcha overlap.
  bot.onText(/^\/updateproduk(?:@\w+)?(?:\s+(\S+))?$/, (msg) => handleCommand(msg, 'update-voucher-products.js', 'update-voucher-products', { rejections: true }));

  // sync-role-template.js gak ada mode --execute (cuma nulis tab "Template" yang emang
  // dirancang buat ditulis ulang, bukan role beneran) - jadi langsung jalan, gak perlu dry-run+konfirmasi.
  bot.onText(/^\/synctemplate(?:@\w+)?(?:\s+(\S+))?$/, async (msg) => {
    const chatId = msg.chat.id;
    const fromId = msg.from?.id;

    if (msg.chat.type !== 'private') {
      return bot.sendMessage(chatId, 'Command ini cuma bisa dipakai lewat chat pribadi (DM) ke bot, biar token gak ke-expose ke grup.');
    }
    if (!isSidCoreAllowedUser(fromId)) {
      return bot.sendMessage(chatId, 'Kamu belum diizinkan pakai command ini.');
    }
    if (isRunning(chatId)) {
      return bot.sendMessage(chatId, 'Masih ada proses SID Core lain yang jalan buat kamu, tunggu selesai dulu ya.');
    }

    const match = msg.text.match(/^\/\w+(?:@\w+)?\s+(\S+)/);
    const token = match?.[1];
    if (!token) {
      return bot.sendMessage(chatId, 'Kirim tokennya juga ya, format:\n/synctemplate <SID_CORE_TOKEN>');
    }

    runningChats.add(chatId);
    try {
      await bot.sendMessage(chatId, 'Sync tab Template dari katalog permission SID Core terbaru...');
      const { code, output } = await runScript('sync-role-template.js', token, false);
      await bot.sendMessage(chatId, truncate(output || '(kosong)'));
      await bot.sendMessage(chatId, code === 0 ? 'Selesai.' : 'Ada error, cek log di atas.');
    } finally {
      runningChats.delete(chatId);
    }
  });

  // reindex-transaction.js (2026-09-16): reindex transaksi BY ID dari sheet "Reindex Transaksi"
  // tab Reindex (tim paste ID transaksi). Aksi ini MENULIS ke SID Core (/sync) pas --execute,
  // jadi pakai alur dry-run + konfirmasi standar.
  bot.onText(/^\/reindex(?:@\w+)?(?:\s+(\S+))?$/, (msg) =>
    handleCommand(msg, 'reindex-transaction.js', 'reindex-transaction'));

  // reindex-transaction-period.js (2026-09-16): reindex BY PERIODE. Yang dijalanin dari bot cuma
  // langkah EXPORT (baca /list, isi tab Export - non-destruktif, gak manggil /sync). Eksekusinya
  // sengaja TIDAK dari bot: harus lewat web/CLI setelah tim review + nandai baris di tab Export.
  bot.onText(/^\/reindexperiode(?:@\w+)?(?:\s+(\S+))?$/, async (msg) => {
    const chatId = msg.chat.id;
    const fromId = msg.from?.id;

    if (msg.chat.type !== 'private') {
      return bot.sendMessage(chatId, 'Command ini cuma bisa dipakai lewat chat pribadi (DM) ke bot, biar token gak ke-expose ke grup.');
    }
    if (!isSidCoreAllowedUser(fromId)) {
      return bot.sendMessage(chatId, 'Kamu belum diizinkan pakai command ini.');
    }
    if (isRunning(chatId)) {
      return bot.sendMessage(chatId, 'Masih ada proses SID Core lain yang jalan buat kamu, tunggu selesai dulu ya.');
    }

    const match = msg.text.match(/^\/\w+(?:@\w+)?\s+(\S+)/);
    const token = match?.[1];
    if (!token) {
      return bot.sendMessage(chatId, 'Kirim tokennya juga ya, format:\n/reindexperiode <SID_CORE_TOKEN>');
    }

    runningChats.add(chatId);
    try {
      await bot.sendMessage(chatId, 'Nyari kandidat transaksi dari tab Periode (periode maks 7 hari + platform wajib)...');
      const { code, output } = await runScript('reindex-transaction-period.js', token, false);
      await bot.sendMessage(chatId, truncate(output || '(kosong)'));
      await bot.sendMessage(
        chatId,
        code === 0
          ? 'Kandidat sudah diisi di tab "Export". Langkah berikutnya: tandai kolom A (REINDEX) buat baris yang mau direindex, lalu eksekusi dari web /semesta atau CLI (--from-export --execute). Reindex TIDAK dijalankan dari bot biar ada review dulu.'
          : 'Ada error, cek log di atas.'
      );
    } finally {
      runningChats.delete(chatId);
    }
  });

  // reindex-billing.js (BARU 2026-09-22): reindex TAGIHAN (bill payment) BY ID dari sheet "Reindex
  // Billing" tab `Tagihan`. Gunanya: angka peserta tagihan yang tidak sinkron (upload peserta gagal
  // bikin angkanya nambah padahal pesertanya tidak muncul di daftar) dihitung ulang sampai sama
  // dengan jumlah peserta sebenarnya. Aksi ini MENULIS ke SID (POST billings/index) saat --execute,
  // jadi pakai alur dry-run + konfirmasi standar.
  bot.onText(/^\/reindexbilling(?:@\w+)?(?:\s+(\S+))?$/, (msg) =>
    handleCommand(msg, 'reindex-billing.js', 'reindex-billing'));

  // reindex-billing-org.js (BARU 2026-09-22): reindex tagihan BY ORGANISASI. Yang dijalanin dari bot
  // cuma FASE 1 (scan semua tagihan 1 organisasi, bandingkan angka dilaporkan vs sebenarnya, isi tab
  // `Kandidat` - non-destruktif). Eksekusinya sengaja TIDAK dari bot: tim harus review + nandai
  // "REINDEX" di tab Kandidat dulu, baru dijalankan (mode Eksekusi) dari web /semesta.
  bot.onText(/^\/reindexbillingorg(?:@\w+)?(?:\s+(\S+))?$/, async (msg) => {
    const chatId = msg.chat.id;
    const fromId = msg.from?.id;

    if (msg.chat.type !== 'private') {
      return bot.sendMessage(chatId, 'Command ini cuma bisa dipakai lewat chat pribadi (DM) ke bot, biar token gak ke-expose ke grup.');
    }
    if (!isSidCoreAllowedUser(fromId)) {
      return bot.sendMessage(chatId, 'Kamu belum diizinkan pakai command ini.');
    }
    if (isRunning(chatId)) {
      return bot.sendMessage(chatId, 'Masih ada proses SID Core lain yang jalan buat kamu, tunggu selesai dulu ya.');
    }

    const match = msg.text.match(/^\/\w+(?:@\w+)?\s+(\S+)/);
    const token = match?.[1];
    if (!token) {
      return bot.sendMessage(chatId, 'Kirim tokennya juga ya, format:\n/reindexbillingorg <SID_CORE_TOKEN>');
    }

    runningChats.add(chatId);
    try {
      await bot.sendMessage(chatId, 'Nyari tagihan yang angkanya tidak sinkron dari tab Organisasi (scan read-only)...');
      const { code, output } = await runScript('reindex-billing-org.js', token, false);
      await bot.sendMessage(chatId, truncate(output || '(kosong)'));
      await bot.sendMessage(
        chatId,
        code === 0
          ? 'Kandidat sudah diisi di tab "Kandidat". Langkah berikutnya: tandai REINDEX di kolom A buat baris yang mau diperbaiki, lalu jalankan dari web /semesta (mode Eksekusi). Eksekusi TIDAK dijalankan dari bot biar ada review dulu.'
          : 'Ada error, cek log di atas.'
      );
    } finally {
      runningChats.delete(chatId);
    }
  });

  // export-roles.js juga non-destruktif (cuma baca semua role & tulis ke sheet export) -
  // langsung jalan, gak perlu dry-run+konfirmasi.
  bot.onText(/^\/exportroles(?:@\w+)?(?:\s+(\S+))?$/, async (msg) => {
    const chatId = msg.chat.id;
    const fromId = msg.from?.id;

    if (msg.chat.type !== 'private') {
      return bot.sendMessage(chatId, 'Command ini cuma bisa dipakai lewat chat pribadi (DM) ke bot, biar token gak ke-expose ke grup.');
    }
    if (!isSidCoreAllowedUser(fromId)) {
      return bot.sendMessage(chatId, 'Kamu belum diizinkan pakai command ini.');
    }
    if (isRunning(chatId)) {
      return bot.sendMessage(chatId, 'Masih ada proses SID Core lain yang jalan buat kamu, tunggu selesai dulu ya.');
    }

    const match = msg.text.match(/^\/\w+(?:@\w+)?\s+(\S+)/);
    const token = match?.[1];
    if (!token) {
      return bot.sendMessage(chatId, 'Kirim tokennya juga ya, format:\n/exportroles <SID_CORE_TOKEN>');
    }

    runningChats.add(chatId);
    try {
      await bot.sendMessage(chatId, 'Export semua role dari SID Core ke sheet...');
      const { code, output } = await runScript('export-roles.js', token, false);
      await bot.sendMessage(chatId, truncate(output || '(kosong)'));
      await bot.sendMessage(chatId, code === 0 ? 'Selesai.' : 'Ada error, cek log di atas.');
    } finally {
      runningChats.delete(chatId);
    }
  });

  // export-role-descriptions.js: baca data/role-descriptions.json (hasil generate-descriptions.js
  // di project role-dashboard, DI LUAR sid-core-automation) & tulis kolom Type/Scope/Deskripsi (AI)
  // ke tab Role (kolom F/G/H). Gak butuh SID_CORE_TOKEN (gak manggil API SID Core sama sekali),
  // cuma baca file lokal + tulis sheet - jadi command ini gak minta token kayak yang lain.
  bot.onText(/^\/exportdeskripsi(?:@\w+)?$/, async (msg) => {
    const chatId = msg.chat.id;
    const fromId = msg.from?.id;

    if (msg.chat.type !== 'private') {
      return bot.sendMessage(chatId, 'Command ini cuma bisa dipakai lewat chat pribadi (DM) ke bot, biar token gak ke-expose ke grup.');
    }
    if (!isSidCoreAllowedUser(fromId)) {
      return bot.sendMessage(chatId, 'Kamu belum diizinkan pakai command ini.');
    }
    if (isRunning(chatId)) {
      return bot.sendMessage(chatId, 'Masih ada proses SID Core lain yang jalan buat kamu, tunggu selesai dulu ya.');
    }

    runningChats.add(chatId);
    try {
      await bot.sendMessage(chatId, 'Generate deskripsi role baru (kalau ada) + tulis Type/Scope/Deskripsi ke tab Role... (bisa beberapa menit kalau banyak role baru)');
      const { code, output } = await runScript('export-role-descriptions.js', 'n/a', false);
      await bot.sendMessage(chatId, truncate(output || '(kosong)'));
      await bot.sendMessage(chatId, code === 0 ? 'Selesai.' : 'Ada error, cek log di atas.');
    } finally {
      runningChats.delete(chatId);
    }
  });

  // reconcile-role-code.js: cocokkan Role Code dari katalog manual tim ("Importrange ROLE SID",
  // di-IMPORTRANGE dari sheet redesign role terpisah) ke role LIVE (tab Role). Auto-match nama
  // persis, sisanya ditulis ke tab "Rekonsiliasi Role Code" (kolom B bisa diisi manual, lalu
  // jalanin ulang command ini buat sync). Output siap-share ada di tab "Usulan Katalog Role".
  // Mapping yang udah dikonfirmasi disimpen persisten (role-code-mapping.json), gak perlu
  // diulang tiap run - cuma role BARU yang bakal muncul "BELUM ADA KODE".
  bot.onText(/^\/rekonrole(?:@\w+)?$/, async (msg) => {
    const chatId = msg.chat.id;
    const fromId = msg.from?.id;

    if (msg.chat.type !== 'private') {
      return bot.sendMessage(chatId, 'Command ini cuma bisa dipakai lewat chat pribadi (DM) ke bot, biar token gak ke-expose ke grup.');
    }
    if (!isSidCoreAllowedUser(fromId)) {
      return bot.sendMessage(chatId, 'Kamu belum diizinkan pakai command ini.');
    }
    if (isRunning(chatId)) {
      return bot.sendMessage(chatId, 'Masih ada proses SID Core lain yang jalan buat kamu, tunggu selesai dulu ya.');
    }

    runningChats.add(chatId);
    try {
      await bot.sendMessage(chatId, 'Rekonsiliasi Role Code (live vs katalog manual) + update tab Usulan Katalog Role...');
      const { code, output } = await runScript('reconcile-role-code.js', 'n/a', false);
      await bot.sendMessage(chatId, truncate(output || '(kosong)'));
      await bot.sendMessage(chatId, code === 0 ? 'Selesai.' : 'Ada error, cek log di atas.');
    } finally {
      runningChats.delete(chatId);
    }
  });

  // export-organizations.js juga non-destruktif (cuma baca semua organisasi & tulis ke sheet export) -
  // langsung jalan, gak perlu dry-run+konfirmasi.
  bot.onText(/^\/exportorg(?:@\w+)?(?:\s+(\S+))?$/, async (msg) => {
    const chatId = msg.chat.id;
    const fromId = msg.from?.id;

    if (msg.chat.type !== 'private') {
      return bot.sendMessage(chatId, 'Command ini cuma bisa dipakai lewat chat pribadi (DM) ke bot, biar token gak ke-expose ke grup.');
    }
    if (!isSidCoreAllowedUser(fromId)) {
      return bot.sendMessage(chatId, 'Kamu belum diizinkan pakai command ini.');
    }
    if (isRunning(chatId)) {
      return bot.sendMessage(chatId, 'Masih ada proses SID Core lain yang jalan buat kamu, tunggu selesai dulu ya.');
    }

    const match = msg.text.match(/^\/\w+(?:@\w+)?\s+(\S+)/);
    const token = match?.[1];
    if (!token) {
      return bot.sendMessage(chatId, 'Kirim tokennya juga ya, format:\n/exportorg <SID_CORE_TOKEN>');
    }

    runningChats.add(chatId);
    try {
      await bot.sendMessage(chatId, 'Export semua organisasi dari SID Core ke sheet...');
      const { code, output } = await runScript('export-organizations.js', token, false);
      await bot.sendMessage(chatId, truncate(output || '(kosong)'));
      await bot.sendMessage(chatId, code === 0 ? 'Selesai.' : 'Ada error, cek log di atas.');
    } finally {
      runningChats.delete(chatId);
    }
  });

  // export-learning-spaces.js: non-destruktif, tarik semua Lokasi Belajar (learning-space,
  // service-organization) ke sheet Lokasi Belajar - langsung jalan, gak perlu konfirmasi.
  bot.onText(/^\/exportlokasi(?:@\w+)?(?:\s+(\S+))?$/, async (msg) => {
    const chatId = msg.chat.id;
    const fromId = msg.from?.id;

    if (msg.chat.type !== 'private') {
      return bot.sendMessage(chatId, 'Command ini cuma bisa dipakai lewat chat pribadi (DM) ke bot, biar token gak ke-expose ke grup.');
    }
    if (!isSidCoreAllowedUser(fromId)) {
      return bot.sendMessage(chatId, 'Kamu belum diizinkan pakai command ini.');
    }
    if (isRunning(chatId)) {
      return bot.sendMessage(chatId, 'Masih ada proses SID Core lain yang jalan buat kamu, tunggu selesai dulu ya.');
    }

    const match = msg.text.match(/^\/\w+(?:@\w+)?\s+(\S+)/);
    const token = match?.[1];
    if (!token) {
      return bot.sendMessage(chatId, 'Kirim tokennya juga ya, format:\n/exportlokasi <SID_CORE_TOKEN>');
    }

    runningChats.add(chatId);
    try {
      await bot.sendMessage(chatId, 'Export semua Lokasi Belajar dari SID Core ke sheet...');
      const { code, output } = await runScript('export-learning-spaces.js', token, false);
      await bot.sendMessage(chatId, truncate(output || '(kosong)'));
      await bot.sendMessage(chatId, code === 0 ? 'Selesai.' : 'Ada error, cek log di atas.');
    } finally {
      runningChats.delete(chatId);
    }
  });

  // export-behavioral-objectives.js: non-destruktif, tarik Bank Kompetensi (Behavioral Objective)
  // org Sekolah Cikal (id 6, hardcode di script) ke sheet - langsung jalan, gak perlu konfirmasi.
  // export-behavioral-objectives.js: export Bank Kompetensi (BO) 1 organisasi, read-only.
  // Org opsional: /exportbo <token> [id organisasi]. ID organisasi BEDA antar env (lihat
  // catatan di sid-core-automation/src/apiBase.js): 6 = Sekolah Cikal (production, default),
  // 5 = Sekolah Murid Merdeka (production), 495 = SMM di staging.
  bot.onText(/^\/exportbo(?:@\w+)?(?:\s+(\S+))?(?:\s+(\d{1,6}))?$/, async (msg) => {
    const chatId = msg.chat.id;
    const fromId = msg.from?.id;

    if (msg.chat.type !== 'private') {
      return bot.sendMessage(chatId, 'Command ini cuma bisa dipakai lewat chat pribadi (DM) ke bot, biar token gak ke-expose ke grup.');
    }
    if (!isSidCoreAllowedUser(fromId)) {
      return bot.sendMessage(chatId, 'Kamu belum diizinkan pakai command ini.');
    }
    if (isRunning(chatId)) {
      return bot.sendMessage(chatId, 'Masih ada proses SID Core lain yang jalan buat kamu, tunggu selesai dulu ya.');
    }

    const match = msg.text.match(/^\/\w+(?:@\w+)?\s+(\S+)/);
    const token = match?.[1];
    if (!token) {
      return bot.sendMessage(chatId, 'Kirim tokennya juga ya, format:\n/exportbo <SID_CORE_TOKEN> [id organisasi]\n\nid organisasi opsional: 6 = Sekolah Cikal (default), 5 = Sekolah Murid Merdeka.');
    }
    const orgMatch = msg.text.match(/^\/\w+(?:@\w+)?\s+\S+\s+(\d{1,6})\s*$/);
    const orgId = orgMatch?.[1] || null;

    runningChats.add(chatId);
    try {
      await bot.sendMessage(chatId, `Export Bank Kompetensi (BO) organisasi ${orgId || '6'} dari SID Core ke sheet...`);
      const { code, output } = await runScript('export-behavioral-objectives.js', token, false, orgId ? [`--org=${orgId}`] : []);
      await bot.sendMessage(chatId, truncate(output || '(kosong)'));
      await bot.sendMessage(chatId, code === 0 ? 'Selesai.' : 'Ada error, cek log di atas.');
    } finally {
      runningChats.delete(chatId);
    }
  });

  // export-group-reference.js: non-destruktif (baca kelompok 50 program terbaru & tulis ke tab
  // "Referensi Kelompok" di sheet Manage Kelompok Program) - langsung jalan, gak perlu konfirmasi.
  // Dipakai buat lookup ID Kelompok sebelum isi Aksi Ubah/Hapus/Tambah Anggota/Pindah Anggota.
  bot.onText(/^\/exportkelompok(?:@\w+)?(?:\s+(\S+))?(?:\s+(\S+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const fromId = msg.from?.id;

    if (msg.chat.type !== 'private') {
      return bot.sendMessage(chatId, 'Command ini cuma bisa dipakai lewat chat pribadi (DM) ke bot, biar token gak ke-expose ke grup.');
    }
    if (!isSidCoreAllowedUser(fromId)) {
      return bot.sendMessage(chatId, 'Kamu belum diizinkan pakai command ini.');
    }
    if (isRunning(chatId)) {
      return bot.sendMessage(chatId, 'Masih ada proses SID Core lain yang jalan buat kamu, tunggu selesai dulu ya.');
    }

    const token = match?.[1];
    const programId = match?.[2];
    if (!token) {
      return bot.sendMessage(chatId, 'Kirim tokennya juga ya, format:\n/exportkelompok <SID_CORE_TOKEN> [ID_PROGRAM]\n\nID_PROGRAM opsional - kalau diisi, cuma scan 1 program itu (cepat). Kalau kosong, scan 50 program terbaru (lebih lambat, buat overview umum).');
    }

    runningChats.add(chatId);
    try {
      await bot.sendMessage(chatId, programId
        ? `Export daftar kelompok program ${programId} ke tab Referensi Kelompok...`
        : 'Export daftar kelompok (50 program terbaru) ke tab Referensi Kelompok...');
      const { code, output } = await runScript('export-group-reference.js', token, false, programId ? [programId] : []);
      await bot.sendMessage(chatId, truncate(output || '(kosong)'));
      await bot.sendMessage(chatId, code === 0 ? 'Selesai.' : 'Ada error, cek log di atas.');
    } finally {
      runningChats.delete(chatId);
    }
  });

  // export-platform-org-role.js: non-destruktif (baca semua platform + organisasi & role di
  // tiap platform, tulis ke sheet Platform x Org + Role tab Organisasi/Role) - langsung jalan,
  // gak perlu konfirmasi.
  bot.onText(/^\/exportplatform(?:@\w+)?(?:\s+(\S+))?$/, async (msg) => {
    const chatId = msg.chat.id;
    const fromId = msg.from?.id;

    if (msg.chat.type !== 'private') {
      return bot.sendMessage(chatId, 'Command ini cuma bisa dipakai lewat chat pribadi (DM) ke bot, biar token gak ke-expose ke grup.');
    }
    if (!isSidCoreAllowedUser(fromId)) {
      return bot.sendMessage(chatId, 'Kamu belum diizinkan pakai command ini.');
    }
    if (isRunning(chatId)) {
      return bot.sendMessage(chatId, 'Masih ada proses SID Core lain yang jalan buat kamu, tunggu selesai dulu ya.');
    }

    const match = msg.text.match(/^\/\w+(?:@\w+)?\s+(\S+)/);
    const token = match?.[1];
    if (!token) {
      return bot.sendMessage(chatId, 'Kirim tokennya juga ya, format:\n/exportplatform <SID_CORE_TOKEN>');
    }

    runningChats.add(chatId);
    try {
      await bot.sendMessage(chatId, 'Export daftar organisasi & role tiap platform ke sheet...');
      const { code, output } = await runScript('export-platform-org-role.js', token, false);
      await bot.sendMessage(chatId, truncate(output || '(kosong)'));
      await bot.sendMessage(chatId, code === 0 ? 'Selesai.' : 'Ada error, cek log di atas.');
    } finally {
      runningChats.delete(chatId);
    }
  });

  // check-program-detail.js: non-destruktif (baca ID Program dari sheet Detail Program, tulis
  // Nama Program/Periode/Organisasi Penyedia/Platform/Status/Peserta) - langsung jalan, gak
  // perlu konfirmasi. Dipakai buat validasi ID Program SEBELUM /addprogram (feedback user
  // 2026-07-21 - salah 1 digit ID Program gampang kejadian di sheet ribuan baris).
  bot.onText(/^\/checkprogram(?:@\w+)?(?:\s+(\S+))?$/, async (msg) => {
    const chatId = msg.chat.id;
    const fromId = msg.from?.id;

    if (msg.chat.type !== 'private') {
      return bot.sendMessage(chatId, 'Command ini cuma bisa dipakai lewat chat pribadi (DM) ke bot, biar token gak ke-expose ke grup.');
    }
    if (!isSidCoreAllowedUser(fromId)) {
      return bot.sendMessage(chatId, 'Kamu belum diizinkan pakai command ini.');
    }
    if (isRunning(chatId)) {
      return bot.sendMessage(chatId, 'Masih ada proses SID Core lain yang jalan buat kamu, tunggu selesai dulu ya.');
    }

    const match = msg.text.match(/^\/\w+(?:@\w+)?\s+(\S+)/);
    const token = match?.[1];
    if (!token) {
      return bot.sendMessage(chatId, 'Kirim tokennya juga ya, format:\n/checkprogram <SID_CORE_TOKEN>');
    }

    runningChats.add(chatId);
    try {
      await bot.sendMessage(chatId, 'Cek detail ID Program (Nama/Periode/Organisasi/Platform/Status/Peserta) dari sheet Detail Program...');
      const { code, output } = await runScript('check-program-detail.js', token, false);
      await bot.sendMessage(chatId, truncate(output || '(kosong)'));
      await bot.sendMessage(chatId, code === 0 ? 'Selesai.' : 'Ada error, cek log di atas.');
    } finally {
      runningChats.delete(chatId);
    }
  });

  // export-vouchers.js: non-destruktif (baca semua campaign/voucher org Sekolah Murid Merdeka,
  // tulis ringkasan ke tab Sheet1 sheet Data Kode Voucher SID) - langsung jalan, gak perlu
  // konfirmasi. Cepat (~430 campaign, beberapa page call doang).
  bot.onText(/^\/exportvoucher(?:@\w+)?(?:\s+(\S+))?$/, async (msg) => {
    const chatId = msg.chat.id;
    const fromId = msg.from?.id;

    if (msg.chat.type !== 'private') {
      return bot.sendMessage(chatId, 'Command ini cuma bisa dipakai lewat chat pribadi (DM) ke bot, biar token gak ke-expose ke grup.');
    }
    if (!isSidCoreAllowedUser(fromId)) {
      return bot.sendMessage(chatId, 'Kamu belum diizinkan pakai command ini.');
    }
    if (isRunning(chatId)) {
      return bot.sendMessage(chatId, 'Masih ada proses SID Core lain yang jalan buat kamu, tunggu selesai dulu ya.');
    }

    const match = msg.text.match(/^\/\w+(?:@\w+)?\s+(\S+)/);
    const token = match?.[1];
    if (!token) {
      return bot.sendMessage(chatId, 'Kirim tokennya juga ya, format:\n/exportvoucher <SID_CORE_TOKEN>');
    }

    runningChats.add(chatId);
    try {
      await bot.sendMessage(chatId, 'Export semua kode voucher/diskon (Sekolah Murid Merdeka) ke sheet...');
      const { code, output } = await runScript('export-vouchers.js', token, false);
      await bot.sendMessage(chatId, truncate(output || '(kosong)'));
      await bot.sendMessage(chatId, code === 0 ? 'Selesai.' : 'Ada error, cek log di atas.');
    } finally {
      runningChats.delete(chatId);
    }
  });

  // export-voucher-rules.js: non-destruktif (baca Aturan Diskon 1 voucher, tulis ke tab "Aturan
  // Diskon" sheet yang sama) - langsung jalan, gak perlu konfirmasi.
  // SEJAK 2026-09-14: WAJIB 2 argumen -> --org=<id organisasi> --kode=<KODE DISKON>, scope 1 voucher.
  // Cepat (2-3 API call, hitungan detik) karena cuma 1 campaign, bukan 430 seperti sebelumnya.
  // Baris voucher lain di tab DIPERTAHANKAN (merge per Campaign ID), bukan clear-all.
  // ID organisasi BEDA per env: production 5 (SMM), staging 612.
  bot.onText(/^\/exportvoucherrules(?:@\w+)?(?:\s+(\S+))?(?:\s+(\S+))?(?:\s+(\S+))?$/, async (msg, m) => {
    const chatId = msg.chat.id;
    const fromId = msg.from?.id;

    if (msg.chat.type !== 'private') {
      return bot.sendMessage(chatId, 'Command ini cuma bisa dipakai lewat chat pribadi (DM) ke bot, biar token gak ke-expose ke grup.');
    }
    if (!isSidCoreAllowedUser(fromId)) {
      return bot.sendMessage(chatId, 'Kamu belum diizinkan pakai command ini.');
    }
    if (isRunning(chatId)) {
      return bot.sendMessage(chatId, 'Masih ada proses SID Core lain yang jalan buat kamu, tunggu selesai dulu ya.');
    }

    const token = m?.[1];
    const orgId = (m?.[2] || '').trim();
    const kode = (m?.[3] || '').trim().toUpperCase();

    if (!token) {
      return bot.sendMessage(chatId, 'Format:\n/exportvoucherrules <SID_CORE_TOKEN> <ID_ORGANISASI> <KODE_DISKON>\n\nContoh:\n/exportvoucherrules eyJhbGci... 5 HRSIDDELUNA26\n\nCatatan: ID organisasi beda per env — production 5 (SMM), staging 612. Prosesnya cepat (hitungan detik) karena cuma 1 voucher, dan voucher lain di tab "Aturan Diskon" gak ikut kehapus.');
    }
    if (!orgId || !kode) {
      const kurang = [!orgId ? 'ID Organisasi' : null, !kode ? 'Kode Diskon' : null].filter(Boolean).join(' + ');
      return bot.sendMessage(chatId, `Kurang: ${kurang}.\n\nFormat:\n/exportvoucherrules <SID_CORE_TOKEN> <ID_ORGANISASI> <KODE_DISKON>\n\nContoh:\n/exportvoucherrules <token> 5 HRSIDDELUNA26`);
    }
    if (!/^\d+$/.test(orgId)) {
      return bot.sendMessage(chatId, `ID Organisasi harus angka (ID numerik), kamu kirim "${orgId}". Contoh: 5 (production SMM) atau 612 (staging).`);
    }
    if (!/^[A-Za-z0-9._-]+$/.test(kode)) {
      return bot.sendMessage(chatId, `Kode Diskon "${kode}" formatnya gak valid — cuma huruf/angka/titik/strip/underscore. Contoh: HRSIDDELUNA26`);
    }

    runningChats.add(chatId);
    try {
      await bot.sendMessage(chatId, `Export aturan diskon voucher *${kode}* (organisasi ${orgId}) — ambil detailnya, lalu ganti baris voucher itu di tab "Aturan Diskon". Voucher lain gak disentuh. Sebentar ya...`, { parse_mode: 'Markdown' });
      const { code, output } = await runScript('export-voucher-rules.js', token, false, [`--org=${orgId}`, `--kode=${kode}`]);
      await bot.sendMessage(chatId, truncate(output || '(kosong)'));
      await bot.sendMessage(chatId, code === 0 ? 'Selesai.' : 'Ada error, cek log di atas.');
    } finally {
      runningChats.delete(chatId);
    }
  });

  // export-program-participation.js: non-destruktif (baca antrian ID Program di tab "Program",
  // buat tiap program pending: tarik semua peserta -> tab "List Participant", tarik nilai
  // kuis/tugas per-soal -> tab "Activity: Kuis dan Penugasan") - langsung jalan, gak perlu
  // konfirmasi. Tim nambah ID Program sendiri ke tab "Program" (kolom Status dikosongin =
  // pending), command ini cuma trigger proses antrian-nya. Tulis ke sheet PER PROGRAM (bukan
  // sekali di akhir) jadi aman di-timeout/di-retry - program yang udah "Done" otomatis di-skip
  // run berikutnya. Program gede (ribuan peserta) bisa makan >15 menit sendiri - timeout custom
  // 55 menit biar muat beberapa program sekaligus, TAPI kalau antrian isinya banyak program besar
  // & keburu abis 55 menit, tinggal ambil token baru + /exportprogram lagi (yang udah Done aman,
  // gak keproses ulang - TAPI JANGAN taruh ID Program yang sama di 2 baris beda, bakal keitung
  // dobel karena tab output-nya append-only per baris antrian, bukan per ID Program).
  // TARGET SHEET (2026-09-23, insiden salah sheet, RENAME sesuai permintaan user hari yang sama):
  // /exportprogramparent = sheet TETAP "Participant List - Ortu SMM" (5 Program Parent SMM:
  // 62354/68024/68562/69539/69671), sheet ini yang feed dashboard smm.product-sid.us/parent/
  // program - JANGAN diisi ID Program lain selain 5 itu. /exportprogram (nama pendek, DEFAULT)
  // = sheet umum/scratch buat program LAIN, aman diisi apapun.
  bot.onText(/^\/exportprogramparent(?:@\w+)?(?:\s+(\S+))?$/, async (msg) => {
    const chatId = msg.chat.id;
    const fromId = msg.from?.id;

    if (msg.chat.type !== 'private') {
      return bot.sendMessage(chatId, 'Command ini cuma bisa dipakai lewat chat pribadi (DM) ke bot, biar token gak ke-expose ke grup.');
    }
    if (!isSidCoreAllowedUser(fromId)) {
      return bot.sendMessage(chatId, 'Kamu belum diizinkan pakai command ini.');
    }
    if (isRunning(chatId)) {
      return bot.sendMessage(chatId, 'Masih ada proses SID Core lain yang jalan buat kamu, tunggu selesai dulu ya.');
    }

    const match = msg.text.match(/^\/\w+(?:@\w+)?\s+(\S+)/);
    const token = match?.[1];
    if (!token) {
      return bot.sendMessage(chatId, 'Kirim tokennya juga ya, format:\n/exportprogramparent <SID_CORE_TOKEN>\n\nKhusus 5 Program Parent SMM (feed dashboard smm.product-sid.us/parent/program) - jangan isi tab "Program" di sheet ini dengan ID program lain, pakai /exportprogram buat itu. Proses ini baca daftar ID Program dari tab "Program" (isi sendiri ID Program yang mau ditarik, kosongin kolom Status), lalu export peserta + nilai kuis/tugas tiap program ke tab lain. Program gede (ribuan peserta) bisa makan belasan menit - kalau token expired di tengah jalan, ambil token baru dan /exportprogramparent lagi (program yang udah Done otomatis di-skip).');
    }

    runningChats.add(chatId);
    try {
      await bot.sendMessage(chatId, 'Proses antrian tab "Program" (5 Program Parent SMM, peserta + nilai kuis/tugas per soal)... bisa makan waktu lumayan lama kalau programnya gede, sabar ya.');
      const { code, output } = await runScript('export-program-participation.js', token, false, [], 55 * 60 * 1000);
      await bot.sendMessage(chatId, truncate(output || '(kosong)'));
      await bot.sendMessage(chatId, code === 0 ? 'Selesai.' : 'Ada error, cek log di atas.');
    } finally {
      runningChats.delete(chatId);
    }
  });

  // /exportprogram (nama pendek, DEFAULT) - SAMA PERSIS logic-nya dengan /exportprogramparent,
  // TAPI target sheet BEDA (PROGRAM_PARTICIPATION_GENERAL_SHEET_ID, sheet umum/scratch - kosong
  // secara default, bebas diisi ID Program APAPUN di luar 5 Program Parent SMM). Dibuat
  // 2026-09-23 setelah kejadian ID Program lain kepasang ke sheet Parent SMM secara gak sengaja -
  // sekarang dipisah tegas supaya sheet yang feed dashboard smm.product-sid.us/parent/program
  // gak kesenggol lagi. GOTCHA PENTING: nama command ini SEBELUMNYA (hari yang sama) berarti
  // "5 Program Parent SMM" - user minta ditukar supaya /exportprogram (default, lebih pendek)
  // jadi yang buat program LAIN, bukan yang Parent SMM. Jangan bingung kalau baca log/history lama.
  bot.onText(/^\/exportprogram(?:@\w+)?(?:\s+(\S+))?$/, async (msg) => {
    const chatId = msg.chat.id;
    const fromId = msg.from?.id;

    if (msg.chat.type !== 'private') {
      return bot.sendMessage(chatId, 'Command ini cuma bisa dipakai lewat chat pribadi (DM) ke bot, biar token gak ke-expose ke grup.');
    }
    if (!isSidCoreAllowedUser(fromId)) {
      return bot.sendMessage(chatId, 'Kamu belum diizinkan pakai command ini.');
    }
    if (isRunning(chatId)) {
      return bot.sendMessage(chatId, 'Masih ada proses SID Core lain yang jalan buat kamu, tunggu selesai dulu ya.');
    }

    const match = msg.text.match(/^\/\w+(?:@\w+)?\s+(\S+)/);
    const token = match?.[1];
    if (!token) {
      return bot.sendMessage(chatId, 'Kirim tokennya juga ya, format:\n/exportprogram <SID_CORE_TOKEN>\n\nBuat program LAIN di luar 5 Program Parent SMM (yang itu pakai /exportprogramparent). Sheet-nya terpisah (umum/scratch, bebas diisi ID Program apapun) - isi tab "Program" di sheet itu, kosongin kolom Status, baru jalanin command ini.');
    }

    runningChats.add(chatId);
    try {
      await bot.sendMessage(chatId, 'Proses antrian tab "Program" di sheet UMUM (bukan Parent SMM), peserta + nilai kuis/tugas per soal... bisa makan waktu lumayan lama kalau programnya gede, sabar ya.');
      const { code, output } = await runScript('export-program-participation.js', token, false, ['--sheet=general'], 55 * 60 * 1000);
      await bot.sendMessage(chatId, truncate(output || '(kosong)'));
      await bot.sendMessage(chatId, code === 0 ? 'Selesai.' : 'Ada error, cek log di atas.');
    } finally {
      runningChats.delete(chatId);
    }
  });

  // /cekcicilan <token> [org_id] - audit paket belajar 1 organisasi: skema "Penuh atau Cicilan"
  // tapi opsi cicilannya "Tidak Aktif". Baca-saja, gak nulis ke sheet, laporan balik ke chat.
  // org_id default 5 (Sekolah Murid Merdeka / SMM pusat) kalau cuma token yang dikirim.
  // Token duluan (bukan org_id) biar konsisten sama command SID Core lain (semua "/cmd <token> ...").
  bot.onText(/^\/cekcicilan(?:@\w+)?\s+(\S+)(?:\s+(\d+))?\s*$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const fromId = msg.from?.id;

    if (msg.chat.type !== 'private') {
      return bot.sendMessage(chatId, 'Command ini cuma bisa dipakai lewat chat pribadi (DM) ke bot, biar token gak ke-expose ke grup.');
    }
    if (!isSidCoreAllowedUser(fromId)) {
      return bot.sendMessage(chatId, 'Kamu belum diizinkan pakai command ini.');
    }
    if (isRunning(chatId)) {
      return bot.sendMessage(chatId, 'Masih ada proses SID Core lain yang jalan buat kamu, tunggu selesai dulu ya.');
    }

    const token = match[1];
    const orgId = match[2] ? Number(match[2]) : 5;

    runningChats.add(chatId);
    try {
      await bot.sendMessage(chatId, `Cek cicilan tidak aktif buat organisasi ${orgId}...`);
      const { totalChecked, rows } = await cicilanAuditOrg(orgId, token);
      if (rows.length === 0) {
        await bot.sendMessage(chatId, `Selesai. ${totalChecked} paket dicek (skema Penuh atau Cicilan, status aktif), semua cicilannya aktif normal.`);
        return;
      }
      const lewat = rows.filter((r) => r.kondisi === 'lewat');
      const belum = rows.filter((r) => r.kondisi === 'belum');
      const lain = rows.filter((r) => r.kondisi === 'lain');
      let report = `*${totalChecked}* paket dicek, *${rows.length}* cicilan tidak aktif:\n`;
      report += `• Sudah lewat (window cicilan tutup): ${lewat.length}\n`;
      report += `• Belum mulai (window cicilan belum buka): ${belum.length}\n`;
      if (lain.length) report += `• Lainnya: ${lain.length}\n`;
      if (lewat.length) {
        report += `\n*Sudah lewat* (paling perlu perhatian):\n`;
        report += lewat.map((r) => `• [${r.packageId}] ${r.name} — ${fmtTgl(r.start)}–${fmtTgl(r.end)}`).join('\n');
      }
      if (belum.length) {
        report += `\n\n*Belum mulai*:\n`;
        report += belum.map((r) => `• [${r.packageId}] ${r.name} — ${fmtTgl(r.start)}–${fmtTgl(r.end)}`).join('\n');
      }
      await sendChunked(bot, chatId, report, { parse_mode: 'Markdown' });
    } catch (err) {
      await bot.sendMessage(chatId, `Gagal: ${err.message}`);
    } finally {
      runningChats.delete(chatId);
    }
  });
}

// Return true kalau pesan ini ke-handle sebagai balasan konfirmasi (caller harus return, jangan lanjut ke chat AI)
export async function handleSidCorePendingReply(bot, msg) {
  const chatId = msg.chat.id;
  const pending = sidCorePending.get(chatId);
  if (!pending) return false;

  if (Date.now() - pending.ts > PENDING_TTL_MS) {
    sidCorePending.delete(chatId);
    return false; // expired, biarin jatuh ke chat biasa
  }

  const text = (msg.text || '').trim().toLowerCase();
  if (['ya', 'yes', 'lanjut', 'eksekusi', 'confirm'].includes(text)) {
    sidCorePending.delete(chatId);
    runningChats.add(chatId);
    try {
      await bot.sendMessage(chatId, `Eksekusi ${pending.label} beneran...`);
      const { code, output } = await runScript(pending.script, pending.token, true);
      await bot.sendMessage(chatId, truncate(output || '(kosong)'));
      await bot.sendMessage(chatId, code === 0 ? 'Selesai.' : 'Selesai dengan error, cek log di atas.');
    } finally {
      runningChats.delete(chatId);
    }
    return true;
  }
  if (['batal', 'cancel', 'no', 'gajadi'].includes(text)) {
    sidCorePending.delete(chatId);
    await bot.sendMessage(chatId, 'Oke, dibatalin.');
    return true;
  }
  return false;
}
