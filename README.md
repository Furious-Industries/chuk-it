# Chuk-it

Chuk-it shares text between browsers on your machines. Each browser shows the same history. The server sends changes through secure WebSocket connections.

You can add, search, select, copy, and delete clips. The server keeps up to 200 clips in memory. A server restart removes them.

**WARNING: Use Chuk-it only on a LAN or VPN where you control access.**
Every person or program with access to the port can read, add, and delete all clips. Chuk-it has no accounts or passwords.
Do not forward its port through your router. Do not use a public reverse proxy.

The origin check blocks connections from unrelated browser pages. It does not identify people or devices. A native program can supply an approved Origin header.

## Before you start

You need:

- Node.js 24.21.0 or a later supported Node.js 24 release, or Docker Compose.
- OpenSSL for the certificate procedure.
- A fixed LAN or VPN address for the server.
- A browser that supports HTTPS, WebSockets, and the Clipboard API.

This release changes the connection protocol. Reload all browser tabs after an upgrade.

## 1. Configure the addresses

Copy the example configuration:

```sh
cp .env.example .env
```

Edit `.env`:

```dotenv
BIND_ADDRESS=192.168.1.50
PORT=3457
ALLOWED_ORIGINS=https://192.168.1.50:3457,https://chuk-it.home.arpa:3457
```

Replace the example IP address with your server address. Use an address assigned to the server.
For a hostname, configure your private DNS to resolve that name to the server.

`ALLOWED_ORIGINS` contains the Chuk-it addresses that you open. It does not contain client device addresses.
You can use these addresses from any browser on your controlled network.

Use exact HTTPS origins. Include the port when it is not 443. Do not include paths, trailing slashes, credentials, or wildcards.

The server validates the Origin, Host, and `/ws` path before it sends history.
It rejects missing, `null`, malformed, and unlisted origins. The Origin host must also equal the Host header.

## 2. Configure certificates

You can supply an existing trusted certificate and key. The certificate must cover every hostname and IP address that you use.
Put the certificate in `certs/cert.pem`. Put its private key in `certs/key.pem`.

For a private certificate authority, use the procedure below.
A certificate authority is called a CA. A subject alternative name is called a SAN.

**CAUTION: Keep the CA private key away from other people.** A person with this key can issue certificates that your devices trust.
Never copy a private key to a client device. Never put a private key in Git.

1. Create the private directories:

   ```sh
   mkdir -m 700 local-ca certs
   ```

2. Edit the SAN entries in `config/tls-server.cnf`.
   Include each hostname and IP address from your origins.

3. Create the CA certificate and encrypted key:

   ```sh
   openssl req -x509 -newkey rsa:3072 -sha256 -days 3650 \
     -config config/tls-ca.cnf \
     -keyout local-ca/key.pem -out local-ca/cert.pem
   ```

   OpenSSL asks you for a key password. Keep the password private.

4. Create the server key and certificate request:

   ```sh
   openssl req -new -newkey rsa:2048 -nodes -sha256 \
     -config config/tls-server.cnf \
     -keyout certs/key.pem -out certs/server.csr
   ```

5. Sign the server certificate:

   ```sh
   openssl x509 -req -sha256 -days 90 \
     -in certs/server.csr -CA local-ca/cert.pem -CAkey local-ca/key.pem \
     -CAcreateserial -out certs/cert.pem \
     -extfile config/tls-server.cnf -extensions server_ext
   chmod 600 local-ca/key.pem certs/key.pem
   ```

6. Do a check of the certificate chain and SAN entries:

   ```sh
   openssl verify -CAfile local-ca/cert.pem certs/cert.pem
   openssl x509 -in certs/cert.pem -noout -dates -text
   ```

7. Install only `local-ca/cert.pem` as a trusted CA on each client device.
   Use a secure transfer method. Make sure that its SHA-256 fingerprint is correct before you trust it:

   ```sh
   openssl x509 -in local-ca/cert.pem -noout -fingerprint -sha256
   ```

   On macOS, use Keychain Access to add and trust the CA certificate.
   On Windows, use the trusted root certificate store for your user or managed device.
   On Linux, use the distribution's CA store and update procedure.
   Firefox can use a separate certificate store. Examine its certificate settings.
   On iOS, install the certificate profile. Then enable its trust in Certificate Trust Settings.
   See [Apple's certificate instructions](https://support.apple.com/en-gb/102390).
   On Android, use the device certificate settings. The available controls depend on the device policy.

8. Open each Chuk-it address on each device.
   Make sure that the browser shows a valid certificate. Do not continue through a certificate warning.

Keep the CA key outside `certs/`. The container mounts only `certs/`.
Renew the server certificate before its 90-day expiry. Restart Chuk-it after you replace the certificate files.
Replace exposed keys immediately. Remove an exposed CA certificate from every client trust store.

## 3. Start Chuk-it

### With Node.js

Use your normal, unprivileged user account:

```sh
npm ci
node --env-file=.env server.js
```

`npm ci` uses the lockfile. The repository disables install scripts and remote audit submissions.
The startup command reads `.env`; `npm start` uses variables already present in the environment.

The server stops if an address setting or certificate file is missing.
It does not start an HTTP fallback.

### With Docker Compose

On a Linux Docker host, give the container user read access to the server key:

```sh
sudo chown -R 1000:1000 certs
sudo chmod 700 certs
sudo chmod 600 certs/key.pem
sudo chmod 644 certs/cert.pem
```

The image's `node` user has UID 1000. The CA key remains outside this mount.
For rootless Docker, use the mapped host UID instead. Docker Desktop can map ownership differently.

Make sure that the container can read the key before you start the service:

```sh
docker compose build
docker compose run --rm --no-deps chuk-it node -e \
  "require('fs').readFileSync('/app/certs/key.pem'); console.log('Key is readable')"
docker compose up -d
```

Compose publishes port 3457 only on `BIND_ADDRESS`. The process listens on all interfaces inside its container.
The container uses a read-only root filesystem, an unprivileged user, and memory and process limits.

**CAUTION: An interface binding is not a firewall.** Routing or port forwarding can still expose a private interface.
Examine your router, VPN permissions, IPv6 rules, and host firewall.
Docker published ports can bypass some host firewall rules. Use the rules that apply to Docker traffic.
Test that an untrusted device cannot reach the port.

### First use

Open an address from `ALLOWED_ORIGINS`. Paste text into the input box. Select **Add clip**, or press Ctrl+Enter or Cmd+Enter.

The draft remains until the server confirms delivery. **Retry delivery** checks the same submission for up to ten minutes.
A server restart ends that retry window. Examine the history before you send an unconfirmed draft again.
Keep device clocks synchronized.

Chuk-it keeps leading spaces, trailing spaces, and line breaks received from the browser.
A browser textarea can normalize pasted line endings to LF. Chuk-it does not promise binary clipboard transfer.
If clipboard access fails, Chuk-it selects the text in a read-only field for manual copying.

Closing or reloading the page removes its unsent draft. Chuk-it does not save drafts in browser storage.

## Tests

Run the server tests:

```sh
npm ci
npm test
```

Run the browser tests with an installed Chrome browser:

```sh
npm run test:browser
```

On systems without the default macOS Chrome path, set `CHROME_BIN` to your Chrome executable.
The tests use isolated HTTPS servers on loopback. They use synthetic clips.
Test certificates, browser profiles, screenshots, and results stay in `artifacts/security-hardening/`.
Git excludes this directory. The browser tests do not access your system clipboard.

Read [ARCHITECTURE.md](ARCHITECTURE.md) for the protocol and limits.
Read [SECURITY.md](SECURITY.md) for the trust boundary and reporting procedure.
Read [SECURITY-REVIEW.md](SECURITY-REVIEW.md) for the OWASP review and test limits.

## Author and license

Stu maintains Chuk-it. See [LICENSE.md](LICENSE.md) for the existing MIT license.
