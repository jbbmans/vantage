# Infrastructure questions

Nothing here is assumed. Each question isolates an interface that stays configurable until it is
answered by G-6, NETACT-RES or the hosting organization.

| # | Question | Why it matters | Current assumption in code |
|---|---|---|---|
| I-01 | Which server OS and version will host the pilot (RHEL, Windows Server, other)? | Service install, paths, permissions | Linux service documented first; Windows untested |
| I-02 | Is a container runtime approved, or must it run as a native service? | Packaging | Both possible; Docker never required |
| I-03 | Is Node.js 22 available on the host, or must it ship with the build? | Runtime | Node ≥ 22.18 runs TypeScript directly |
| I-04 | Which PostgreSQL version is available, who administers it, and does it require TLS? | Database target | SQLite today (ADR-0003) |
| I-05 | Which identity path is approved: CAC client certificates at the reverse proxy, an OIDC/SAML provider, or an authenticating proxy that forwards identity headers? | Identity boundary | Local accounts; CAC direct and proxy modes and OIDC exist, off by default; either can be made the only way in (`CAC_EXCLUSIVE`, `VANTAGE_OIDC_EXCLUSIVE`), which closes every password path (ADR-0009) |
| I-06 | Who terminates TLS, and with which certificates? | Transport; cookie security | App expects a reverse proxy; `TRUST_PROXY` must name it |
| I-07 | Is there an approved malware scanner (for example clamd) on the host? | Uploads | `VANTAGE_CLAMD` (a clamd address) or `VANTAGE_SCANNER_COMMAND`; without either, uploads are marked "not scanned" unless `VANTAGE_SCAN_REQUIRED=true` refuses them |
| I-08 | Where must logs go (syslog, SIEM, files), and in what format? | Operations | Audit records to a syslog collector (`VANTAGE_AUDIT_SYSLOG`, udp/tcp/tls, RFC 5424) and/or stdout (`VANTAGE_AUDIT_STDOUT`) |
| I-09 | Backup: who runs it, where it lands, what retention applies? | Recovery | Documented file-level backup of SQLite |
| I-10 | Is any public egress permitted? (Default: none needed.) | Features | None by default. The MCEN profile refuses the public-internet services and lists every outbound connection in the Vantage Administrator console (ADR-0007, I-18, I-19, I-22) |
| I-11 | How must third-party dependencies be delivered (offline mirror, prebuilt artifact, SBOM format)? | Build | `package-lock.json`; SBOM to be generated as CycloneDX |
| I-12 | Which data categories may the pilot hold (CUI, PII)? Who authorizes it? | Data handling | Synthetic only until authorized |
| I-13 | Which Unit Instance isolation model will MCEN host: separate deployments, separate databases, separate schemas, or one strongly isolated shared database? | The data boundary between commands | `VANTAGE_TOPOLOGY=shared` (many Unit Instances, isolated by `org_id` and authorization) or `dedicated` (the database holds exactly one); ADR-0007 |
| I-14 | Where may attachments and imported files be stored (database, approved file share, object store)? | File-storage boundary, backup size | Stored as BLOBs in the same database as the records (`attachments.content`, `source_files.content`) |
| I-15 | Which enterprise mail relay will Vantage use, with what authentication, TLS and sender domain? | Sign-in links, invitations, notices | `VANTAGE_EMAIL_PROVIDER=smtp` with `SMTP_URL`, or `none`; the MCEN profile refuses Resend and direct MX delivery |
| I-16 | Which hostname or hostnames will Vantage answer on, and does the Vantage Administrator console need a host of its own? | Cookies, passkeys, CAC proxy rules | `VANTAGE_APP_URL`, with optional `VANTAGE_CONSOLE_URL` and `VANTAGE_ADMIN_URL`; no public site under MCEN |
| I-17 | How is Vantage deployed and changed on MCEN (pipeline, change control, who presses the button)? | Release and rollback | A container image (`Dockerfile`) or a native Node service; `render.yaml` is the legacy public site only |
| I-18 | Is GenAI.mil approved for this enclave, and which data may be sent to it? | AI features | Off by default; core functions never depend on it; the MCEN profile lists it as needing an approved connection |
| I-19 | Is the marines.mil MARADMIN feed reachable from the enclave, or is there an approved mirror? | MARADMIN reference | Off by default; `VANTAGE_MARADMIN_SOURCE` can point at a mirror |
| I-20 | Who are Vantage Administrators on MCEN, and how is the first one established? | Platform authority | First-run setup with `VANTAGE_SETUP_TOKEN`; `VANTAGE_PLATFORM_OWNERS` names bootstrap owners |
| I-21 | How is a new Unit Instance requested and approved, and by whom? | Provisioning | A Vantage Administrator provisions one in the Vantage Administrator console or with `scripts/provision-instance.ts` from a manifest |
| I-22 | Are Outlook mailbox connections wanted on MCEN, in which Microsoft cloud, and under whose app registration? | Correspondence intake | Off unless `VANTAGE_M365_CLIENT_ID` is set |
| I-23 | For CAC sign-in, which DoD PKI CA bundle and CRL source are approved, and who refreshes the CRLs (or does the enterprise gateway check revocation)? | Refusing a revoked card | `CAC_CA_BUNDLE` and `CAC_CRL_DIR` in `direct` mode, refreshed by a job outside Vantage; the gateway's own check in `proxy` mode (ADR-0009) |
| I-24 | Which credentials are accepted besides the CAC: PIV, PIV-I, ECA, software certificates? Which certificate policy OIDs must a card assert? | Who can sign in, and with what assurance | Any certificate that chains to `CAC_CA_BUNDLE` (or the gateway's trust store); `CAC_REQUIRE_POLICY_OIDS` insists on policies and fails closed |
| I-25 | Is there an authoritative source that can vouch for which EDIPI belongs to which person (the enterprise identity provider's EDIPI claim, a DEERS-sourced roster) before a card is first linked? | The first CAC link of an account is trusted to its Unit Instance today | A Unit Instance links an unproven EDIPI; the person is notified; the first card sign-in, a provider EDIPI claim or roster provisioning proves it, and only Vantage support changes it after (ADR-0009) |
| I-26 | Must a step-up (confirming a sensitive change) be possible without a password or card, for example by re-authenticating at the organization's identity provider or with a passkey? | Accounts with neither a password nor a card | Password or CAC step-up; with neither, the person signs in again |
| I-27 | Should Vantage Administrators assign or remove Unit Managers in a running Unit Instance, or only name the first Lead Unit Manager of one that has none? Who designates a command's Unit Managers, and with what record? | Unit Manager assignment (ADR-0010) | A Vantage Administrator names a Lead Unit Manager only for a Unit Instance with none, never themselves; the instance's Lead Unit Managers assign everything else |
