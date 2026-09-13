/**
 * Warungin â€” Bot WhatsApp interaktif (menu & order)
 * Library: @whiskeysockets/baileys (open-source, tidak butuh API resmi berbayar)
 *
 * CATATAN PENTING:
 * - Ini menghubungkan NOMOR WHATSAPP PRIBADI/BISNIS kamu lewat scan QR,
 *   sama seperti membuka WhatsApp Web.
 * - Baileys adalah library tidak resmi. Gunakan wajar (jangan kirim broadcast
 *   massal ke banyak nomor asing) supaya nomor tidak diblokir WhatsApp.
 * - Untuk 24 jam nonstop, jalankan file ini di server yang menyala terus
 *   (VPS) memakai PM2 â€” lihat README.md.
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const { createClient } = require('@supabase/supabase-js');
const readline = require('readline');

// ---------- 0. Koneksi Supabase ----------
const SUPABASE_URL = 'https://zwqwomfrgtqyaiiugryg.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp3cXdvbWZyZ3RxeWFpaXVncnlnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkyMDUzODAsImV4cCI6MjEwNDc4MTM4MH0.Zs2egViPPVec5OeAUgCI0-nUG1ABCDi2fyhVTvHNmao';
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Helper untuk bertanya lewat terminal (dipakai untuk pilih metode login)
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const tanya = (teks) => new Promise((resolve) => rl.question(teks, resolve));

// ---------- 1. Konfigurasi menu & pesan bot ----------
// Menu default dipakai kalau tabel Supabase kosong / belum bisa diakses.
let MENU = [
  { id: 1, nama: 'Nasi Goreng', harga: 18000 },
  { id: 2, nama: 'Mie Ayam', harga: 15000 },
  { id: 3, nama: 'Es Teh', harga: 5000 },
];

// Ambil menu terbaru dari Supabase (dipanggil saat bot mulai)
async function muatMenuDariSupabase() {
  const { data, error } = await sb
    .from('menu')
    .select('id, nama, harga')
    .order('urutan', { ascending: true });

  if (error) {
    console.log('Gagal ambil menu dari Supabase, pakai menu default:', error.message);
    return;
  }
  if (data && data.length > 0) {
    MENU = data;
    console.log(`Menu dimuat dari Supabase (${data.length} item)`);
  }
}

const PESAN_SAPAAN =
  'Halo! Warung kami buka 24 jam via chat ðŸ™‚\nKetik *menu* untuk lihat pilihan.';

function teksMenu() {
  const daftar = MENU.map(
    (m) => `${m.id}. ${m.nama} â€” ${(m.harga / 1000).toFixed(0)}rb`
  ).join('\n');
  return `Menu hari ini:\n${daftar}\n\nBalas dengan angka pilihanmu (pisahkan spasi kalau lebih dari satu, mis. "1 3")`;
}

// ---------- 2. Simpan status obrolan tiap pelanggan (in-memory) ----------
// Untuk pemakaian nyata / banyak pelanggan sekaligus, ganti Map ini
// dengan database (mis. SQLite/Postgres) supaya tidak hilang saat restart.
const sesi = new Map();
// sesi.get(nomor) -> { tahap: 'awal'|'pilih_menu'|'alamat', keranjang: [] }

function sesiBaru() {
  return { tahap: 'awal', keranjang: [] };
}

function totalKeranjang(keranjang) {
  return keranjang.reduce((sum, item) => sum + item.harga, 0);
}

// ---------- 3. Logika balasan bot ----------
async function prosesPesan(nomor, teksMasuk, namaPengirim) {
  const teks = teksMasuk.trim().toLowerCase();
  let s = sesi.get(nomor) || sesiBaru();

  // reset / mulai obrolan
  if (teks === 'menu' || teks === 'mulai' || teks === 'halo' || teks === 'hai') {
    s.tahap = 'pilih_menu';
    sesi.set(nomor, s);
    return teksMenu();
  }

  if (s.tahap === 'pilih_menu') {
    const angkaTerpilih = teks
      .split(/[\s,]+/)
      .map((n) => parseInt(n, 10))
      .filter((n) => !isNaN(n));

    const itemValid = angkaTerpilih
      .map((id) => MENU.find((m) => m.id === id))
      .filter(Boolean);

    if (itemValid.length === 0) {
      return 'Maaf, aku belum paham. Balas dengan nomor menu ya, contoh: 1';
    }

    s.keranjang.push(...itemValid);
    s.tahap = 'alamat';
    sesi.set(nomor, s);

    const ringkasan = s.keranjang.map((i) => i.nama).join(', ');
    return `${ringkasan} dicatat. Totalnya ${(
      totalKeranjang(s.keranjang) / 1000
    ).toFixed(0)}rb.\nKirim ke alamat mana ya?`;
  }

  if (s.tahap === 'alamat') {
    const total = totalKeranjang(s.keranjang);
    const alamat = teksMasuk.trim();
    const keranjang = s.keranjang;
    sesi.delete(nomor); // selesai, reset sesi

    const { error } = await sb.from('orders').insert({
      nomor,
      nama: namaPengirim || null,
      items: keranjang.map((i) => ({ nama: i.nama, harga: i.harga })),
      total,
      alamat,
      status: 'ok',
    });
    if (error) console.log('Gagal simpan order ke Supabase:', error.message);

    return `Pesanan dikonfirmasi âœ…\nAlamat: ${alamat}\nTotal: ${(
      total / 1000
    ).toFixed(0)}rb\n\nTerima kasih! Ketik *menu* kapan saja untuk pesan lagi.`;
  }

  // default: sapaan awal
  sesi.set(nomor, sesiBaru());
  return PESAN_SAPAAN;
}

// ---------- 4. Koneksi ke WhatsApp ----------
async function mulaiBot() {
  await muatMenuDariSupabase();
  const { state, saveCreds } = await useMultiFileAuthState('sesi_auth');

  // Kalau nomor belum pernah login sebelumnya, tentukan mau pakai QR atau kode pairing.
  // Kalau env var LOGIN_METHOD sudah diatur (dipakai saat hosting di Railway dkk,
  // yang tidak punya terminal interaktif), langsung pakai itu tanpa bertanya.
  let gunakanPairingCode = false;
  let nomorPairing = null;

  if (!state.creds.registered) {
    if (process.env.LOGIN_METHOD) {
      gunakanPairingCode = process.env.LOGIN_METHOD.trim().toLowerCase() === 'pairing';
      nomorPairing = process.env.PHONE_NUMBER || null;
    } else {
      const pilihan = (
        await tanya('Login pakai apa? Ketik "qr" atau "pairing": ')
      )
        .trim()
        .toLowerCase();
      gunakanPairingCode = pilihan === 'pairing';
      if (gunakanPairingCode) {
        nomorPairing = (
          await tanya('Masukkan nomor WhatsApp dengan kode negara, contoh 6281234567890: ')
        ).trim();
      }
    }
  }

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: !gunakanPairingCode,
  });

  if (gunakanPairingCode && !state.creds.registered) {
    if (!nomorPairing) {
      console.log('LOGIN_METHOD=pairing tapi PHONE_NUMBER belum diisi. Cek environment variable di hosting kamu.');
    } else {
      const kode = await sock.requestPairingCode(nomorPairing);
      console.log('\n=== KODE PAIRING KAMU: ' + kode + ' ===');
      console.log(
        'Buka WhatsApp di HP > Perangkat Tertaut > Tautkan dengan nomor telepon > masukkan kode di atas.\n'
      );
    }
  }
  rl.close();

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const alasan = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const harusReconnect = alasan !== DisconnectReason.loggedOut;
      console.log('Koneksi terputus, reconnect:', harusReconnect);
      if (harusReconnect) mulaiBot();
    } else if (connection === 'open') {
      console.log('Bot terhubung dan siap melayani 24 jam âœ…');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const nomor = msg.key.remoteJid;
    const teksMasuk =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      '';

    if (!teksMasuk) return;

    const namaPengirim = msg.pushName || null;

    // Catat/perbarui percakapan ini supaya muncul di dashboard
    const { error: convError } = await sb.from('conversations').upsert({
      nomor,
      nama: namaPengirim,
      last_message: teksMasuk,
      status: 'ok',
      updated_at: new Date().toISOString(),
    });
    if (convError) console.log('Gagal simpan percakapan ke Supabase:', convError.message);

    const balasan = await prosesPesan(nomor, teksMasuk, namaPengirim);
    await sock.sendMessage(nomor, { text: balasan });
  });
}

mulaiBot();
