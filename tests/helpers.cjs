'use strict';
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { WebSocket } = require('ws');
const { createApp } = require('../server');
const root = path.resolve(__dirname, '../artifacts/security-hardening');
fs.mkdirSync(path.join(root, 'evidence'), { recursive: true });
// Each test process gets a fresh key pair. Parallel runs cannot overwrite it.
const certDir = fs.mkdtempSync(path.join(root, 'test-certs-'));
if (!fs.existsSync(path.join(certDir, 'cert.pem'))) {
  fs.writeFileSync(path.join(certDir, 'openssl.cnf'), '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '7', '-config', path.join(certDir, 'openssl.cnf'), '-keyout', path.join(certDir, 'key.pem'), '-out', path.join(certDir, 'cert.pem')], { stdio: 'ignore' });
  fs.chmodSync(path.join(certDir, 'key.pem'), 0o600);
}
const tls = { key: fs.readFileSync(path.join(certDir, 'key.pem')), cert: fs.readFileSync(path.join(certDir, 'cert.pem')) };
async function fixture(limits = {}, fixedPort = 0) {
  // The selected loopback port is known only after listen. Replace this temporary
  // server with the app before tests make a connection.
  const probe = https.createServer(tls); probe.listen(fixedPort, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const origins = [`https://127.0.0.1:${port}`, `https://localhost:${port}`];
  const logs = [];
  const app = createApp({ tls, allowedOrigins: origins.join(','), limits, log: line => logs.push(line) });
  app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening');
  return { ...app, port, origin: origins[0], origins, logs };
}
function client(app, options = {}) {
  const origin = options.origin === undefined ? app.origin : options.origin;
  const ws = new WebSocket(`wss://127.0.0.1:${app.port}${options.path || '/ws'}`, {
    ca: tls.cert, ...(origin === null ? {} : { origin }), ...options,
    headers: { Host: `127.0.0.1:${app.port}`, ...options.headers },
  });
  const messages = [], waiting = [];
  ws.on('error', () => {});
  ws.on('message', raw => {
    const msg = JSON.parse(raw); messages.push(msg);
    for (const waiter of [...waiting]) if (waiter.predicate(msg)) {
      waiting.splice(waiting.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(msg);
    }
  });
  const next = (type, predicate = () => true) => {
    const match = msg => msg.type === type && predicate(msg);
    const present = messages.find(match);
    if (present) return Promise.resolve(present);
    return new Promise((resolve, reject) => {
      const waiter = { predicate: match, resolve };
      waiter.timer = setTimeout(() => { waiting.splice(waiting.indexOf(waiter), 1); reject(new Error(`No ${type} message`)); }, 3000);
      waiting.push(waiter);
    });
  };
  return { ws, messages, next, send: msg => ws.send(JSON.stringify(msg)) };
}
function mutation(session, type = 'add', extra = {}) {
  return { type, requestId: randomUUID(), session, createdAt: Date.now(), ...(type === 'add' ? { text: 'synthetic test clip', source: 'test' } : {}), ...extra };
}
function request(app, route = '/', options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port: app.port, path: route, ca: tls.cert, ...options }, res => {
      const parts = []; res.on('data', part => parts.push(part)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString() }));
    });
    req.on('error', reject); req.end();
  });
}
module.exports = { fixture, client, mutation, request, tls, root };
