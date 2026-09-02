# VANTAGE enterprise API v1

The enterprise API is an opt-in, read-only interface for an approved downstream system. It is not a general user API and does not reuse browser sessions.

## Security boundary

- Disabled by default through `integrations.enabled`.
- Every opaque bearer credential is bound to one exact unit and the fixed `unit.shared.read` scope.
- Credentials expire after 1–365 days and can be revoked immediately in the Owner Console.
- The raw credential is returned once. SQLite stores only its SHA-256 digest and a non-secret display prefix.
- Production requests must use HTTPS. Put the credential only in the `Authorization` header.
- Requests are rate-limited per credential and source IP.
- First use and periodic continued use are written to VANTAGE's tamper-evident audit chain.
- Child units are never inherited. Create a separate reviewed credential for each exact unit.

The API excludes private/personal records, notes, evidence links, attachments, rosters, email addresses, readiness data, counseling/evaluation drafts, authentication data, and deleted records.

## Issue a credential

1. Open the restricted Owner Console.
2. Select one exact unit, enter an approved client name and expiry, and generate the credential.
3. Copy the credential immediately; it cannot be retrieved later.
4. Enable the enterprise API in the same panel and save configuration.
5. Store the credential in the downstream system's secret manager, never in source control or a URL.

## Authentication

```http
Authorization: Bearer vnt_int_<prefix>_<secret>
```

An invalid, expired, or revoked credential returns the same `401` response. A request for any unit other than the credential's exact unit returns `404`.

## Endpoints

### Discover the credential's boundary

```http
GET /api/integrations/v1
```

Returns the API version, fixed scope, exact unit ID, and endpoint links.

### Exact-unit metadata

```http
GET /api/integrations/v1/units/{unitId}
```

Returns stable unit identity and echelon fields for the bound unit only.

### Shared activity feed

```http
GET /api/integrations/v1/units/{unitId}/activities?limit=100&cursor=<opaque>
```

The feed is ordered by `updated_at` and `id`. `limit` must be 1–200. Follow `page.next_cursor` until it is `null`; clients must treat the cursor as opaque.

Exported fields are intentionally allowlisted:

- `id`, `subject_id`, `unit_id`, `date`, `title`, `category`, `jepes_area`
- `action_amount`, `action_unit`
- `transaction_value`, `dollar_type`
- `result`, `organization`, `system`, `status`, `created_at`, `updated_at`

`subject_id` is VANTAGE's immutable internal user identifier; names and contact information are not exposed.

### Aggregate summary

```http
GET /api/integrations/v1/units/{unitId}/summary?from=2026-08-01&to=2026-08-31
```

The optional inclusive UTC date window defaults to the previous 30 days and cannot exceed 366 days. The response separates workload `action_amount` from financial `transaction_value`, with category and dollar-type breakdowns.

## Example

```bash
curl --fail --silent --show-error \
  -H "Authorization: Bearer $VANTAGE_INTEGRATION_TOKEN" \
  "https://vantageusmc.com/api/integrations/v1/units/G8-FMRAC/activities?limit=100"
```

## Rotation and incident response

Issue a replacement credential before its expiration, update the downstream secret, verify access, and revoke the old credential. If disclosure is suspected, revoke it immediately and review the unit audit log for `integration_api_read` events. Tokens are bearer credentials: possession is sufficient to use them, so transport and secret storage are part of the authorization boundary.

This interface is an integration foundation, not an RMF/ATO approval by itself. Production use still requires the applicable data-owner, network, cybersecurity, and authorization decisions.
