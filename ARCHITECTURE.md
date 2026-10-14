# Chuk-it architecture

## Components

| File | Function |
| --- | --- |
| `server.js` | HTTPS, connection checks, shared history, and WebSocket messages. |
| `public/index.html` | Page structure. |
| `public/app.js` | Browser state, delivery checks, and clipboard actions. |
| `public/styles.css` | Desktop and mobile styles. |
| `package-lock.json` | Exact dependency version and package integrity value. |
| `config/` | Example certificate configuration. |
| `tests/` | Local server and browser tests. |

The application has one Node.js process. It has no database, external API, analytics, or remote fonts.
The browser loads all application resources from the Chuk-it server.

## Trust boundary

The network controls access. Every reachable native client can claim an approved origin and obtain the shared history.
Origin checks protect the browser boundary. They do not provide authentication.
Do not use the server as a public service.

The server requires an exact configured HTTPS origin and Host header. Both must name the same host and port.
Only `GET /ws` can start a WebSocket connection. The server does not accept forwarded client-address headers.
Rate limits use the socket's remote address. A proxy or NAT can cause several devices to share one limit.

## HTTPS

The server supports TLS 1.2 and TLS 1.3. It restricts TLS 1.2 to ECDHE and AES-GCM cipher suites.
Only `/`, `/app.js`, and `/styles.css` serve files. The server accepts GET and HEAD for these routes.
Unknown routes return 404. Other methods return 405. An unlisted Host returns 403.
Certificate files, source files, and repository metadata have no HTTP route.

Responses use `no-store`, `nosniff`, HSTS, a referrer policy, and a Content Security Policy (CSP).
The CSP blocks inline scripts, inline styles, object content, framing, and unlisted connections.
Cross-Origin-Opener-Policy separates this page from unrelated opener windows.

## Shared history

Each clip contains `id`, `text`, `preview`, `ts`, and `source`.
Clip IDs are random UUIDs. Each server start also creates a new session UUID.
The session UUID identifies a running instance. It is not a login token.

The server uses whitespace checks only to reject empty text. It stores the supplied text without trimming it.
An identical text value replaces its earlier clip. One event contains the replacement and all removed IDs.
The browser transfers selection only when the replacement has exactly the selected text.

The history limit includes JSON escaping and metadata. The server removes the oldest clips first.
A deleted or evicted selection becomes empty. A disconnected browser removes its old history view.
A new connection receives the current snapshot. A server restart cannot reuse an earlier clip ID.

Data remains in memory only. The application does not write clips to files, browser storage, or logs.
This does not guarantee physical erasure from RAM, swap, crash dumps, or an operating-system clipboard.

## Message protocol

The server sends `init` after an approved connection. It contains the session UUID, history, item limit, message limit, and retry duration.

Every mutation contains these fields:

| Field | Value |
| --- | --- |
| `type` | `add`, `delete`, or `clear`. |
| `requestId` | A new UUID for the action. Keep this UUID for retries. |
| `session` | The session UUID from `init`. |
| `createdAt` | The original request time in milliseconds since the Unix epoch. |

`add` also requires string fields `text` and `source`.
`delete` also requires a clip UUID in `id`. `clear` requires no additional field.
The server rejects unknown fields, wrong types, empty text, invalid UUIDs, binary messages, and malformed JSON.
The source label has a 40-character limit. It cannot contain ASCII control characters.

The server sends `add`, `delete`, or `clear` events to connected clients.
It sends an `ack` with the request ID after acceptance. An add acknowledgement also contains the new clip ID.
An error contains a fixed error code. It does not contain clip text or a stack trace.

## Delivery and retry

The browser keeps the draft until it receives the matching acknowledgement.
If the user edits the draft meanwhile, the acknowledgement does not clear the new text.
After five seconds without confirmation, the browser offers a retry. It does not retry automatically.

The server keeps a fingerprint and acknowledgement for each accepted request for ten minutes from its creation time.
An identical retry receives the original acknowledgement. It does not cause another mutation.
A changed payload with the same request ID causes an error.
The server rejects expired requests. It rejects requests created more than 30 seconds in the future.

The receipt store holds at most 2,048 entries. At capacity, the server rejects new mutations until entries expire.
It keeps earlier receipts for their full retry window.
A restart clears receipts and history. Its new session ID prevents automatic replay of an earlier action.

An acknowledgement confirms acceptance at that time. It does not mean that a clip still exists after another client deletes it.
Delete and clear actions also receive acknowledgements. The interface updates their results from server events; it does not retry them automatically.

## Resource limits

| Resource | Limit or behavior |
| --- | --- |
| Stored clips | 200. |
| Stored clip JSON | 16 MiB, including escaping and metadata. |
| Incoming message | 512 KiB, including the JSON envelope. |
| Fragment count | 1,024 per message. |
| Buffered input chunks | 1,024 per connection. |
| Raw TCP connections | 64. |
| WebSocket connections | 32 total; 16 per remote address. |
| Upgrade attempts | 60 per minute per address. |
| Incoming events | 120 per minute per connection; 300 per minute per address. |
| Incoming bytes | 16 MiB per minute per address. |
| Address records | 1,024. Unused records expire after one minute. |
| Outgoing data | 20 MiB per client; 64 MiB across clients. |
| Heartbeat | Ping every 30 seconds. Disconnect if the next check finds no pong. |
| TLS handshake | 10 seconds. |
| HTTP headers and request | 10-second timeouts; Node checks these periodically. |
| Socket inactivity | 15 seconds before upgrade. |
| HTTP keep-alive | 5 seconds. |
| HTTP headers | 8 KiB. |

Rate limits use token buckets. A new bucket permits one minute's allocation as a burst, then refills continuously.
Ping and pong events also use the event limit. Compression is disabled.
The next outgoing payload counts towards the buffer limit before transmission. Slow clients lose their connection.
The browser tries a new connection after 2.5 seconds. It loads a fresh snapshot after approval.

These controls limit application resources. They cannot stop network saturation or guarantee availability against every reachable client.

## Logs

Startup and server errors use fixed messages. Security events use aggregate counts, at most once per heartbeat.
Each summary has a UTC time. Counts cover rejected upgrades, rate limits, invalid messages, protocol errors, and slow readers.
The server does not log origins, IP addresses, request IDs, source labels, or clipboard contents.
Node writes logs to standard output or standard error. The operator controls any Docker or service log retention.

## Technical terms

| Term | Meaning |
| --- | --- |
| Clip | One shared text entry. |
| Origin | A scheme, hostname or IP address, and port. |
| WebSocket | A connection that carries messages in both directions. |
| Acknowledgement | A server message that confirms an accepted request. |
| Receipt | The stored fingerprint and acknowledgement for a request. |
| UUID | A randomly generated identifier. |
| Token bucket | A counter that refills over time and limits traffic. |
| SAN | A certificate field that lists valid hostnames and IP addresses. |
| CA | A certificate authority that signs certificates. |
| CSP | A browser policy that restricts content and connections. |
| LAN | A local area network. |
| VPN | A private network connection through another network. |
| KiB / MiB | 1,024 bytes / 1,048,576 bytes. |
