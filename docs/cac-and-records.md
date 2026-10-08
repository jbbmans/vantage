# CAC sign-in, the personnel feed, and records management

Three capabilities that an instance turns on when it has the surrounding infrastructure, and that
cost nothing when it does not. All three are off by default.

## CAC / PIV sign-in

### What it does

Signs a person in from the certificate on their card. The identity is the **EDIPI and nothing else**
— read from the subject alternative name, and cross-checked against the common name when the
certificate carries it in both. A certificate whose two names disagree is refused. Names are never
used to find an account: they collide, they change, and two Marines called `SMITH.JOHN.A` would
eventually sign in as each other.

A card counts as **both factors** — something you have, plus the PIN that unlocked it — so an account
with TOTP enabled is not challenged a second time.

### Choosing a mode

| | `direct` | `proxy` |
| --- | --- | --- |
| Who terminates TLS | Vantage | nginx, Apache, a load balancer |
| Chain validated by | Node, against `CAC_CA_BUNDLE` | the gateway |
| Revocation checked by | Node, against the CRLs in `CAC_CRL_DIR` | the gateway (OCSP or CRL) |
| Trust rests on | the TLS handshake | a shared secret between gateway and app |

**`direct`** is stronger and simpler to reason about: Node validates the chain during the handshake
and `socket.authorized` is the verdict. Use it when Vantage is the edge.

**`proxy`** fits an existing PKI gateway. Its security rests entirely on the channel carrying the
certificate header, so:

- `CAC_PROXY_SECRET` is **required** and must be at least 32 characters. The process refuses to start
  without it rather than starting insecurely. Without it, `X-Client-Cert: <any certificate>` would be
  a sign-in as anybody, from anyone who can reach the origin.
- The gateway must also send its verification verdict. A request with no verdict is refused.
- A request that fails the secret check is treated as if it carried no certificate at all, so a prober
  cannot learn whether they guessed the header name.

**Put the origin behind the gateway at the network layer as well.** The shared secret is a second
line, not the only one.

### Settings

| Variable | Meaning |
| --- | --- |
| `CAC_MODE` | `off` (default), `direct`, `proxy` |
| `CAC_EXCLUSIVE` | `true` stops passwords being accepted at all: sign-in, self-registration, password resets, creating an account from an invitation, emailed sign-in details, and the password step-up. The card confirms sensitive changes instead |
| `CAC_CA_BUNDLE` | PEM bundle of issuing CAs. Required for `direct` |
| `CAC_TLS_CERT`, `CAC_TLS_KEY` | this server's own certificate. Required for `direct` |
| `CAC_CRL_DIR` | directory of the issuing CAs' CRLs (DER `.crl` as DoD publishes them, or PEM). Required for `direct`. A card whose serial is listed, or whose issuer has no CRL in the directory, is refused. Keep it fresh with a scheduled download; Vantage reloads it within ten minutes of a change, and keeps the previous set if a refresh is unreadable |
| `CAC_REVOCATION` | `off` accepts cards without the revocation check in `direct` mode. It has to be set on purpose |
| `CAC_CERT_HEADER` | default `x-client-cert`. nginx: `ssl_client_escaped_cert` |
| `CAC_VERIFY_HEADER` / `CAC_VERIFY_SUCCESS` | default `x-client-verify` / `SUCCESS`. nginx: `ssl_client_verify` |
| `CAC_PROXY_SECRET_HEADER` / `CAC_PROXY_SECRET` | the shared secret. Required for `proxy` |
| `CAC_REQUIRE_POLICY_OIDS` | comma-separated certificate policy OIDs to insist on |
| `CAC_AUTO_PROVISION` | create an account on first sign-in, **only** for an EDIPI the roster lists |

`CAC_REQUIRE_POLICY_OIDS` is how a deployment insists on a hardware credential rather than a software
certificate. It is read from the DER, and **fails closed**: a certificate whose policies cannot be
read does not satisfy a requirement. A control that passes when it cannot see is not a control.

### nginx

```nginx
location /api/auth/cac {
    proxy_set_header X-Client-Cert   $ssl_client_escaped_cert;
    proxy_set_header X-Client-Verify $ssl_client_verify;
    proxy_set_header X-Cac-Proxy-Secret "<the same value as CAC_PROXY_SECRET>";
    proxy_pass http://vantage;
}
```

with `ssl_verify_client optional;` and `ssl_client_certificate /etc/ssl/dod-bundle.pem;` on the server.

`location /api/auth/cac` is a prefix match, so it also forwards the card for `/api/auth/cac/step-up`. If
the gateway lists exact paths instead, add that one. In `direct` mode the server asks for a certificate
on every connection, so both paths see the card without more configuration.

### Confirming a sensitive change with the card

Changes that ask for a recent confirmation (security settings, exports, the admin dashboard, joining
another command) accept the card in place of a password: **Confirm with your CAC** in the dialog, which
calls `POST /api/auth/cac/step-up`. The card goes through the same checks as a sign-in, and it must
carry the EDIPI the signed-in account carries. Somebody else's valid card is refused, and so is any card
on an account with no linked card. Every refusal is on the audit trail as `cac_step_up_refused`, and
every confirmation as `cac_step_up`. Accounts the card or the roster created have no password, so
before this they could not confirm anything.

### Linking accounts

A card signs in only where an account already carries its EDIPI. An organization links its members in
**Owner console → People → EDIPI**, or lets the roster do it. Turning on `CAC_AUTO_PROVISION` creates the account on first
sign-in — but only for someone an organization's roster already lists as active, and seats the new account in that
organization (the unit its row names, or its top unit). A valid DoD certificate proves
somebody is in the Department; it does not prove they belong to this command, and the roster is what
says that.

**A proven EDIPI is the person's sign-in key** (ADR-0009). The first time their card signs in or
confirms a change, or the organization's identity provider asserts the EDIPI, Vantage records that it
is proven (`users.edipi_verified_at`). From then on no Unit Instance can change or clear it, not even
on its own administrators' accounts. Vantage support corrects it in the admin dashboard
(**Accounts → CAC link**), with a reason; the person's sessions end and they are told. An EDIPI typed
in by an administrator and never used is not proven yet, so the person's own Unit Instance can still
correct a typing mistake. Each link and correction tells the person, so a card linked to their account
that is not theirs is something they hear about.

**A Marine who transfers keeps their account and its EDIPI.** The new command invites their address,
and they sign in and accept the invitation there. Their card works at the new command from the moment
they join.

## Organization sign-in (Entra ID and other OIDC providers)

Vantage can hand sign-in to the organization's identity provider over OpenID Connect: Microsoft Entra ID
(commercial, GCC High or DoD), Okta, Keycloak, Login.gov or any provider that publishes a discovery document.
The person is sent to the provider's page, signs in there with whatever the provider requires (CAC, phone,
password and MFA), and is sent back already signed in. Vantage never sees their provider password.

### How it is checked

- Authorization code flow with PKCE (S256). The `state` and `nonce` are stored only as digests, expire after
  ten minutes, and are used once, so a callback cannot be replayed or forged from another browser.
- The ID token's signature is checked against the provider's published keys (RS256/384/512, PS256/384,
  ES256/384). `none` and HMAC-signed tokens are refused. Issuer, audience, authorized party, expiry,
  not-before, issued-at and nonce are all checked, with two minutes of clock tolerance.
- The provider's discovery document must name the issuer that is configured, and every endpoint must be HTTPS.
- Every rejection is written to the audit log as `oidc_rejected` with the reason. The browser is told only a
  short code, which the sign-in page turns into a plain sentence.

### Settings

| Variable | Meaning |
| --- | --- |
| `VANTAGE_OIDC_ISSUER` | The issuer URL. Setting it turns organization sign-in on. Entra ID: `https://login.microsoftonline.com/<tenant id>/v2.0`, or `login.microsoftonline.us` for GCC High and DoD. Use the tenant's own issuer, not `common` or `organizations`. |
| `VANTAGE_OIDC_CLIENT_ID` | The application (client) ID registered with the provider. Required. |
| `VANTAGE_OIDC_CLIENT_SECRET` | The client secret, if the registration is a confidential client. |
| `VANTAGE_OIDC_SCOPES` | Default `openid profile email`. |
| `VANTAGE_OIDC_LABEL` | The button text. Defaults to "Sign in with Microsoft" for Entra ID, otherwise "Sign in with your organization". |
| `VANTAGE_OIDC_LINK` | How a first sign-in finds its account: `email` (default), `edipi`, or `none` (only accounts already linked). |
| `VANTAGE_OIDC_EDIPI_CLAIM` | The claim that carries the EDIPI. Required with `VANTAGE_OIDC_LINK=edipi`. |
| `VANTAGE_OIDC_TRUST_EMAIL` | Treat the provider's address as verified even without `email_verified`. On by default for Entra ID, whose tenant controls its users' addresses. |
| `VANTAGE_OIDC_AUTO_PROVISION` | Create the account on first sign-in for someone the personnel roster lists as active (needs the EDIPI claim). |
| `VANTAGE_OIDC_EXCLUSIVE` | Turn password sign-in, self-registration, password resets and account creation from an invitation off. Passkeys and CAC, where enabled, still work. |

Register these redirect URIs with the provider, one for each face that people sign in on:
`https://<app host>/api/auth/oidc/callback` and, for each console with a host of its own,
`https://<console host>/api/auth/oidc/callback` and `https://<admin host>/api/auth/oidc/callback`.

The demo refuses organization sign-in, and a plain `http` issuer is refused outside the test suite.

### Linking accounts

The first time someone signs in, Vantage looks for their account by verified email address (or EDIPI, if
configured) and records the provider's subject on it. After that the account is found by subject alone, so
a changed address at the provider does not lose the link. An account already linked to one subject is never
re-linked to another with the same address; that sign-in is refused and audited. With
`VANTAGE_OIDC_AUTO_PROVISION`, a person with no account gets one only if the roster lists their EDIPI as
active, for the same reason as with a CAC: the provider proves who someone is, the roster says they belong here. When `VANTAGE_OIDC_EDIPI_CLAIM` carries the
EDIPI the account holds, the sign-in proves that EDIPI just as a card would.

If the DoD consent banner is on, the person accepts it on the Vantage sign-in page before leaving for the
provider, and the server refuses a sign-in that did not.

## The personnel feed

Rank, unit, MOS and EAS are facts an upstream system owns. Typed in by hand they drift, and the tool
then loses every argument with the official record.

Each organization loads its own: **Owner console → Personnel feed** takes a roster extract as CSV, TSV or JSON. An EDIPI column is
required; other columns are matched by the names personnel systems usually export (`Grade`, `PMOS`,
`RUC`, and so on).

- **Planning is always offered before applying**, and the plan shows every field that would change.
- **A sync never destroys.** Somebody who leaves the roster is marked separated and their account is
  deactivated. The record survives, because it still has to be answerable to them and to a records
  request.
- **A mass separation stops and asks.** An extract that would separate more than 20% of the roster is
  held back, because a truncated or wrongly-filtered file looks exactly like a command emptying.
- **Fields the feed owns stop being self-editable**, refused server-side rather than hidden in the
  client.
- **Every changed field is audited** with its before and after, so a person whose rank changed under
  them can be told who changed it and where it came from.

The **divergence report** lists accounts with no EDIPI, accounts the roster does not list, and roster
entries with no account. None of it is resolved automatically; each one is a person's judgement.

## Records management

**Owner console → Retention** (an organization's records officers), over the work shared with its units. Vantage staff can place a hold over the whole service in **Admin dashboard → Legal holds**.

A schedule states how long a kind of record is kept, what happens then, and the authority it is kept
under — a citation field rather than a comment, because a schedule without one is somebody's guess.

Dispositions:

- **Report only** — never acts. The safe default.
- **Anonymize** — replaces the free text with a marker that says why it is gone, keeping the dates and
  quantities so aggregate history stays true.
- **Destroy** — removes the row.

Properties worth knowing:

- **Nothing disposes by default.** A schedule arrives disabled. An instance that never opens this page
  never loses a row.
- **A legal hold always wins**, and is checked at the moment of action, so a hold placed during a run
  still stops it. An instance-wide hold stops everything.
- **Every run is recorded, including the ones that did nothing** — and including runs a hold blocked.
  A disposition log with gaps cannot answer the question it exists to answer.
- Disposition is a preview unless the caller explicitly asks to apply.

## The privacy inventory

**Owner console → Privacy** (and, for the whole service, **Admin dashboard → Privacy**) builds a data inventory from the live database every time it is opened:
every table, what it is for, the authority for holding it, who can see it, its retention, and each
column's category of personal information. Export it as Markdown for a PIA package.

The reason it is generated rather than written down: a document is correct the day it is written and
slowly stops being true as the schema moves. A column nobody has classified is reported as
**unclassified** rather than quietly omitted, and a declared column that no longer exists is reported
as **stale**. Those gaps are the finding — better surfaced by the tool than by an assessor.

The inventory does not make a privacy determination. It gives a records officer the facts one needs.
