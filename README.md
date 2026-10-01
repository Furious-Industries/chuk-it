# ClipStack

ClipStack is a self-hosted clipboard syncing app for browsers. It keeps a shared history of text clips in memory and broadcasts updates to all connected clients in real time using WebSockets.

## Features

- Add text clips from any connected browser
- Real-time sync across all connected clients
- Search recent clips in the sidebar
- View and copy full clip content
- Delete individual clips or clear the full history
- Secure HTTPS + WebSocket transport

## Files

- `server.js` - HTTPS server and WebSocket backend
- `public/index.html` - browser UI with embedded CSS and client logic
- `Dockerfile` - container build configuration
- `docker-compose.yml` - service definition for local deployment
- `package.json` - Node metadata and dependency on `ws`
- `certs/` - SSL certificate and key for HTTPS (do not commit private keys; this folder should be ignored by Git)
- `ARCHITECTURE.md` - specification and architecture document

## Certificates and network requirements

ClipStack requires HTTPS because the browser clipboard API and secure WebSocket transport depend on a secure context. Do not push your own private key or cert files to the repository. Instead, generate your own self-signed certs for testing or use a reverse proxy with valid certificates in production or, you can just click past the warnings the browsers and it will work just fine...

### Generating local test certificates

For a local development setup, create a `certs/` folder and generate a self-signed certificate with OpenSSL:

```bash
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes -keyout certs/key.pem -out certs/cert.pem -days 365 \
  -subj "/CN=localhost"
```

Then start the app and open `https://localhost:3457/`.

The app serves both the web UI and WebSocket endpoint from the same origin, so standard CORS headers are not needed for the default setup. If you host the UI and WS endpoint separately, ensure the WebSocket connection uses the correct `wss://` origin or proxy configuration.

## Run Locally

### Prerequisites

- Node.js 20+ or Docker
- SSL certs present in `certs/key.pem` and `certs/cert.pem`

### Using Node

```bash
npm install
npm start
```

Then open `https://localhost:3457/`.

### Using Docker

```bash
docker build -t clipstack .
docker run -p 3457:3457 -v "$PWD/certs:/app/certs:ro" --name clipstack clipstack
```

Certs are mounted at runtime rather than baked into the image, so the private key never rocks up in an image layer.

### Using Docker Compose

```bash
docker compose up --build
```

## Notes

- Clip history is stored only in memory and is lost on server restart.
- No authentication is configured.
- HTTPS is required for clipboard features and secure WebSocket connections.
- The app is built for same-origin deployment: the page and WebSocket server should be reached from the same host and port when possible.

## Contributing

Feel free to fork and experiment, it does what I needed it to, so this is it.

Good improvements include:
- persistent storage for clips
- authentication or access controls
- support for binary clipboard formats
- improved WebSocket error handling

---

For a more detailed architecture and behaviour description, see `ARCHITECTURE.md`.
