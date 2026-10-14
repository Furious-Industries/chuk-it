# Security

## Intended use

**WARNING: Keep Chuk-it on a network where you control access.**
A reachable client can read, change, or delete the shared history. The application has no user authentication.
Use a controlled LAN or VPN. Keep port 3457 off the public internet.

An unrelated browser page cannot connect with its own Origin header.
A native program can forge this header. Malware, browser extensions, and other trusted-network users remain a risk.
Do not share a network with untrusted users while Chuk-it is reachable there.

## Operator checks

- Use current Node.js 24 security releases.
- Install dependencies with `npm ci`.
- Review dependency and container advisories before each release.
- Use exact HTTPS origins and a specific interface binding.
- Trust the correct CA on each device. Make sure that each certificate hostname and IP address is correct.
- Keep the CA private key outside the mounted certificate directory.
- Renew certificates before expiry. Replace exposed keys immediately.
- Restrict the port with network controls that apply to your deployment.
- Examine Docker's published-port rules separately from ordinary host firewall rules.
- Examine IPv6 exposure separately.
- Keep guest and untrusted devices outside the permitted network.
- Use a VPN for remote access. Do not configure public port forwarding.
- Use operating-system controls to restrict access to memory, swap, and crash dumps.
- Keep clocks synchronized for the request retry window.

A clipboard can contain passwords, private keys, or personal data. Every connected client receives all stored clips.
Deleting a clip does not remove copies already held by other clients, operating-system clipboards, or external clipboard-history tools.

## Reporting a vulnerability

Do not include credentials or real clipboard contents in a report.
Use GitHub's private vulnerability reporting option if the repository has it enabled.
Otherwise, contact the repository owner privately before you send technical details.
Do not publish an exploit or sensitive test data in a public issue.

Include the affected version, setup, reproduction steps, and expected behavior. Use synthetic data.
See [SECURITY-REVIEW.md](SECURITY-REVIEW.md) for the current review scope and remaining limits.
