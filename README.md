# Chuk-it

Chuk-it is a self-hosted clipboard tool for browsers across machines on the same network. It keeps a shared list of text clips in memory. It sends each change to all connected browsers immediately through WebSocket connections.

I wanted a quick way to get the contents of my clipboard on one OS device shared neatly across Linux/Windows/MacOS, without resorting to logging into gmail on three machines, and using a draft email as a lazy clipboard.

It has a simple UI to capture the clipboard and 'chuk-it' over to the other machines on the network. It's viewable as a served page in the browser and holds a rolling memory of clips (which can be searched/deleted/recaptured).

It is text only as it's mainly used for transporting code, commands, URLs, certs, IDs, etc.

> ⚠️ **Use Chuk-it only on a network that you trust.**
> Chuk-it has no authentication. Any person who can connect to the port can read, add, and delete every clip on every connected device. Do not open the port to the internet. Do not put Chuk-it behind a public reverse proxy. Keep Chuk-it on your local area network (LAN), or connect to it through a virtual private network (VPN).

## Features

- Add text clips from any connected browser.
- The server sends each new clip to all browsers immediately.
- Search the recent clips in the sidebar.
- Show and copy the full text of a clip.
- Delete one clip, or delete all clips.
- HTTPS and secure WebSocket connections protect the transport.

## Files

- `server.js` — the HTTPS server and the WebSocket server.
- `public/index.html` — the browser interface, with its CSS and client code.
- `Dockerfile` — the container build file.
- `docker-compose.yml` — the service definition for local use.
- `package.json` — the Node metadata and the dependency on `ws`.
- `certs/` — the TLS certificate and key for HTTPS. Do not commit the private key. Git ignores this directory.
- `ARCHITECTURE.md` — the architecture and behavior document.

## Certificate and network requirements

Chuk-it must use HTTPS. The browser clipboard interface and the secure WebSocket connection need a secure context. Do not commit your private key or certificate to the repository. Make a self-signed certificate for a test. Use a reverse proxy with a valid certificate for production.

### Make a test certificate

Make the `certs/` directory. Then make a self-signed certificate with OpenSSL:

```bash
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes -keyout certs/key.pem -out certs/cert.pem -days 365 \
  -subj "/CN=localhost"
```

Then start Chuk-it and open `https://localhost:3457/`.

**The browser shows a security warning the first time.** The certificate is self-signed. The browser shows "Your connection is not private" (`NET::ERR_CERT_AUTHORITY_INVALID`). This is normal. Open **Advanced** and continue to the site. You do this one time on each device.

**Chuk-it needs a certificate and a key to start.** Chuk-it reads `certs/key.pem` and `certs/cert.pem` at start. If a file is absent, Chuk-it shows an error that names the file, and stops. Make the certificate first.

Chuk-it serves the interface and the WebSocket connection from the same origin. So the default setup does not need cross-origin resource sharing (CORS) headers. If you serve the interface and the WebSocket connection from different origins, use the correct `wss://` origin or proxy configuration.

## Run Chuk-it

### Requirements

- Node.js 20 or later, or Docker.
- A TLS certificate in `certs/cert.pem` and a key in `certs/key.pem`.

### Run with Node

```bash
npm install
npm start
```

Then open `https://localhost:3457/`.

### Run with Docker

```bash
docker build -t chuk-it .
docker run -p 3457:3457 -v "$PWD/certs:/app/certs:ro" --name chuk-it chuk-it
```

Docker mounts the certificate at run time. It does not copy the certificate into the image. So the private key is never in an image layer.

### Run with Docker Compose

```bash
docker compose up --build
```

## Notes

- Chuk-it keeps the clip list in memory only. It loses the list when it stops.
- Chuk-it has no authentication. This is a design choice for a trusted-network tool. Read the warning at the top of this file. Do not open Chuk-it to the internet. There is a small chance a madman (or fleet of agents) can find it and make off with your juicy clipboard contents. You have been warned.
- Each message has a limit of 512 KB so nothing explodes.
- The clip list has a total size limit of 16 MB.
- The server prunes the oldest clips first when the size limit is hit.
- Chuk-it needs HTTPS for the clipboard functions and the secure WebSocket connection, and to feel instant.
- Serve the interface and the WebSocket server from the same host and port when possible.

## Contribute

You can fork the project and experiment. It does what I needed it to, so this is it.

Good additions might include:

- persistent storage for clips
- authentication or access control
- support for binary clipboard data
- better WebSocket error handling
- pretty colours

---

For more detail about the architecture and the behaviour, read `ARCHITECTURE.md`.
