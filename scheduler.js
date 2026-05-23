import {
  sheetsReady,
  refreshAllData,
  getTodayBirthdays,
  getTodayAnniversaries,
  getAnnivYears,
  getTodayHoliday,
  getHolidayType,
  isPaydayToday,
  isPaydayTomorrow,
  getRandomStaff,
  getAllStaff,
  getField,
  formatStaffContext,
  getDriveContext,
  getStaffByAgama,
} from './sheets.js';


export const SCHEDULE_GROUP_IDS = process.env.ALLOWED_GROUP_IDS
  ?.split(',').map(Number).filter(Boolean) || [];

const TIMEZONE = process.env.TIMEZONE || 'Asia/Jakarta';
const MODEL    = process.env.MODEL || 'claude-sonnet-4-6';

const firedToday = new Map();

// ── Waktu ─────────────────────────────────────────────────────────────────────
function nowTzParts() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
    weekday: 'short',
  });
  const parts = fmt.formatToParts(new Date());
  const get = type => parts.find(p => p.type === type)?.value || '';
  return {
    year: parseInt(get('year')), month: parseInt(get('month')), day: parseInt(get('day')),
    hour: get('hour'), minute: get('minute'), weekday: get('weekday'),
  };
}
function todayKey() {
  const p = nowTzParts();
  return `${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`;
}
function weekdayEN() { return nowTzParts().weekday; }
function weekdayID() {
  return new Intl.DateTimeFormat('id-ID', { timeZone: TIMEZONE, weekday: 'long' }).format(new Date());
}
function dateID() {
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: TIMEZONE, day: 'numeric', month: 'long', year: 'numeric'
  }).format(new Date());
}
function isWeekend() { const d = weekdayEN(); return d === 'Sat' || d === 'Sun'; }
function ctxNow() { return { day: weekdayEN(), dayID: weekdayID(), date: dateID() }; }

// ── Generate via Claude ────────────────────────────────────────────────────────
async function generate(prompt, client, maxTokens = 600) {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system: `Lo adalah Sobat Product, AI companion tim Product SID di Sekolah.mu. Lo tinggal di grup Telegram mereka. Gaya: casual Jakarta, lo/gue, hangat, bisa ngelucu. Jangan terlalu banyak emoji. Jawab langsung sesuai format yang diminta, tanpa meta-commentary atau preamble.`,
    messages: [{ role: 'user', content: prompt }],
  });
  return res.content.find(b => b.type === 'text')?.text?.trim() || '';
}

// ── Broadcast helpers ─────────────────────────────────────────────────────────
async function broadcast(bot, text, opts = {}) {
  for (const groupId of SCHEDULE_GROUP_IDS) {
    await bot.sendMessage(groupId, text, { parse_mode: 'Markdown', ...opts })
      .catch(e => console.error(`[scheduler] send error ${groupId}:`, e.message));
  }
}


// ── Rotating content (11:00) ──────────────────────────────────────────────────
const MORNING_ROTATION = {
  Mon: ['motivasi_senin', 'quote_harian'],
  Tue: ['tebak_orang',    'tebak_tebakan'],
  Wed: ['gas_bahas',      'trending_indo'],
  Thu: ['shoutout',       'fun_fact_tim'],
  Fri: ['jokes',          'quote_harian'],
};

function promptMotivasiSenin(ctx) {
  return `Buat pesan pembuka Senin pagi untuk tim Product SID.
Gaya: casual lo/gue, acknowledge Senin dengan humor ringan, kasih semangat yang genuine.
Sertakan 1 kutipan inspiratif atau wisdom singkat yang relevan.

Format:
"Halo gengs! Selamat Senin...

[Konten — 3-4 kalimat, casual]

*Quote hari ini:* _[kutipan]_ — [sumber]"

Hari ini: ${ctx.date}, ${ctx.dayID}.`;
}

function promptTebakTebakan(ctx) {
  return `Buat satu tebak-tebakan yang relate ke dunia kerja, tech, atau product.
Harus sedikit lucu, ada twist, bisa dijawab.

Format wajib:
"Halo gengs! Semoga harimu menyenangkan!

*Tebak-tebakan!*
[Soal]

Jawaban: [Jawaban]"

Hari ini: ${ctx.date}, ${ctx.dayID}.`;
}

function promptTebakOrang(ctx) {
  const staff = getAllStaff().filter(s =>
    getField(s, 'Fun Fact', 'fun_fact', 'Fakta Unik', 'fact') ||
    getField(s, 'Role', 'Jabatan', 'Position', 'role', 'jabatan')
  );
  if (!staff.length) return promptTebakTebakan(ctx);

  const pick   = staff[Math.floor(Math.random() * staff.length)];
  const nick   = getField(pick, 'Nama Panggilan', 'panggilan', 'nickname', 'Employee Name', 'Nama', 'name');
  const role   = getField(pick, 'Role', 'Jabatan', 'Position', 'role', 'jabatan');
  const fact   = getField(pick, 'Fun Fact', 'fun_fact', 'Fakta Unik', 'fact');
  const join   = getField(pick, 'Join Date', 'Tgl Work Anniv', 'Work Anniversary', 'Tgl Bergabung', 'Mulai Kerja', 'anniv');
  const bday   = getField(pick, 'Birth Date', 'Tgl Lahir', 'Tanggal Lahir', 'Birthday', 'birth_date', 'lahir', 'DOB');
  const gender = getField(pick, 'Gender', 'gender', 'Jenis Kelamin');
  const sapaan = gender.toLowerCase().startsWith('f') || gender.toLowerCase().startsWith('p') ? 'Sis' : 'Bro';

  const clues = [];
  if (sapaan) clues.push(`Dia seorang ${sapaan}.`);
  if (role)   clues.push(`Role: ${role}.`);
  if (join) { const y = join.match(/\d{4}/)?.[0]; if (y) clues.push(`Bergabung tahun ${y}.`); }
  if (bday) {
    const months = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
    const m = bday.match(/(\d{1,2})[\/\-](\d{1,2})/);
    if (m) { const mo = months[parseInt(m[2]) - 1]; if (mo) clues.push(`Lahir bulan ${mo}.`); }
  }
  if (fact) clues.push(`Fun fact: ${fact}`);

  const clueText = clues.slice(0, 4).map((c, i) => `${i + 1}. ${c}`).join('\n');
  return `Buat post tebak-tebakan anggota tim dengan format ini persis:

"Halo gengs!

*Siapakah orang ini?*

${clueText}

Siapa coba? Tebak di kolom reply! Jawaban di bawah
.
.
.
*Jawabannya: ${nick}!* [Tambah 1 kalimat pujian warm untuk ${nick}.]"

Hari ini: ${ctx.date}, ${ctx.dayID}.`;
}

function promptFunFactTim(ctx) {
  const staff = getRandomStaff();
  if (!staff) return promptTebakTebakan(ctx);
  const nick    = getField(staff, 'Nama Panggilan', 'panggilan', 'nickname', 'Nama', 'name');
  const tg      = getField(staff, 'Username Telegram', 'telegram', 'Telegram', '@username');
  const funFact = getField(staff, 'Fun Fact', 'fun_fact', 'Fakta Unik', 'fact');
  const mention = tg ? `@${tg.replace(/^@/, '')}` : nick;
  if (!funFact) return promptTebakTebakan(ctx);
  return `Buat post "Fun Fact Member" untuk grup tim Product SID tentang ${nick} ${mention}.
Fun fact: "${funFact}"

Format:
"Halo gengs!

*Fun Fact Member Hari Ini*
Kalian tau ga, ternyata *${nick}* itu...

[Kembangkan fun fact jadi cerita singkat relatable, 2-3 kalimat, boleh lucu tapi tidak menyerang.]"

Hari ini: ${ctx.date}, ${ctx.dayID}.`;
}

function promptGasBasah(ctx) {
  const driveCtx = getDriveContext();
  return `Buat post diskusi singkat untuk tim Product SID.
Pilih topik: cara kerja, product thinking, AI, startup, atau hal-hal sehari-hari product team.
${driveCtx ? `Konteks tim (opsional): ${driveCtx.slice(0, 300)}` : ''}

Format:
"Halo gengs!

*Gas bahas: [Topik singkat]*

[1-2 kalimat konteks]

[1 pertanyaan pemantik, open-ended, bikin orang mau reply]"

Hari ini: ${ctx.date}, ${ctx.dayID}.`;
}

function promptTrendingIndo(ctx) {
  return `Buat post trivia singkat tentang situasi terkini Indonesia yang menarik untuk tim product.
Topik: kebijakan Prabowo, MBG, ekonomi digital, startup, teknologi Indonesia.
Tone: informatif tapi santai, bukan berita formal.

Format:
"Halo gengs!

*Update Sekilas*

[2-3 kalimat ringkasan]

[1 sudut pandang dari perspektif product/digital]"

Hari ini: ${ctx.date}, ${ctx.dayID}.`;
}

function promptShoutout(ctx) {
  const staff = getRandomStaff();
  if (!staff) return promptFunFactTim(ctx);
  const ctx2 = formatStaffContext(staff);
  return `Buat Random Shoutout untuk anggota tim Product SID ini:
${ctx2}

Format:
"Halo gengs! Random Shoutout hari ini jatuh ke... *[Nama]* [mention kalau ada]!

[2-3 kalimat pujian personal, warm, sedikit lucu. Pakai fun fact kalau ada. Tidak lebay.]

Yuk acungin jempol buat [Nama]!"

Hari ini: ${ctx.date}, ${ctx.dayID}.`;
}

function promptJokes(ctx) {
  return `Buat satu lelucon singkat yang relate dengan kehidupan tim product/developer/startup.
Natural, tidak cringe, ada punchline jelas, tidak menyerang personal.

Format:
"Halo gengs!

[Leluconnya — setup + punchline atau cerita lucu singkat]

[komentar singkat yang relate]"

Hari ini: ${ctx.date}, ${ctx.dayID}.`;
}

function promptQuoteHarian(ctx) {
  return `Buat post quote untuk tim Product SID.
Pilih dari: Hadis/Al-Quran (kalau relevan), tokoh Indonesia, tokoh dunia, atau prinsip product management.
Tone: inspiring tapi tidak ceramah.

Format:
"Halo gengs!

*[Tema quote singkat]*

_"[Quote]"_
— [Sumber]

[1-2 kalimat refleksi singkat, relate ke kerja]"

Hari ini: ${ctx.date}, ${ctx.dayID}.`;
}

// ── 07:00 ─────────────────────────────────────────────────────────────────────
function promptHolidayWithMentions(holiday, agamaStaff) {
  const type = getHolidayType(holiday);
  const toneMap = {
    islam:    'Tone relate ke umat Islam, boleh ucapan khas. Tim juga ada yang non-Muslim, tetap inklusif.',
    kristen:  'Tone relate ke umat Kristen. Tetap inklusif.',
    hindu:    'Tone relate ke umat Hindu. Tetap inklusif.',
    buddha:   'Tone relate ke umat Buddha. Tetap inklusif.',
    konghucu: 'Bisa sedikit meriah. Tetap inklusif.',
    umum:     'Tone umum, untuk semua.',
  };

  const mentions = agamaStaff.map(s => {
    const tg   = getField(s, 'Username Telegram', 'telegram', 'Telegram', '@username');
    const nick = getField(s, 'Nama Panggilan', 'panggilan', 'nickname', 'Employee Name', 'Nama', 'name');
    return tg ? `@${tg.replace(/^@/, '')}` : nick;
  }).filter(Boolean);

  const mentionLine = mentions.length
    ? `\nSebutkan nama-nama ini secara personal dalam pesan: ${mentions.join(', ')}`
    : '';

  return `Buat pesan selamat hari libur "${holiday}" untuk grup tim Product SID.
${toneMap[type] || toneMap.umum}${mentionLine}

Isi: ucapan selamat, ingatkan healing & istirahat beneran, reminder kerja jangan kelewatan (tidak menggurui).
Format: casual lo/gue, 3-5 kalimat. Hari ini: ${dateID()}.`;
}

function promptPayday07() {
  return `Buat pesan pagi hari gajian untuk tim Product SID.
Tone: seru, celebrate momen, santai. Ingatkan: nabung dulu, boleh traktir diri sendiri yang wajar.
Sertakan 1 kalimat lucu tentang momen gajian.
Format: casual lo/gue, 3-4 kalimat. Hari ini: ${dateID()}.`;
}

function promptBirthday(staff) {
  const nick    = getField(staff, 'Nama Panggilan', 'panggilan', 'nickname', 'Nama', 'name');
  const tg      = getField(staff, 'Username Telegram', 'telegram', 'Telegram', '@username');
  const funFact = getField(staff, 'Fun Fact', 'fun_fact', 'Fakta Unik', 'fact');
  const mention = tg ? `@${tg.replace(/^@/, '')}` : nick;
  return `Buat pesan ucapan ulang tahun untuk ${mention} di grup tim Product SID.
${funFact ? `Fun fact: "${funFact}"` : ''}
Tone: hangat, personal, sedikit lucu. Boleh pakai fun fact.
Format: mulai "Ultah, *${nick}*! ${mention}" lalu 2-3 kalimat. Hari ini: ${dateID()}.`;
}

function promptAnniversary(staff) {
  const nick  = getField(staff, 'Nama Panggilan', 'panggilan', 'nickname', 'Nama', 'name');
  const tg    = getField(staff, 'Username Telegram', 'telegram', 'Telegram', '@username');
  const years = getAnnivYears(staff);
  const mention = tg ? `@${tg.replace(/^@/, '')}` : nick;
  return `Buat pesan work anniversary untuk ${mention} di grup tim Product SID.
${years ? `Ini tahun ke-${years} mereka di tim.` : ''}
Tone: hangat, apresiatif, sedikit nostalgik.
Format: mulai "*${nick}* ${mention}" lalu 2-3 kalimat anniversary. Hari ini: ${dateID()}.`;
}

async function fire07(bot, client) {
  const holiday       = getTodayHoliday();
  const payday        = isPaydayToday();
  const birthdays     = getTodayBirthdays();
  const anniversaries = getTodayAnniversaries();

  if (holiday) {
    const holidayType = getHolidayType(holiday);
    const agamaStaff  = holidayType !== 'umum' ? getStaffByAgama(holidayType) : [];
    const text = await generate(promptHolidayWithMentions(holiday, agamaStaff), client);
    if (text) await broadcast(bot, text);
    console.log(`[scheduler 07:00] holiday: ${holiday}, agama mentions: ${agamaStaff.length}`);
  }

  if (payday) {
    const text = await generate(promptPayday07(), client);
    if (text) await broadcast(bot, text);
    console.log(`[scheduler 07:00] payday`);
  }

  for (const s of birthdays) {
    const nick = getField(s, 'Nama Panggilan', 'panggilan', 'nickname', 'Nama', 'name');
    const text = await generate(promptBirthday(s), client);
    if (text) await broadcast(bot, text);
    console.log(`[scheduler 07:00] birthday: ${nick}`);
  }

  for (const s of anniversaries) {
    const nick  = getField(s, 'Nama Panggilan', 'panggilan', 'nickname', 'Nama', 'name');
    const years = getAnnivYears(s);
    const text = await generate(promptAnniversary(s), client);
    if (text) await broadcast(bot, text);
    console.log(`[scheduler 07:00] anniversary: ${nick}`);
  }

  if (!holiday && !payday && !birthdays.length && !anniversaries.length) {
    console.log(`[scheduler 07:00] nothing to send`);
  }
}

// ── 11:00 — rotating ──────────────────────────────────────────────────────────
async function fireRotating(bot, client, slot) {
  if (isWeekend()) return;

  const ctx     = ctxNow();
  const holiday = getTodayHoliday();

  if (holiday) {
    console.log(`[scheduler ${slot}] holiday day, skip`);
    return;
  }

  const types = MORNING_ROTATION[ctx.day] || ['jokes'];
  const type  = types[Math.floor(Math.random() * types.length)];

  const promptMap = {
    motivasi_senin: () => promptMotivasiSenin(ctx),
    tebak_orang:    () => promptTebakOrang(ctx),
    tebak_tebakan:  () => promptTebakTebakan(ctx),
    fun_fact_tim:   () => promptFunFactTim(ctx),
    gas_bahas:      () => promptGasBasah(ctx),
    trending_indo:  () => promptTrendingIndo(ctx),
    shoutout:       () => promptShoutout(ctx),
    jokes:          () => promptJokes(ctx),
    quote_harian:   () => promptQuoteHarian(ctx),
  };

  let text = await generate((promptMap[type] || promptMap.jokes)(), client);

  if (slot === '11:00' && isPaydayTomorrow() && text) {
    const reminder = await generate(
      `Buat 1-2 kalimat reminder singkat bahwa besok gajian. Tone: seru, casual lo/gue. Hari ini: ${ctx.date}.`,
      client, 120
    );
    if (reminder) text += `\n\n---\n${reminder}`;
  }

  if (!text) return;
  await broadcast(bot, text);
  console.log(`[scheduler ${slot}] type: ${type} — ${ctx.date}`);
}

// ── 17:00 ─────────────────────────────────────────────────────────────────────
function promptSoreMotivasional(ctx) {
  const isFriday = weekdayEN() === 'Fri';
  return `Buat pesan sore jam 17:00 untuk tim Product SID.${isFriday ? ' Hari ini Jumat.' : ''}
${isPaydayToday() ? 'Bonus: hari ini gajian!' : ''}

Tone wajib: casual lo/gue, santai kayak ngobrol di kantor. BUKAN motivasi ceramah.

Yang harus ada (dalam 1 paragraf, 4-5 kalimat):
1. "Udah jam 5 nih" — acknowledge waktu pulang dengan santai
2. Waktunya beres-beres laptop / log off
3. Ingatkan istirahat — dinner bareng orang tersayang, quality time${isFriday ? ', nikmatin weekend' : ''}
4. 1 kalimat humble tentang impact kerja mereka ke guru dan siswa (bukan ceramah, bukan slogan)
5. Penutup santai: "Besok kita gas lagi" atau serupa${isFriday ? ' (atau "Senin kita gas lagi")' : ''}

Tidak perlu banyak emoji. Jangan lebay. Hari ini: ${ctx.date}, ${ctx.dayID}.`;
}

async function fire17(bot, client) {
  if (isWeekend()) return;

  const ctx     = ctxNow();
  const holiday = getTodayHoliday();

  const prompt = holiday
    ? `Buat pesan sore singkat untuk hari libur "${holiday}". Casual lo/gue, 2-3 kalimat. Ingatkan istirahat beneran. Hari ini: ${ctx.date}.`
    : promptSoreMotivasional(ctx);

  const text = await generate(prompt, client);
  if (!text) return;
  await broadcast(bot, text);
  console.log(`[scheduler 17:00] fired — ${ctx.date}`);
}

// ── Exports ───────────────────────────────────────────────────────────────────
export async function testFire07(bot, client) {
  if (typeof bot === 'undefined' || typeof client === 'undefined') return;
  await fire07(bot, client);
}
export async function testFire11(bot, client) {
  if (typeof bot === 'undefined' || typeof client === 'undefined') return;
  await fireRotating(bot, client, '11:00');
}
export async function testFire15(bot, client) {
  if (typeof bot === 'undefined' || typeof client === 'undefined') return;
  await fireRotating(bot, client, '15:00');
}
export async function testFire17(bot, client) {
  if (typeof bot === 'undefined' || typeof client === 'undefined') return;
  await fire17(bot, client);
}

export function initScheduler(bot, client) {
  if (SCHEDULE_GROUP_IDS.length === 0) {
    console.log('[scheduler] ALLOWED_GROUP_IDS not set — disabled');
    return;
  }

  const SLOTS = {
    '07:00': (b, c) => fire07(b, c),
    '11:00': (b, c) => fireRotating(b, c, '11:00'),
    '15:00': (b, c) => fireRotating(b, c, '15:00'),
    '17:00': (b, c) => fire17(b, c),
  };

  console.log('[scheduler] Active — groups:', SCHEDULE_GROUP_IDS, '| slots: 07:00, 11:00, 15:00, 17:00 | TZ:', TIMEZONE);

  setInterval(async () => {
    const { hour: h, minute: m } = nowTzParts();
    const slot    = `${h}:${m}`;
    const today   = todayKey();
    const fireKey = `${slot}:${today}`;

    if (!SLOTS[slot] || firedToday.has(fireKey)) return;

    firedToday.set(fireKey, true);
    for (const [k] of firedToday) {
      if (!k.endsWith(`:${today}`)) firedToday.delete(k);
    }

    if (sheetsReady) await refreshAllData().catch(() => {});
    await SLOTS[slot](bot, client).catch(e =>
      console.error(`[scheduler] Error slot ${slot}:`, e.message)
    );
  }, 60 * 1000);
}
