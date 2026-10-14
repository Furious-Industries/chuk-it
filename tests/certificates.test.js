'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID, X509Certificate } = require('node:crypto');
const { root } = require('./helpers.cjs');

test('documented CA recipe signs a server certificate with DNS and IP SANs', () => {
  const dir = path.join(root, 'recipe-test'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'password'), randomUUID(), { mode: 0o600 });
  const run = args => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  const caConfig = path.resolve(__dirname, '../config/tls-ca.cnf');
  const serverConfig = path.resolve(__dirname, '../config/tls-server.cnf');
  run(['req', '-x509', '-newkey', 'rsa:3072', '-sha256', '-days', '2', '-config', caConfig,
    '-keyout', 'ca-key.pem', '-out', 'ca-cert.pem', '-passout', 'file:password']);
  fs.chmodSync(path.join(dir, 'ca-key.pem'), 0o600);
  run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-config', serverConfig,
    '-keyout', 'key.pem', '-out', 'server.csr']);
  fs.chmodSync(path.join(dir, 'key.pem'), 0o600);
  run(['x509', '-req', '-sha256', '-days', '1', '-in', 'server.csr', '-CA', 'ca-cert.pem', '-CAkey', 'ca-key.pem',
    '-passin', 'file:password', '-CAcreateserial', '-out', 'cert.pem', '-extfile', serverConfig, '-extensions', 'server_ext']);
  assert.match(run(['verify', '-CAfile', 'ca-cert.pem', 'cert.pem']).toString(), /OK/);
  const cert = new X509Certificate(fs.readFileSync(path.join(dir, 'cert.pem')));
  assert.equal(cert.ca, false);
  assert.equal(cert.checkHost('chuk-it.home.arpa'), 'chuk-it.home.arpa');
  assert.equal(cert.checkIP('192.168.1.50'), '192.168.1.50');
  assert.equal(cert.checkHost('wrong.home.arpa'), undefined);
  assert.ok(cert.verify(new X509Certificate(fs.readFileSync(path.join(dir, 'ca-cert.pem'))).publicKey));
});
