# Security review — 14 October 2026

## Scope and result

This review covers the HTTPS server, WebSocket protocol, browser interface, dependencies, container configuration, and setup documentation.
The review uses local source inspection and synthetic tests. It does not assess the running home service or network.

The original cross-origin access defect is fixed in this branch.
A foreign browser origin cannot receive history or submit a mutation through a WebSocket connection.
The remaining trust boundary is deliberate: any reachable native client can supply an approved Origin header.

This report is not an OWASP certification or a guarantee against every attack.

## Original findings

| Finding | Change | Evidence |
| --- | --- | --- |
| Any browser origin could read and clear history. | Validate exact Origin, Host, and path before upgrade. | Rejection tests and an actual foreign-origin Chrome connection. |
| A stale selection could refer to another clip. | Random clip IDs, instance IDs, and selection reconciliation. | Duplicate, delete, eviction, clear, reconnect, and restart tests. |
| Trimming changed clipboard text. | Keep text; reject only wholly empty input. | Spaces, CRLF, Unicode, and trailing-newline tests. |
| Sending cleared the draft before acceptance. | Match acknowledgements to request IDs. Keep drafts and bound retries. | Lost-acknowledgement and edited-draft browser tests. |
| Clipboard failures had no useful response. | Provide a selected read-only field for manual copying. | Rejected clipboard API test. |
| The runtime and dependency setup were not reproducible. | Node.js 24, exact `ws` version, lockfile, and `npm ci`. | Clean dependency installation and local tests. |
| Certificate guidance did not cover other devices. | Use SAN entries, a private CA, client trust, and restricted key permissions. | Certificate generation, chain verification, and hostname tests. |
| Resource controls were incomplete. | Add rate, connection, fragment, receipt, heartbeat, and buffer limits. | Boundary tests, malformed traffic, and a history snapshot above 8 MiB. |

## OWASP mapping

The mapping uses [ASVS 5.0.0](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/docs_en/OWASP_Application_Security_Verification_Standard_5.0.0_en.json).
It also uses the [WebSocket Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html)
and [WSTG v4.2, WSTG-CLNT-10](https://wstg.owasp.org/v4.2/4-Web_Application_Security_Testing/11-Client-side_Testing/10-Testing_WebSockets/).

| Control | Assessment and evidence |
| --- | --- |
| ASVS V4.4.1–V4.4.2; WSTG-CLNT-10 | HTTPS/WSS only. Exact origin checks precede history access. Foreign, absent, null, malformed, and lookalike origins fail. |
| ASVS V1.5.2; V2.4.1 | Strict message fields and types. Bounded traffic, storage, connections, fragments, and retries. Regression tests pass. |
| ASVS V3.2.2–V3.2.3 | Text-only DOM writes and scoped variables. Injection payloads remain text in Chrome. |
| ASVS V3.4.1–V3.4.6, V3.4.8 | Restrictive response headers. No CORS grants. Header tests and browser CSP checks pass. HSTS excludes subdomains. |
| ASVS V12.1.1–V12.1.2 | TLS 1.2/1.3 and restricted cipher suites. Old TLS and an untrusted CA fail. |
| ASVS V13.1.1–V13.1.4 | Architecture records connections, limits, failures, retries, and key renewal. |
| ASVS V13.3.2, V13.4.1–V13.4.7 | Restricted key mount and file routes. No public source, metadata, debugging, or directory routes. |
| ASVS V14.2.3, V14.2.5, V14.3.2 | No third-party runtime calls. No-store responses and explicit 404 routes. |
| ASVS V15.2.4 | Exact dependency, registry URL, and integrity value in the lockfile. |
| ASVS V16.2.3, V16.2.5, V16.4.1, V16.5.1 | Fixed errors and aggregate security counts. No clipboard contents or supplied strings in logs. |

## Whole-application checks and exclusions

- Authentication, account recovery, roles, cookies, and login sessions do not exist.
  ASVS V4.4.3–V4.4.4 and the account controls therefore do not describe this shared-network design.
  The instance UUID provides replay separation, not identity or authorization.
- SQL, shell execution, user-controlled file access, uploads, XML, GraphQL, and outbound URL requests do not exist in the application.
  Source inspection found no corresponding injection path. Test scripts invoke OpenSSL locally with fixed argument arrays.
- The browser uses text nodes. It does not render clip text as markup or executable code.
- The server does not trust forwarded IP headers. It does not implement a reverse-proxy authentication boundary.
- The history intentionally keeps clips in RAM. It has no per-user separation or expiry timer.
- Security logs contain counts, not actor identities. Full audit attribution and centralized log protection remain outside this design.
- CSP violation reporting has no remote endpoint. No third-party collector receives browser data.
- HSTS does not include subdomains because the operator can use other services under the same private domain.
- Hardware key storage, mTLS, ECH, and OCSP are outside the private-CA setup.
- An unexpected fatal process error requires restart. The application does not continue after arbitrary uncaught exceptions.
  A restart loses the volatile history. Compose has a restart policy.

The 512 KiB message limit supports code and prompt transfer. It exceeds the cheat sheet's typical smaller-message example.
The 20 MiB client output limit permits the bounded 16 MiB history snapshot.
The application measures the next payload and the total queued output before each send.

## Runtime and dependency review

The test runtime is Node.js 24.21.0. Its archive hash matched the official SHA-256 list.
Node.js lists version 24 as LTS and version 20 as end of life.
See the [Node.js release schedule](https://nodejs.org/en/about/previous-releases).

The lockfile pins `ws` 8.22.0. The production dependency tree contains only `ws`; optional native packages are absent.
The installed version is outside the affected ranges in these four official advisories:

| Advisory | Fixed release in the relevant major version |
| --- | --- |
| [GHSA-96hv-2xvq-fx4p](https://github.com/websockets/ws/security/advisories/GHSA-96hv-2xvq-fx4p): fragment memory exhaustion. | 8.21.0. |
| [GHSA-58qx-3vcg-4xpx](https://github.com/websockets/ws/security/advisories/GHSA-58qx-3vcg-4xpx): uninitialized memory disclosure. | 8.20.1. |
| [GHSA-3h5v-q93c-6h6q](https://github.com/websockets/ws/security/advisories/GHSA-3h5v-q93c-6h6q): excessive HTTP headers. | 8.17.1. |
| [GHSA-6fc8-4gx4-v693](https://github.com/websockets/ws/security/advisories/GHSA-6fc8-4gx4-v693): subprotocol regular expression. | 7.4.6; the affected range predates version 8. |

This is a dated advisory check. It does not establish the absence of undisclosed defects.
No hosted scanner received repository source or dependency data. Remote npm audit submissions are disabled.

## Verification

- `npm ci`: reproducible installation with install scripts disabled.
- `npm test`: 20 passing server and certificate tests.
- `npm run test:browser`: 17 passing Chrome, HTTPS, and WebSocket checks.
- Desktop viewport: 1365 × 900.
- Mobile viewports: 390 × 844 and 844 × 390.
- Browser checks cover exact text, injection, selection, delivery, retry, disconnect, restart, and foreign-origin access.
- Local evidence: `artifacts/security-hardening/evidence/`.

The browser test substitutes the clipboard write function. It checks success and rejection without reading or changing the system clipboard.
The certificate test runs the documented CA and SAN procedure. It checks the certificate chain and both name types.

## Remaining verification limits

Docker is unavailable in this workspace. The Dockerfile and Compose configuration received source review, not a container run or image scan.
Test the container key permissions and network rules on the intended host before deployment.
See [Docker's firewall guidance](https://docs.docker.com/engine/network/packet-filtering-firewalls/).

The browser tests use Chrome emulation. They do not replace tests on Safari, Firefox, Android, or a physical iPhone.
The isolated Chrome profile accepts only the generated test certificate's public-key fingerprint.
No device trust store was changed. The real LAN, VPN, firewall, and certificate installation remain untested.

Tests cover configured limits. They do not constitute prolonged load testing or protection against network-level denial of service.
Reachable native clients, compromised devices, browser extensions, and leaked CA keys remain material risks.

## Documentation checks

The writing review used [ASD-STE100 Issue 9](https://www.asd-ste100.org/assets/files/ASD-STE100_ISSUE9.pdf), dated 15 January 2025.
The review applied short sentences, active voice, imperative steps, consistent technical terms, and explicit warnings.
The architecture document defines application-specific technical terms.

A local sentence-length check and selected dictionary checks support this review.
A qualified STE checker has not verified every word, permitted meaning, and part of speech.
This report therefore makes no claim of certified or complete ASD-STE100 conformance.
