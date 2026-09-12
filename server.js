const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { 
    useMultiFileAuthState, 
    DisconnectReason, 
    downloadMediaMessage,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion
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

// Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Folder buat simpan media view once
const MEDIA_DIR = './view_once_permanent';
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

// State global
let sock = null;
let currentQR = null;
let pairingCode = null;
let isConnected = false;
let reconnectAttempts = 0;

// Logger silent
const logger = pino({ level: 'silent' });

// ============ SUPABASE SESSION HELPERS ============
async function saveSessionToSupabase(sessionId, data) {
    try {
        const { error } = await supabase
            .from('whatsapp_sessions')
            .upsert({ 
                session_id: sessionId, 
                data: data,
                updated_at: new Date().toISOString()
            }, { onConflict: 'session_id' });
        
        if (error) throw error;
        console.log(`💾 Session saved to Supabase: ${sessionId}`);
    } catch (err) {
        console.error('❌ Gagal save session ke Supabase:', err.message);
    }
}

async function loadSessionFromSupabase(sessionId) {
    try {
        const { data, error } = await supabase
            .from('whatsapp_sessions')
            .select('data')
            .eq('session_id', sessionId)
            .single();
        
        if (error) throw error;
        if (data) {
            console.log(`📥 Session loaded from Supabase: ${sessionId}`);
            return data.data;
        }
        return null;
    } catch (err) {
        console.log('ℹ️ No session found in Supabase, starting fresh');
        return null;
    }
}

// ============ CUSTOM AUTH STATE (SUPABASE) ============
async function useSupabaseAuthState(sessionId = 'default') {
    const sessionData = await loadSessionFromSupabase(sessionId);
    
    let creds = sessionData?.creds || null;
    let keys = sessionData?.keys || {};

    const saveCreds = async () => {
        await saveSessionToSupabase(sessionId, { creds, keys });
    };

    const saveKeys = async () => {
        await saveSessionToSupabase(sessionId, { creds, keys });
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
                    saveKeys();
                }
            }
        },
        saveCreds: async () => {
            await saveSessionToSupabase(sessionId, { creds, keys });
        }
    };
}

// ============ EXPRESS ROUTES ============
app.use(express.json());
app.use(express.static('public'));

app.get('/health', (req, res) => {
    res.json({ status: 'ok', connected: isConnected, timestamp: new Date().toISOString() });
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
    
    if (!phoneNumber) {
        return res.status(400).json({ error: 'Nomor HP wajib diisi GOBLOK!' });
    }

    try {
        if (!sock) {
            return res.status(500).json({ error: 'Bot belum siap, tunggu bentar' });
        }

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

app.get('/sessions', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('whatsapp_sessions')
            .select('session_id, created_at, updated_at');
        
        if (error) throw error;
        res.json({ sessions: data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ SOCKET.IO ============
io.on('connection', (socket) => {
    console.log('🖥️ Client connected');
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
            generateHighQualityLinkPreview: true
        });

        // Connection updates
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                currentQR = qr;
                const qrImage = await QRCode.toDataURL(qr);
                io.emit('qr_updated', { qr: qrImage });
                console.log('📱 QR Code generated! Scan via website.');
            }

            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error instanceof Boom)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                console.log(`❌ Connection closed. Status: ${statusCode}. Reconnect: ${shouldReconnect}`);
                isConnected = false;
                io.emit('status', { connected: false });

                if (shouldReconnect && reconnectAttempts < 10) {
                    reconnectAttempts++;
                    const delay = Math.min(5000 * reconnectAttempts, 30000);
                    console.log(`🔄 Reconnecting in ${delay/1000}s... (attempt ${reconnectAttempts})`);
                    setTimeout(connectToWhatsApp, delay);
                } else if (statusCode === DisconnectReason.loggedOut) {
                    console.log('🚪 Logged out. Hapus session di Supabase buat login ulang.');
                }
            } else if (connection === 'open') {
                console.log('✅ Connected to WhatsApp!');
                isConnected = true;
                currentQR = null;
                reconnectAttempts = 0;
                io.emit('status', { connected: true });
            }
        });

        // Save creds
        sock.ev.on('creds.update', saveCreds);

        // Handle pesan masuk
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
                    const filepath = path.join(MEDIA_DIR, filename);
                    fs.writeFileSync(filepath, buffer);

                    console.log(`💾 Saved: ${filename}`);

                    // Simpan metadata ke Supabase
                    await supabase.from('view_once_logs').insert({
                        filename,
                        from_number: msg.key.remoteJid,
                        media_type: mediaType,
                        size_bytes: buffer.length,
                        created_at: new Date().toISOString()
                    });

                    io.emit('view_once_saved', {
                        filename,
                        from: msg.key.remoteJid,
                        timestamp: new Date().toISOString(),
                        size: buffer.length
                    });

                    // Kirim balik ke chat sebagai pesan permanen
                    await sock.sendMessage(msg.key.remoteJid, {
                        [mediaType.replace('Message', 'Message')]: buffer,
                        caption: '🔓 *VIEW ONCE DIAMANKAN PERMANEN!*'
                    });

                } catch (error) {
                    console.error('❌ Error processing view once:', error);
                }
            }
        });

    } catch (error) {
        console.error('❌ Connection error:', error);
        setTimeout(connectToWhatsApp, 10000);
    }
}

// ============ START SERVER ============
server.listen(PORT, () => {
    console.log(`🚀 Supreme Bot running on port ${PORT}`);
    console.log(`📡 Supabase: ${SUPABASE_URL ? 'Connected' : 'NOT CONFIGURED!'}`);
    connectToWhatsApp();
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 Shutting down...');
    if (sock) sock.end();
    server.close(() => process.exit(0));
});
