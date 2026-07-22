// ─── SID Core Automation (resign-cleanup / create-roles) ─────────────────────
// Trigger script di ../sid-core-automation (di-mount read-only ke container).
// Cuma bisa dipakai lewat DM (private chat) + user yang ada di SID_CORE_ALLOWED_USER_IDS,
// biar SID_CORE_TOKEN gak ke-expose ke grup. Selalu dry-run dulu, baru minta konfirmasi
// eksplisit ("ya"/"batal") sebelum --execute.

import { spawn } from 'child_process';

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

function runScript(scriptName, token, execute, extraArgs = []) {
  return new Promise((resolve) => {
    const args = [scriptName, ...extraArgs];
    if (execute) args.push('--execute');
    const child = spawn('node', args, {
      cwd: AUTOMATION_DIR,
      env: { ...process.env, SID_CORE_TOKEN: token },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: -1, output: out + `\n[timeout, script dihentikan paksa setelah ${TIMEOUT_MS / 60000} menit]` });
    }, TIMEOUT_MS);
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

export function registerSidCoreCommands(bot, { isSidCoreAllowedUser }) {
  async function handleCommand(msg, scriptFile, label) {
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
    try {
      await bot.sendMessage(chatId, `Jalanin dry-run ${label}... (bisa beberapa menit kalau baris di sheet banyak, tunggu aja gak perlu kirim ulang)`);
      const { code, output } = await runScript(scriptFile, token, false);
      await bot.sendMessage(chatId, truncate(output || '(kosong)'));

      if (code !== 0) {
        return bot.sendMessage(chatId, 'Dry-run error, cek log di atas. Gak lanjut ke eksekusi.');
      }

      sidCorePending.set(chatId, { script: scriptFile, token, label, ts: Date.now() });
      await bot.sendMessage(chatId, `Itu hasil dry-run. Balas "ya" buat eksekusi beneran, atau "batal" buat cancel. (berlaku 10 menit)`);
    } finally {
      runningChats.delete(chatId);
    }
  }

  bot.onText(/^\/resign(?:@\w+)?(?:\s+(\S+))?$/, (msg) => handleCommand(msg, 'resign-cleanup.js', 'resign-cleanup'));
  bot.onText(/^\/role(?:@\w+)?(?:\s+(\S+))?$/, (msg) => handleCommand(msg, 'create-roles.js', 'create-roles'));
  bot.onText(/^\/updateuser(?:@\w+)?(?:\s+(\S+))?$/, (msg) => handleCommand(msg, 'update-user-data.js', 'update-user-data'));
  // update-user-role.js: Aksi "Tambah" full-support (dry-run + execute, resolve platform_role_id
  // dari role/platform/{id} per platform - lihat CLAUDE.md). Aksi "Hapus" tetap ditunda ("Ditunda"
  // di kolom Status) - endpoint hapus role yang benar belum ketemu.
  bot.onText(/^\/updaterole(?:@\w+)?(?:\s+(\S+))?$/, (msg) => handleCommand(msg, 'update-user-role.js', 'update-user-role'));
  // delete-program-participant.js: hapus user dari Program (learning-catalog service, beda dari
  // SID Core biasa). Dry-run nulis Completion % ke sheet dulu (informasi progress peserta) SEBELUM
  // minta konfirmasi "ya" - biar tim gak salah hapus peserta yang udah jauh progressnya.
  bot.onText(/^\/removeprogram(?:@\w+)?(?:\s+(\S+))?$/, (msg) => handleCommand(msg, 'delete-program-participant.js', 'remove-program-participant'));
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
