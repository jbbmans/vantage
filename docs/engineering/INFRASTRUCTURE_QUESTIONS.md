# Infrastructure questions

Nothing here is assumed. Each question isolates an interface that stays configurable until it is
answered by G-6, NETACT-RES or the hosting organization.

| # | Question | Why it matters | Current assumption in code |
|---|---|---|---|
| I-01 | Which server OS and version will host the pilot (RHEL, Windows Server, other)? | Service install, paths, permissions | Linux service documented first; Windows untested |
| I-02 | Is a container runtime approved, or must it run as a native service? | Packaging | Both possible; Docker never required |
| I-03 | Is Node.js 22 available on the host, or must it ship with the build? | Runtime | Node ≥ 22.18 runs TypeScript directly |
| I-04 | Which PostgreSQL version is available, who administers it, and does it require TLS? | Database target | SQLite today (ADR-0003) |
| I-05 | Which identity path is approved: CAC client certificates at the reverse proxy, an OIDC/SAML provider, or an authenticating proxy that forwards identity headers? | Identity boundary | Local accounts; CAC direct and proxy modes exist, off by default |
| I-06 | Who terminates TLS, and with which certificates? | Transport; cookie security | App expects a reverse proxy; `TRUST_PROXY` must name it |
| I-07 | Is there an approved malware scanner (for example clamd) on the host? | Uploads | `VANTAGE_SCANNER_COMMAND`; without it uploads are marked "not scanned" |
| I-08 | Where must logs go (syslog, SIEM, files), and in what format? | Operations | Structured lines to stdout |
| I-09 | Backup: who runs it, where it lands, what retention applies? | Recovery | Documented file-level backup of SQLite |
| I-10 | Is any public egress permitted? (Default: none needed.) | Features | AI and the MARADMIN feed are off by default |
| I-11 | How must third-party dependencies be delivered (offline mirror, prebuilt artifact, SBOM format)? | Build | `package-lock.json`; SBOM to be generated as CycloneDX |
| I-12 | Which data categories may the pilot hold (CUI, PII)? Who authorizes it? | Data handling | Synthetic only until authorized |
