global.crypto = require('crypto');

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const makeWASocket = require('@whiskeysockets/baileys').default;
const {
    DisconnectReason,
    downloadMediaMessage,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion,
    initAuthCreds
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

// ============ KONFIGURASI ============
const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ SUPABASE_URL atau SUPABASE_ANON_KEY belum di-set!');
    process.exit(1);
}

// MATIIN REALTIME BIAR GAK BUTUH 'ws'
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 0 } }
});

const MEDIA_DIR = './view_once_permanent';
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

let sock = null;
let currentQR = null;
let pairingCode = null;
let isConnected = false;
let reconnectAttempts = 0;

const logger = pino({ level: 'silent' });

// ============ SUPABASE AUTH STATE ============
async function useSupabaseAuthState(sessionId = 'default') {
    let creds = null;
    let keys = {};

    try {
        const { data, error } = await supabase
            .from('whatsapp_sessions')
            .select('data')
            .eq('session_id', sessionId)
            .maybeSingle();

        if (!error && data && data.data) {
            creds = data.data.creds || null;
            keys = data.data.keys || {};
            console.log('📥 Session loaded from Supabase');
        } else {
            console.log('ℹ️ No session found, starting fresh');
        }
    } catch (err) {
        console.log('ℹ️ Error loading session:', err.message);
    }

    if (!creds) {
        creds = initAuthCreds();
        console.log('🔑 New creds initialized');
    }

    const saveState = async () => {
        try {
            await supabase.from('whatsapp_sessions').upsert({
                session_id: sessionId,
                data: { creds, keys },
                updated_at: new Date().toISOString()
            }, { onConflict: 'session_id' });
        } catch (err) {
            console.error('❌ Save error:', err.message);
        }
    };

    return {
        state: {
            creds,
            keys: {
                get: (type, ids) => {
                    const data = {};
                    for (const id of ids) {
                        let value = keys[type]?.[id];
                        if (type === 'app-state-sync-key' && value) {
                            value = require('@whiskeysockets/baileys').proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }
                    return data;
                },
                set: (data) => {
                    for (const type in data) {
                        keys[type] = keys[type] || {};
                        Object.assign(keys[type], data[type]);
                    }
                    saveState();
                }
            }
        },
        saveCreds: saveState
    };
}

// ============ EXPRESS ROUTES ============
app.use(express.json());
app.use(express.static('public'));

app.get('/health', (req, res) => {
    res.json({ status: 'ok', connected: isConnected });
});

app.get('/status', (req, res) => {
    res.json({ connected: isConnected, qr: currentQR, pairingCode });
});

app.get('/qr', async (req, res) => {
    if (currentQR) {
        const qrImage = await QRCode.toDataURL(currentQR);
        res.json({ qr: qrImage });
    } else {
        res.json({ qr: null });
    }
});

app.post('/pairing', async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'Nomor wajib diisi!' });

    try {
        if (!sock) return res.status(500).json({ error: 'Bot belum siap, tunggu bentar' });
        const cleanNumber = phoneNumber.replace(/\D/g, '');
        const code = await sock.requestPairingCode(cleanNumber);
        pairingCode = code;
        io.emit('pairing_code', { code, phoneNumber: cleanNumber });
        console.log(`🔑 Pairing Code: ${code}`);
        res.json({ code, phoneNumber: cleanNumber });
    } catch (error) {
        console.error('Pairing error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============ SOCKET.IO ============
io.on('connection', (socket) => {
    socket.emit('status', { connected: isConnected, qr: currentQR, pairingCode });
});

// ============ WHATSAPP CONNECTION ============
async function connectToWhatsApp() {
    try {
        const { state, saveCreds } = await useSupabaseAuthState('default');
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger)
            },
            printQRInTerminal: false,
            logger,
            browser: ['Supreme Bot', 'Chrome', '1.0.0'],
            generateHighQualityLinkPreview: true,
            syncFullHistory: false
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                currentQR = qr;
                const qrImage = await QRCode.toDataURL(qr);
                io.emit('qr_updated', { qr: qrImage });
                console.log('📱 QR Code generated!');
            }

            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error instanceof Boom)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(`❌ Closed. Code: ${statusCode}, Reconnect: ${shouldReconnect}`);
                isConnected = false;
                io.emit('status', { connected: false });

                if (shouldReconnect && reconnectAttempts < 10) {
                    reconnectAttempts++;
                    const delay = Math.min(10000 * reconnectAttempts, 60000);
                    console.log(`🔄 Reconnecting in ${delay/1000}s...`);
                    setTimeout(connectToWhatsApp, delay);
                }
            } else if (connection === 'open') {
                console.log('✅ Connected!');
                isConnected = true;
                currentQR = null;
                reconnectAttempts = 0;
                io.emit('status', { connected: true });
            }
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', async (m) => {
            const msg = m.messages[0];
            if (!msg.message) return;

            const viewOnceMsg = msg.message.viewOnceMessageV2 || msg.message.viewOnceMessage;
            if (viewOnceMsg) {
                console.log('👁️ View Once detected!');
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
                        logger,
                        reuploadRequest: sock.updateMediaMessage
                    });

                    const mediaType = Object.keys(viewOnceMsg.message)[0];
                    let extension = 'bin';
                    if (mediaType.includes('Image')) extension = 'jpg';
                    if (mediaType.includes('Video')) extension = 'mp4';
                    if (mediaType.includes('Audio')) extension = 'mp3';

                    const filename = `viewonce_${Date.now()}_${msg.key.remoteJid.split('@')[0]}.${extension}`;
                    fs.writeFileSync(path.join(MEDIA_DIR, filename), buffer);
                    console.log(`💾 Saved: ${filename}`);

                    await supabase.from('view_once_logs').insert({
                        filename,
                        from_number: msg.key.remoteJid,
                        media_type: mediaType,
                        size_bytes: buffer.length
                    });

                    io.emit('view_once_saved', {
                        filename,
                        from: msg.key.remoteJid,
                        timestamp: new Date().toISOString(),
                        size: buffer.length
                    });

                    await sock.sendMessage(msg.key.remoteJid, {
                        [mediaType]: buffer,
                        caption: '🔓 *VIEW ONCE DIAMANKAN PERMANEN!*'
                    });
                } catch (error) {
                    console.error('❌ View once error:', error.message);
                }
            }
        });

    } catch (error) {
        console.error('❌ Connection error:', error.message);
        setTimeout(connectToWhatsApp, 10000);
    }
}

// ============ START ============
server.listen(PORT, () => {
    console.log(`🚀 Bot running on port ${PORT}`);
    console.log(`📡 Supabase: ${SUPABASE_URL ? 'Connected' : 'NOT CONFIGURED!'}`);
    connectToWhatsApp();
});

process.on('SIGTERM', () => {
    if (sock) sock.end();
    server.close(() => process.exit(0));
});
