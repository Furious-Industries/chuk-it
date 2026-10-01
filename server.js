const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3457;
const MAX_ITEMS = 200;
const MAX_MSG_BYTES = 512 * 1024;
const MAX_STORE_BYTES = 16 * 1024 * 1024;   // bound the whole in-memory store, not just the item count
const MAX_SOURCE_LEN = 40;
const SEND_BUFFER_LIMIT = 8 * 1024 * 1024;  // drop a client that cannot keep up, before its buffer grows without bound

const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

// The server needs a TLS key and certificate to start. If they are absent, stop with a clear
// message instead of an opaque ENOENT stack trace.
let sslOptions;
try {
  sslOptions = {
    key: fs.readFileSync(path.join(__dirname, 'certs', 'key.pem')),
    cert: fs.readFileSync(path.join(__dirname, 'certs', 'cert.pem')),
  };
} catch (err) {
  console.error('Chuk-it cannot start. It cannot read the TLS key or certificate.');
  console.error('Put a key in certs/key.pem and a certificate in certs/cert.pem.');
  console.error('To make a self-signed pair, read the "Certificates" section in README.md.');
  console.error('Cause: ' + err.message);
  process.exit(1);
}

let clips = [];
let nextId = 1;
let storeBytes = 0;   // running total of clip text bytes held in memory

// The internal clip keeps a byte count; clients do not need it.
const publicClip = (c) => ({ id: c.id, text: c.text, preview: c.preview, ts: c.ts, source: c.source });

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000',
};

const server = https.createServer(sslOptions, (req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
    res.end(INDEX_HTML);
    return;
  }
  res.writeHead(404, SECURITY_HEADERS);
  res.end();
});

const wss = new WebSocketServer({ server, maxPayload: MAX_MSG_BYTES });

// Server-level 'error' events (e.g. a failed listen, or an accept-time socket error) would also be
// fatal if unhandled. Keep the process alive; a single bad connection must never take Chuk-it down.
wss.on('error', (err) => console.error('wss error:', err.message));
server.on('error', (err) => console.error('server error:', err.message));

// Send to one client only if it can keep up. If its outgoing buffer is already large, the client
// does not read its socket, so drop the connection instead of buffering more data in the server.
function safeSend(client, data) {
  if (client.readyState !== 1) return;
  if (client.bufferedAmount > SEND_BUFFER_LIMIT) { try { client.terminate(); } catch (_) {} return; }
  client.send(data);
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(client => safeSend(client, data));
}

wss.on('connection', (ws) => {
  // A socket that emits 'error' with no listener throws — Node's EventEmitter turns an unhandled
  // 'error' into an uncaught exception that takes the whole server down. This fires for protocol
  // errors and, crucially, when a client sends a frame over maxPayload (>512KB) — so without this
  // handler a single oversized paste would crash Chuk-it for everyone. Log it and drop the socket.
  ws.on('error', (err) => { console.error('ws error:', err.message); try { ws.close(); } catch (_) {} });

  safeSend(ws, JSON.stringify({ type: 'init', clips: clips.map(publicClip), maxItems: MAX_ITEMS }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      if (msg.type === 'add') {
        const text = (msg.text || '').trim();
        if (!text) return;
        // Keep the source label short and always a string; a client sends it, so do not trust it.
        const source = (typeof msg.source === 'string' ? msg.source : 'unknown').slice(0, MAX_SOURCE_LEN);
        // Remove any existing clip with the same text and reclaim its bytes (dedupe).
        clips = clips.filter(c => { if (c.text === text) { storeBytes -= c.bytes; return false; } return true; });
        const bytes = Buffer.byteLength(text);
        const clip = {
          id: nextId++,
          text,
          bytes,
          preview: text.length > 80 ? text.slice(0, 80) + '…' : text,
          ts: Date.now(),
          source
        };
        clips.unshift(clip);
        storeBytes += bytes;
        // Evict the oldest clips until the store is within both the item cap and the byte budget.
        // Broadcast each eviction so every client stays in step with the server.
        while (clips.length > MAX_ITEMS || (storeBytes > MAX_STORE_BYTES && clips.length > 1)) {
          const removed = clips.pop();
          storeBytes -= removed.bytes;
          broadcast({ type: 'delete', id: removed.id });
        }
        broadcast({ type: 'add', clip: publicClip(clip) });
        return;
      }

      if (msg.type === 'delete') {
        const id = Number(msg.id);
        if (!Number.isInteger(id)) return;
        clips = clips.filter(c => { if (c.id === id) { storeBytes -= c.bytes; return false; } return true; });
        broadcast({ type: 'delete', id });
        return;
      }

      if (msg.type === 'clear') {
        clips = [];
        storeBytes = 0;
        broadcast({ type: 'clear' });
      }

    } catch (e) {
      console.error('bad message', e.message);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Chuk-it running on https://0.0.0.0:${PORT}`);
});
