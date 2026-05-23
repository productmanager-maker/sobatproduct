import { google } from 'googleapis';
import fs from 'fs/promises';

const SPREADSHEET_ID = '16i2BL3IHoTUssg2mf8yjccfbQ6OtFaslwjWL8Rwt17k';
const DRIVE_FOLDER_ID = '1MvWq1Vz5oQN8N4JdaNsaoEW-_D74EXqN';
const PINNED_DOC_ID   = '1GinsltVQc_wyor9wkoy82Dmq_AeG6tOwHck0zVqS41E';
const CREDS_FILE = process.env.GOOGLE_CREDENTIALS_FILE || '/app/google-credentials.json';
const TZ = process.env.TIMEZONE || 'Asia/Jakarta';

export let sheetsReady = false;
let sheetsApi = null;
let driveApi = null;

const cache = {
  staff: [],
  staffHeaders: [],    // nama kolom Sheet Staff (untuk update cell)
  holidays: [],
  payday: [],
  driveFiles: [],
  driveMemories: [],   // { name, content } dari Google Docs
  lastRefresh: null,
};

// ── Init ────────────────────────────────────────────────────────────────────
export async function initGoogle() {
  try {
    const raw = await fs.readFile(CREDS_FILE, 'utf-8');
    const creds = JSON.parse(raw);
    if (!creds.client_email) throw new Error('credentials tidak valid');

    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive.readonly',
      ],
    });
    sheetsApi = google.sheets({ version: 'v4', auth });
    driveApi  = google.drive({ version: 'v3', auth });
    sheetsReady = true;
    console.log('[google] OK as', creds.client_email);
    await refreshAllData();
    return true;
  } catch (e) {
    console.warn('[google] init failed:', e.message);
    return false;
  }
}

// ── Fetch helpers ────────────────────────────────────────────────────────────
async function fetchRows(sheetName) {
  if (!sheetsApi) return [];
  try {
    const res = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: sheetName,
    });
    const rows = res.data.values || [];
    if (rows.length < 2) return [];
    const headers = rows[0].map(h => h.trim());
    console.log(`[sheets] ${sheetName} headers:`, headers.join(', '));
    return rows.slice(1)
      .map((r, i) => ({ r, sheetRow: i + 2 })) // sheetRow: header=1, data mulai baris 2
      .filter(({ r }) => r.some(c => c?.trim()))
      .map(({ r, sheetRow }) => {
        const obj = { _sheetRow: sheetRow };
        headers.forEach((h, j) => { obj[h] = (r[j] || '').trim(); });
        return obj;
      });
  } catch (e) {
    console.error('[sheets] fetchRows error:', sheetName, e.message);
    return [];
  }
}

async function listDriveFiles() {
  if (!driveApi) return [];
  try {
    const res = await driveApi.files.list({
      q: `'${DRIVE_FOLDER_ID}' in parents and trashed=false`,
      fields: 'files(id,name,mimeType,createdTime)',
      orderBy: 'createdTime desc',
      pageSize: 200,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });
    return res.data.files || [];
  } catch (e) {
    console.error('[drive] listFiles error:', e.message);
    return [];
  }
}

async function readDoc(fileId) {
  try {
    const res = await driveApi.files.export({ fileId, mimeType: 'text/plain', supportsAllDrives: true });
    return typeof res.data === 'string' ? res.data.slice(0, 4000) : '';
  } catch {
    return '';
  }
}

const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS || String(60 * 60 * 1000)); // default 1 jam

export async function refreshAllData(force = false) {
  const now = Date.now();
  if (!force && cache.lastRefresh && (now - cache.lastRefresh < CACHE_TTL_MS) && cache.staff.length) return;

  console.log('[cache] refreshing...');
  const [staff, holidays, payday, driveFiles] = await Promise.all([
    fetchRows('Staff'),
    fetchRows('Holiday'),
    fetchRows('Gajian'),
    listDriveFiles(),
  ]);

  cache.staff    = staff;
  cache.staffHeaders = staff.length ? Object.keys(staff[0]).filter(k => k !== '_sheetRow') : [];
  cache.holidays = holidays;
  cache.payday   = payday;
  cache.driveFiles = driveFiles;
  cache.lastRefresh = Date.now();

  // Baca pinned doc + Google Docs di Drive folder
  const folderDocs = driveFiles.filter(f => f.mimeType === 'application/vnd.google-apps.document').slice(0, 7);
  const [pinnedContent, ...folderContents] = await Promise.all([
    readDoc(PINNED_DOC_ID),
    ...folderDocs.map(f => readDoc(f.id)),
  ]);

  const memories = [];
  if (pinnedContent) memories.push({ name: 'Konteks Tim', date: null, content: pinnedContent });
  folderDocs.forEach((f, i) => {
    if (folderContents[i]) memories.push({ name: f.name, date: f.createdTime?.slice(0, 10), content: folderContents[i] });
  });
  cache.driveMemories = memories;

  console.log('[cache] done —', {
    staff: cache.staff.length,
    holidays: cache.holidays.length,
    payday: cache.payday.length,
    driveFiles: cache.driveFiles.length,
    driveMemories: cache.driveMemories.length,
  });
}

// ── Sheet write helpers ──────────────────────────────────────────────────────
function colToLetter(idx) { // 0-based
  let result = '';
  let n = idx + 1;
  while (n > 0) {
    result = String.fromCharCode(65 + ((n - 1) % 26)) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

export async function updateTelegramUsername(namaPanggilan, username) {
  if (!sheetsApi) return false;
  const clean = username.replace(/^@/, '');
  const staff = cache.staff.find(s => {
    const nick = getField(s, 'Nama Panggilan', 'panggilan', 'nickname', 'Employee Name', 'Nama', 'name');
    return nick.toLowerCase().trim() === namaPanggilan.toLowerCase().trim();
  });
  if (!staff?._sheetRow) return false;

  const colIdx = cache.staffHeaders.indexOf('Username Telegram');
  if (colIdx === -1) return false;

  const range = `Staff!${colToLetter(colIdx)}${staff._sheetRow}`;
  try {
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range,
      valueInputOption: 'RAW',
      requestBody: { values: [[clean]] },
    });
    staff['Username Telegram'] = clean;
    console.log(`[sheets] auto-link @${clean} → ${namaPanggilan} (${range})`);
    return true;
  } catch (e) {
    console.error('[sheets] updateTelegramUsername error:', e.message);
    return false;
  }
}

// ── Flexible field getter ────────────────────────────────────────────────────
export function getField(obj, ...keys) {
  if (!obj) return '';
  for (const key of keys) {
    for (const [k, v] of Object.entries(obj)) {
      if (k.toLowerCase().trim() === key.toLowerCase().trim() && v) return v;
    }
  }
  return '';
}

// ── Date helpers ─────────────────────────────────────────────────────────────

/**
 * Kembalikan { year, month, day, weekday } berdasarkan timezone TZ (WIB).
 * Menggunakan Intl.DateTimeFormat agar selalu akurat, tidak bergantung
 * pada timezone sistem server.
 */
function todayTz() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // en-CA format: "YYYY-MM-DD"
  const parts = fmt.formatToParts(new Date());
  const get = type => parseInt(parts.find(p => p.type === type)?.value || '0');
  return { year: get('year'), month: get('month'), day: get('day') };
}

/**
 * Kembalikan { year, month, day } untuk hari besok dalam TZ.
 */
function tomorrowTz() {
  const now = new Date();
  now.setDate(now.getDate() + 1);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(now);
  const get = type => parseInt(parts.find(p => p.type === type)?.value || '0');
  return { year: get('year'), month: get('month'), day: get('day') };
}

/**
 * Tahun sekarang dalam TZ.
 */
function yearTz() {
  return todayTz().year;
}

/**
 * Parse string tanggal dari sheet menjadi { year, month, day }.
 * Format yang didukung:
 *   - YYYY-MM-DD  (format sheet Holiday & Gajian)
 *   - DD/MM/YYYY  atau  DD-MM-YYYY
 *   - DD/MM       (ulang tahun tanpa tahun)
 */
function parseDate(str) {
  if (!str) return null;

  // YYYY-MM-DD
  let m = str.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (m) return { year: parseInt(m[1]), month: parseInt(m[2]), day: parseInt(m[3]) };

  // DD/MM/YYYY  atau  DD-MM-YYYY
  m = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m) return { year: parseInt(m[3]), month: parseInt(m[2]), day: parseInt(m[1]) };

  // DD/MM  atau  DD-MM  (tanpa tahun — untuk birthday)
  m = str.match(/^(\d{1,2})[\/\-](\d{1,2})$/);
  if (m) return { year: null, month: parseInt(m[2]), day: parseInt(m[1]) };

  return null;
}

/**
 * Cek apakah dateStr cocok dengan { year, month, day } target.
 * Kalau year di dateStr null (birthday tanpa tahun), hanya cocokkan month+day.
 * Kalau year di target null, juga hanya cocokkan month+day.
 */
function matchesDate(dateStr, target, ignoreYear = false) {
  const pd = parseDate(dateStr);
  if (!pd) return false;
  if (!pd.month || !pd.day) return false;

  const monthOk = pd.month === target.month;
  const dayOk   = pd.day   === target.day;

  // Birthday / anniversary: tahun di data bisa ada atau tidak, selalu ignore year
  if (ignoreYear || pd.year === null) return monthOk && dayOk;

  // Holiday / Gajian: harus cocok tahun juga
  return pd.year === target.year && monthOk && dayOk;
}

// ── Public data accessors ────────────────────────────────────────────────────
export function getTodayBirthdays() {
  const today = todayTz();
  return cache.staff.filter(s => {
    const d = getField(s, 'Birth Date', 'Tgl Lahir', 'Tanggal Lahir', 'Birthday', 'birth_date', 'lahir', 'DOB');
    return d && matchesDate(d, today, true); // ignore year → cukup month+day
  });
}

export function getTodayAnniversaries() {
  const today = todayTz();
  return cache.staff.filter(s => {
    const d = getField(s, 'Join Date', 'Tgl Work Anniv', 'Work Anniversary', 'Tgl Bergabung', 'Mulai Kerja', 'anniv', 'anniversary');
    return d && matchesDate(d, today, true); // ignore year → cukup month+day
  });
}

export function getAnnivYears(staff) {
  const d = getField(staff, 'Tgl Work Anniv', 'Work Anniversary', 'Join Date', 'Tgl Bergabung', 'Mulai Kerja', 'anniv', 'anniversary');
  const pd = parseDate(d);
  if (!pd?.year) return null;
  return yearTz() - pd.year;
}

export function getTodayHoliday() {
  const today = todayTz();
  for (const row of cache.holidays) {
    const d = getField(row, 'Tanggal', 'Date', 'date', 'tanggal', 'Tgl');
    if (!d) continue;
    if (matchesDate(d, today)) {
      return getField(row, 'Nama Hari Libur', 'Holiday', 'Keterangan', 'nama', 'name', 'Nama') || d;
    }
  }
  return null;
}

export function getHolidayType(holidayName) {
  if (!holidayName) return 'umum';
  const n = holidayName.toLowerCase();
  if (n.includes('natal') || n.includes('yesus') || n.includes('kenaikan') || n.includes('paskah') || n.includes('pentakosta')) return 'kristen';
  if (n.includes('idul') || n.includes('maulid') || n.includes('isra') || n.includes('islam') || n.includes('ramadan') || n.includes('hijriah')) return 'islam';
  if (n.includes('nyepi') || n.includes('hindu') || n.includes('kuningan') || n.includes('galungan')) return 'hindu';
  if (n.includes('waisak') || n.includes('buddha') || n.includes('budha')) return 'buddha';
  if (n.includes('imlek') || n.includes('kong') || n.includes('sincia')) return 'konghucu';
  return 'umum';
}

export function isPaydayToday() {
  const today = todayTz();
  return cache.payday.some(row => {
    const d = getField(row, 'Tanggal', 'Date', 'tanggal', 'date', 'Tgl');
    return d && matchesDate(d, today);
  });
}

export function isPaydayTomorrow() {
  const tomorrow = tomorrowTz();
  return cache.payday.some(row => {
    const d = getField(row, 'Tanggal', 'Date', 'tanggal', 'date', 'Tgl');
    return d && matchesDate(d, tomorrow);
  });
}

export function getActiveStaff() {
  return cache.staff.filter(s => {
    const status = getField(s, 'Status', 'status', 'Active', 'Aktif');
    if (!status) return true;
    const lower = status.toLowerCase();
    return lower === 'active' || lower === 'aktif' || lower === 'yes' || lower === 'ya' || lower === '1';
  });
}

export function getRandomStaff() {
  const active = getActiveStaff();
  if (!active.length) return null;
  return active[Math.floor(Math.random() * active.length)];
}

export function getAllStaff() {
  return cache.staff;
}

export function formatStaffContext(staff) {
  if (!staff) return '';
  const nick    = getField(staff, 'Nama Panggilan', 'panggilan', 'nickname', 'Employee Name', 'Nama', 'name');
  const gender  = getField(staff, 'Gender', 'gender', 'Jenis Kelamin');
  const tg      = getField(staff, 'Username Telegram', 'telegram', 'Telegram', '@username');
  const funFact = getField(staff, 'Fun Fact', 'fun_fact', 'Fakta Unik', 'fact');
  const role    = getField(staff, 'Role', 'Jabatan', 'Position', 'role', 'jabatan');

  const sapaan = gender.toLowerCase().startsWith('f') || gender.toLowerCase().startsWith('p') ? 'Sis' : 'Bro';
  const mention = tg ? `@${tg.replace(/^@/, '')}` : nick;

  return [
    `Nama panggilan: ${nick}`,
    `Sapaan: ${sapaan}`,
    tg ? `Telegram: @${tg.replace(/^@/, '')}` : '',
    role ? `Role: ${role}` : '',
    funFact ? `Fun fact: ${funFact}` : '',
  ].filter(Boolean).join('\n');
}

// Context string untuk Drive memories (untuk dimasukkan ke prompt Claude)
export function getDriveContext() {
  const lines = [];

  if (cache.driveFiles.length) {
    lines.push('## File & Kenangan Tim di Drive');
    const byYear = {};
    for (const f of cache.driveFiles) {
      const year = f.createdTime?.slice(0, 4) || 'unknown';
      if (!byYear[year]) byYear[year] = [];
      byYear[year].push(f.name);
    }
    for (const [year, names] of Object.entries(byYear).sort().reverse()) {
      lines.push(`\n${year}:`);
      names.slice(0, 10).forEach(n => lines.push(`  - ${n}`));
    }
  }

  if (cache.driveMemories.length) {
    lines.push('\n## Ringkasan Dokumen Tim');
    for (const m of cache.driveMemories.slice(0, 3)) {
      lines.push(`\n### ${m.name}`);
      lines.push(m.content.slice(0, 600));
    }
  }

  return lines.join('\n');
}

// ── Agama-based filter ────────────────────────────────────────────────────────
const AGAMA_MAP = {
  islam:    ['islam', 'muslim'],
  kristen:  ['kristen', 'kristen protestan', 'protestan', 'kristen katolik', 'katolik'],
  hindu:    ['hindu'],
  buddha:   ['buddha', 'budha', 'buddhist'],
  konghucu: ['konghucu', 'kong hu cu', 'confucius'],
};

export function getStaffByAgama(holidayType) {
  const targets = AGAMA_MAP[holidayType?.toLowerCase()] || [];
  if (!targets.length) return [];
  return cache.staff.filter(s => {
    const agama = getField(s, 'Agama', 'agama', 'Religion', 'religion', 'Agama/Keyakinan').toLowerCase().trim();
    return targets.some(t => agama.includes(t));
  });
}
