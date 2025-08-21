# Security Policy

Thank you for helping keep Steam Account Reputation Check secure.

## Supported Versions

We currently provide security updates for:
- Main branch (latest)
- Latest published Docker image: `ghcr.io/kf637/steam-account-reputation-check:latest`

Older tags/releases may receive fixes on a best-effort basis only.

## Reporting a Vulnerability

Please do not file public issues for security reports.

- Use GitHub’s “Report a vulnerability” in the repository Security tab to open a private advisory with the maintainers.
- If that option is unavailable, create a minimal reproduction on your own fork and share details privately via the advisory once enabled.

Include as much detail as possible:
- Affected version/commit hash and environment (Docker vs local Node)
- Reproduction steps, proof-of-concept, and impact
- Any logs, configs, or non-sensitive environment details that help triage

We will acknowledge receipt within 2 business days and keep you updated at least weekly until resolution.

## Scope

In scope:
- Server and proxy code (`server.js`) and HTTP endpoints
- Client application (`index.html`, `steam-trust-app.js`, `lib/*`, `style.css`)
- Container build (`Dockerfile`) and default runtime configuration

Out of scope:
- Vulnerabilities exclusively in third‑party dependencies (please also report upstream)
- Misconfigurations outside this repository (e.g., reverse proxies, Cloudflare settings)
- Social engineering and physical attacks

## Disclosure & Fix Process

- We will investigate, verify impact/severity, and prepare a fix.
- When practical, we will publish a patch release and update the container image.
- We credit reporters in release notes (optional; tell us if you prefer anonymity).
- CVE: If the issue meets criteria, we’ll request a CVE as part of the GitHub advisory flow.

## Hardening Guidance

- Run the latest image or main branch
- Set `STEAM_API_KEY` via environment variables or a secrets store
- Place the app behind a trusted reverse proxy (e.g., Cloudflare) and enable HTTPS
- Keep dependencies updated and rebuild images regularly

Thanks again for responsibly disclosing issues and helping improve the project’s security.
