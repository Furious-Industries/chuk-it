# ClipStack — Architecture &amp; Specification

## Overview

ClipStack is a self-hosted, browser-based clipboard stack and sync app. It provides a simple HTTPS web UI and WebSocket backend to capture clipboard text entries, maintain a shared history of recent clips, and deliver real-time updates to all connected browsers.

The application consists of:
- `server.js`: Node.js HTTPS server + WebSocket broadcast backend
- `public/index.html`: single-page UI with embedded CSS and JavaScript
- `Dockerfile`: container image build for production deployment
- `docker-compose.yml`: optional service orchestration for local deployment
- `certs/` - SSL certificate and key used for HTTPS (should not be committed; add to `.gitignore`)

## SSL certificate handling

The application requires TLS for the HTTPS server and secure WebSocket endpoint. The certificates in `certs/` are for local use only and should never be published in a public repository. Generate your own self-signed certificates for testing or use a managed TLS certificate through a reverse proxy.

### Local test certificate generation

Create a `certs/` directory and generate a self-signed certificate with OpenSSL:

```bash
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes -keyout certs/key.pem -out certs/cert.pem -days 365 \
  -subj "/CN=localhost"
```

Use these certs only locally. For production, place the TLS terminator in front of the Node.js app and do not check private key material into Git.

## Goals

- Allow users to paste text into a shared clip history
- Keep a list of recent clips available to all connected clients
- Support add, delete, and clear operations across clients in real time
- Persist state only in memory for the current server process

## Architecture

### HTTP server

`server.js` creates an HTTPS server using Node's built-in `https` module.

- Serves a single route: `GET /`
- Returns `public/index.html` as the web UI
- Uses certificates from `certs/key.pem` and `certs/cert.pem`
- Listens on port `3457` by default or from `process.env.PORT`

### WebSocket server

A `ws` WebSocket server runs on top of the HTTPS server.

- Any connected browser receives an `init` message containing:
  - current `clips` array
  - `maxItems` limit (200)
- Clients can send messages to:
  - add a clip: `{ type: 'add', text, source }`
  - delete a clip: `{ type: 'delete', id }`
  - clear all clips: `{ type: 'clear' }`
- Broadcasts the following events to all clients:
  - `add` with clip metadata
  - `delete` with clip id
  - `clear` when history is wiped

### In-memory state

The server maintains two runtime variables:
- `clips`: array of clip objects
- `nextId`: integer used to generate unique clip IDs

Clip object shape:
- `id`: numeric unique identifier
- `text`: full clip text
- `preview`: first 80 characters, with ellipsis if truncated
- `ts`: timestamp in milliseconds
- `source`: client source string, default `unknown`

Behavior rules:
- New clip text is trimmed and ignored if empty
- Duplicate text values are deduplicated by removing existing items with identical `text`
- New clips are inserted at the front of the `clips` array
- `clips` is capped at `MAX_ITEMS` (200)

### Client UI

`public/index.html` is a complete single-page application with style and behavior embedded in one file.

Main UI areas:
- Sidebar with search and clip list
- Main viewer with selected clip preview
- Input area for adding new clips
- Status footer showing connection state

Key client behaviors:
- Connects to the server on page load, selecting `wss://` over HTTPS (the intended deployment) or `ws://` otherwise, based on `location.protocol`
- Receives `init` and renders the existing clip list
- Receives `add`, `delete`, and `clear` messages and updates the UI live
- Sends `add` messages when user pastes text and clicks the button or presses Ctrl+Enter
- Sends `delete` when removing a clip from the sidebar
- Sends `clear` when clearing all clips after user confirmation
- Automatically attempts reconnect every 2.5 seconds when connection drops

### UI details

- Search filters clips by substring match on clip text
- Selection highlights the active clip and displays full text in the viewer
- Copy button copies the selected clip text to the clipboard
- Clear all button removes every clip from server state and all clients
- The UI uses a dark theme with custom styling and responsive layout

## Deployment

### Docker

`Dockerfile` builds the app as a Node.js container:
- Base image: `node:20-alpine`
- Copies `package.json`, installs production dependencies
- Copies `server.js`, `public/`, and `certs/`
- Exposes port `3457`
- Runs `node server.js`

### Docker Compose

`docker-compose.yml` defines a single service:
- Service name: `clipstack`
- Container name: `clipstack`
- Builds from the local directory
- Restarts unless stopped
- Maps host port `3457` to container port `3457`
- Exports `PORT=3457`

## Security and limitations

- HTTPS is mandatory because the UI uses secure context features such as `clipboard.writeText` and `WebSocket` over secure transport.
- Certificates are loaded from `certs/key.pem` and `certs/cert.pem`; these must exist and be valid.
- Do not commit `certs/` or private key material to Git. Use `.gitignore` to exclude this folder from version control.
- No authentication or access control is implemented.
- All data is stored only in memory; restarting the server clears the clip history.
- There is no persistence layer or database.
- Text entries are deduplicated only by exact `text` equality.
- Maximum message payload is set to 512 KB in the WebSocket server.
- The default app design uses a same-origin page and WebSocket connection, so it avoids typical CORS requirements. If you split the UI and backend across domains, ensure the WS origin and proxy settings are configured correctly.

## Runtime flow

1. Server starts and reads SSL certs
2. User opens `https://<host>:3457/`
3. Browser loads `index.html`
4. Client opens a WebSocket connection to the same host
5. Server sends current clip history via `init`
6. User adds a clip
7. Client sends `{ type: 'add', text, source }`
8. Server validates text, creates clip object, updates `clips`, and broadcasts `add`
9. All connected clients receive the clip and refresh their clip list
10. User selects, copies, deletes, or clears clips, and the server broadcasts changes to everyone

## File summary

- `server.js` - HTTPS/websocket backend and in-memory clip store
- `public/index.html` - browser UI, styling, and WebSocket client logic
- `Dockerfile` - container build definition
- `docker-compose.yml` - simple service orchestration
- `package.json` - app metadata and dependency on `ws`

## Notes for maintainers

- To adjust history size, change `MAX_ITEMS` in `server.js`
- To support non-HTTPS local development, the client WebSocket logic would need to be adapted and the app would lose clipboard write support in insecure contexts
- The server currently does not sanitize HTML for clip preview rendering beyond text escaping in the UI
- Adding persistence would require replacing the `clips` in-memory array with a storage layer
