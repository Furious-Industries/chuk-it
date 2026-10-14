'use strict';
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');

const LIMITS = Object.freeze({
  items: 200, messageBytes: 512 * 1024, storeBytes: 16 * 1024 * 1024,
  clientBuffer: 20 * 1024 * 1024, totalBuffer: 64 * 1024 * 1024,
  connections: 32, perAddress: 16, rawConnections: 64,
  messagesPerMinute: 120, addressMessagesPerMinute: 300, bytesPerMinute: 16 * 1024 * 1024,
  attemptsPerMinute: 60, addresses: 1024, heartbeatMs: 30000,
  receipts: 2048, retryMs: 10 * 60 * 1000,
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function parseOrigins(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Set ALLOWED_ORIGINS to the HTTPS addresses that you use.');
  const entries = value.split(',').map(s => s.trim());
  if (entries.length > 32) throw new Error('Use no more than 32 origins.');
  for (const entry of entries) {
    let url;
    try { url = new URL(entry); } catch { throw new Error('Each origin must be a full HTTPS origin.'); }
    if (url.protocol !== 'https:' || url.origin !== entry || url.username || url.password || entry.includes('*')) {
      throw new Error('Use exact HTTPS origins with no path, trailing slash, or wildcard.');
    }
  }
  return new Set(entries);
}

function consume(bucket, amount, capacity, now) {
  bucket.tokens = Math.min(capacity, bucket.tokens + (now - bucket.at) * capacity / 60000);
  bucket.at = now;
  if (amount > bucket.tokens) return false;
  bucket.tokens -= amount;
  return true;
}
function bucket(capacity, now) { return { tokens: capacity, at: now }; }
function fitsSend(client, bytes, all, limits) {
  let queued = 0;
  for (const other of all) queued += other.bufferedAmount;
  return client.bufferedAmount + bytes <= limits.clientBuffer && queued + bytes <= limits.totalBuffer;
}

function createApp({ tls, allowedOrigins, limits: overrides = {}, log = console.warn }) {
  const limits = { ...LIMITS, ...overrides };
  const origins = parseOrigins(allowedOrigins);
  const hosts = new Set([...origins].map(origin => new URL(origin).host));
  const session = randomUUID();
  let clips = [], storeBytes = 0;
  const securityCounts = Object.create(null);
  const count = name => { securityCounts[name] = (securityCounts[name] || 0) + 1; };
  function logSummary() {
    if (!Object.keys(securityCounts).length) return;
    log(JSON.stringify({ event: 'security_summary', time: new Date().toISOString(), counts: { ...securityCounts } }));
    for (const name of Object.keys(securityCounts)) delete securityCounts[name];
  }
  const receipts = new Map(), addresses = new Map(), rawSockets = new Set();
  const assets = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ].map(([route, [file, type]]) => [route, { body: fs.readFileSync(path.join(__dirname, 'public', file)), type }]));
  const headers = {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer', 'Strict-Transport-Security': 'max-age=31536000',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src " +
      [...origins].map(origin => origin.replace('https:', 'wss:')).join(' ') +
      "; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  };
  function validHost(req) {
    return typeof req.headers.host === 'string' && hosts.has(req.headers.host);
  }
  const server = https.createServer({ ...tls, minVersion: 'TLSv1.2',
    ciphers: 'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384',
    honorCipherOrder: true, maxHeaderSize: 8192, handshakeTimeout: 10000 }, (req, res) => {
    const asset = assets.get(req.url);
    const status = !validHost(req) ? 403 : !['GET', 'HEAD'].includes(req.method) ? 405 : asset ? 200 : 404;
    res.writeHead(status, { ...headers, ...(status === 200 ? { 'Content-Type': asset.type } : {}) });
    res.end(status === 200 && req.method === 'GET' ? asset.body : undefined);
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.setTimeout(15000, socket => socket.destroy());
  server.maxConnections = limits.rawConnections;
  server.on('connection', socket => {
    rawSockets.add(socket);
    socket.on('close', () => rawSockets.delete(socket));
  });
  server.on('clientError', (_, socket) => socket.destroy());
  server.on('tlsClientError', () => {});
  server.on('error', () => log('HTTPS server error.'));
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.messageBytes, perMessageDeflate: false,
    maxFragments: 1024, maxBufferedChunks: 1024, autoPong: false });
  wss.on('error', () => log('WebSocket server error.'));

  function addressState(address) {
    const now = Date.now();
    for (const [key, value] of addresses) {
      if (value.count === 0 && now - value.seen > 60000) addresses.delete(key);
    }
    let state = addresses.get(address);
    if (!state) {
      if (addresses.size >= limits.addresses) return null;
      state = { count: 0, seen: now, attempts: bucket(limits.attemptsPerMinute, now),
        messages: bucket(limits.addressMessagesPerMinute, now), bytes: bucket(limits.bytesPerMinute, now) };
      addresses.set(address, state);
    }
    state.seen = now;
    return state;
  }
  function reject(socket, status) {
    count(status === 429 ? 'upgrade_limited' : 'upgrade_rejected');
    socket.end(`HTTP/1.1 ${status} ${status === 429 ? 'Too Many Requests' : 'Forbidden'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    const timer = setTimeout(() => socket.destroy(), 1000);
    timer.unref();
    socket.once('close', () => clearTimeout(timer));
  }
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const state = addressState(socket.remoteAddress);
    if (!state || !consume(state.attempts, 1, limits.attemptsPerMinute, Date.now())) return reject(socket, 429);
    if (req.method !== 'GET' || req.url !== '/ws' || !validHost(req) ||
        typeof req.headers.origin !== 'string' || !origins.has(req.headers.origin) ||
        new URL(req.headers.origin).host !== req.headers.host || req.headers['sec-websocket-protocol']) return reject(socket, 403);
    if (wss.clients.size >= limits.connections || state.count >= limits.perAddress) return reject(socket, 429);
    wss.handleUpgrade(req, socket, head, ws => {
      state.count++;
      socket.setTimeout(0);
      wss.emit('connection', ws, state);
    });
  });

  function safeSend(ws, value) {
    if (ws.readyState !== WebSocket.OPEN) return;
    const data = typeof value === 'string' ? value : JSON.stringify(value);
    if (!fitsSend(ws, Buffer.byteLength(data), wss.clients, limits)) { count('slow_reader'); return ws.terminate(); }
    ws.send(data, error => { if (error) ws.terminate(); });
  }
  function broadcast(value) {
    const data = JSON.stringify(value);
    for (const ws of wss.clients) safeSend(ws, data);
  }
  function expireReceipts(now) {
    for (const [id, receipt] of receipts) if (receipt.expires <= now) receipts.delete(id);
  }
  function error(ws, code, requestId) {
    count(code);
    safeSend(ws, { type: 'error', code, ...(typeof requestId === 'string' && UUID.test(requestId) ? { requestId } : {}) });
  }
  wss.on('connection', (ws, address) => {
    ws.alive = true;
    const rate = bucket(limits.messagesPerMinute, Date.now());
    ws.on('error', () => { count('protocol_error'); ws.terminate(); });
    ws.on('close', () => { address.count--; address.seen = Date.now(); });
    const allow = bytes => {
      const now = Date.now();
      address.seen = now;
      return consume(rate, 1, limits.messagesPerMinute, now) &&
        consume(address.messages, 1, limits.addressMessagesPerMinute, now) &&
        consume(address.bytes, bytes, limits.bytesPerMinute, now);
    };
    ws.on('pong', () => { if (!allow(0)) ws.terminate(); else ws.alive = true; });
    ws.on('ping', data => { if (!allow(data.length)) ws.terminate(); else ws.pong(data); });
    safeSend(ws, { type: 'init', session, clips, maxItems: limits.items, maxFrameBytes: limits.messageBytes, retryMs: limits.retryMs });
    ws.on('message', (raw, binary) => {
      if (!allow(raw.length)) { count('message_limited'); return ws.terminate(); }
      let msg;
      try { if (binary) throw new Error(); msg = JSON.parse(raw.toString()); } catch { return error(ws, 'invalid_message'); }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return error(ws, 'invalid_message');
      const keys = msg.type === 'add' ? ['type', 'requestId', 'session', 'createdAt', 'text', 'source'] :
        msg.type === 'delete' ? ['type', 'requestId', 'session', 'createdAt', 'id'] :
        msg.type === 'clear' ? ['type', 'requestId', 'session', 'createdAt'] : [];
      if (!keys.length || Object.keys(msg).length !== keys.length || keys.some(key => !Object.hasOwn(msg, key)) ||
          typeof msg.requestId !== 'string' || !UUID.test(msg.requestId) || !Number.isSafeInteger(msg.createdAt) ||
          (msg.type === 'add' && (typeof msg.text !== 'string' || !msg.text.trim() || typeof msg.source !== 'string' ||
            msg.source.length > 40 || /[\x00-\x1f\x7f]/.test(msg.source))) ||
          (msg.type === 'delete' && (typeof msg.id !== 'string' || !UUID.test(msg.id)))) return error(ws, 'invalid_message', msg.requestId);
      if (msg.session !== session) return error(ws, 'session_changed', msg.requestId);
      const now = Date.now();
      // A request cannot start a new retry window after its original receipt expires.
      if (msg.createdAt > now + 30000 || now - msg.createdAt >= limits.retryMs) return error(ws, 'request_expired', msg.requestId);
      expireReceipts(now);
      const fingerprint = createHash('sha256').update(JSON.stringify(keys.map(key => msg[key]))).digest('hex');
      const old = receipts.get(msg.requestId);
      if (old) {
        if (old.fingerprint !== fingerprint) return error(ws, 'request_conflict', msg.requestId);
        return safeSend(ws, old.ack);
      }
      // Keep every accepted receipt for the full retry window. Do not evict it early.
      if (receipts.size >= limits.receipts) return error(ws, 'busy', msg.requestId);
      const ack = { type: 'ack', requestId: msg.requestId, session };
      if (msg.type === 'add') {
        const clip = { id: randomUUID(), text: msg.text, preview: msg.text.length > 80 ? msg.text.slice(0, 80) + '…' : msg.text,
          ts: now, source: msg.source };
        const bytes = Buffer.byteLength(JSON.stringify(clip)) + 1;
        if (bytes > limits.storeBytes) return error(ws, 'too_large', msg.requestId);
        const removed = [];
        clips = clips.filter(item => {
          if (item.text !== msg.text) return true;
          removed.push(item.id); storeBytes -= Buffer.byteLength(JSON.stringify(item)) + 1; return false;
        });
        clips.unshift(clip); storeBytes += bytes;
        while (clips.length > limits.items || storeBytes > limits.storeBytes) {
          const item = clips.pop(); removed.push(item.id); storeBytes -= Buffer.byteLength(JSON.stringify(item)) + 1;
        }
        ack.clipId = clip.id;
        // One event keeps deduplication and selection changes atomic in each browser.
        broadcast({ type: 'add', clip, removed });
      } else if (msg.type === 'delete') {
        clips = clips.filter(item => {
          if (item.id !== msg.id) return true;
          storeBytes -= Buffer.byteLength(JSON.stringify(item)) + 1; return false;
        });
        broadcast({ type: 'delete', id: msg.id });
      } else {
        clips = []; storeBytes = 0; broadcast({ type: 'clear' });
      }
      receipts.set(msg.requestId, { fingerprint, ack, expires: msg.createdAt + limits.retryMs });
      safeSend(ws, ack);
    });
  });
  const heartbeat = setInterval(() => {
    expireReceipts(Date.now());
    logSummary();
    for (const ws of wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      ws.ping();
    }
  }, limits.heartbeatMs);
  heartbeat.unref();
  server.on('close', () => clearInterval(heartbeat));
  async function close() {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    for (const socket of rawSockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    wss.close();
  }
  return { server, close };
}

if (require.main === module) {
  try {
    const port = Number(process.env.PORT || 3457);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
    if (!process.env.BIND_ADDRESS) throw new Error('Set BIND_ADDRESS to the local interface address.');
    const app = createApp({ allowedOrigins: process.env.ALLOWED_ORIGINS, tls: {
      key: fs.readFileSync(path.join(__dirname, 'certs/key.pem')), cert: fs.readFileSync(path.join(__dirname, 'certs/cert.pem')),
    } });
    app.server.once('error', () => process.exitCode = 1);
    app.server.listen(port, process.env.BIND_ADDRESS, () => console.log('Chuk-it is ready. Only use a network that you control.'));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close(); });
  } catch {
    console.error('Chuk-it cannot start. Check BIND_ADDRESS, ALLOWED_ORIGINS, PORT, and the certificate files. Read README.md.');
    process.exitCode = 1;
  }
}
module.exports = { createApp, parseOrigins, fitsSend, LIMITS };
