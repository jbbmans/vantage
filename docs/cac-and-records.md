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
| `CAC_EXCLUSIVE` | `true` stops passwords and self-registration being accepted at all |
| `CAC_CA_BUNDLE` | PEM bundle of issuing CAs. Required for `direct` |
| `CAC_TLS_CERT`, `CAC_TLS_KEY` | this server's own certificate. Required for `direct` |
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

### Linking accounts

A card signs in only where an account already carries its EDIPI. Link them in **Owner console →
Personnel**, or let the roster do it. Turning on `CAC_AUTO_PROVISION` creates the account on first
sign-in — but only for someone the roster already lists as active. A valid DoD certificate proves
somebody is in the Department; it does not prove they belong to this command, and the roster is what
says that.

## The personnel feed

Rank, unit, MOS and EAS are facts an upstream system owns. Typed in by hand they drift, and the tool
then loses every argument with the official record.

**Owner console → Personnel** takes a roster extract as CSV, TSV or JSON. An EDIPI column is
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

**Owner console → Retention.**

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

**Owner console → Privacy** builds a data inventory from the live database every time it is opened:
every table, what it is for, the authority for holding it, who can see it, its retention, and each
column's category of personal information. Export it as Markdown for a PIA package.

The reason it is generated rather than written down: a document is correct the day it is written and
slowly stops being true as the schema moves. A column nobody has classified is reported as
**unclassified** rather than quietly omitted, and a declared column that no longer exists is reported
as **stale**. Those gaps are the finding — better surfaced by the tool than by an assessor.

The inventory does not make a privacy determination. It gives a records officer the facts one needs.
