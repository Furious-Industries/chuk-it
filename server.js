const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3457;
const MAX_ITEMS = 200;
const MAX_MSG_BYTES = 512 * 1024;

const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

const sslOptions = {
  key: fs.readFileSync(path.join(__dirname, 'certs', 'key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'certs', 'cert.pem')),
};

let clips = [];
let nextId = 1;

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

function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(data);
  });
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'init', clips, maxItems: MAX_ITEMS }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      if (msg.type === 'add') {
        const text = (msg.text || '').trim();
        if (!text) return;
        clips = clips.filter(c => c.text !== text);
        const clip = {
          id: nextId++,
          text,
          preview: text.length > 80 ? text.slice(0, 80) + '…' : text,
          ts: Date.now(),
          source: msg.source || 'unknown'
        };
        clips.unshift(clip);
        if (clips.length > MAX_ITEMS) clips.length = MAX_ITEMS;
        broadcast({ type: 'add', clip });
        return;
      }

      if (msg.type === 'delete') {
        const id = Number(msg.id);
        if (!Number.isInteger(id)) return;
        clips = clips.filter(c => c.id !== id);
        broadcast({ type: 'delete', id });
        return;
      }

      if (msg.type === 'clear') {
        clips = [];
        broadcast({ type: 'clear' });
      }

    } catch (e) {
      console.error('bad message', e.message);
    }
  });
});

server.listen(PORT, () => {
  console.log(`ClipStack running on https://0.0.0.0:${PORT}`);
});
