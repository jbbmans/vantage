# GenAI.mil integration

VANTAGE uses GenAI.mil through a single server-side gateway. Browser code never receives the API key and never calls `api.genai.mil` directly. AI output is advisory: VANTAGE does not automatically save it, change a record, approve personnel action, assign a classification, or make an access-control decision.

## Capabilities and scope

| Workflow | Input sent to GenAI.mil | Authorization boundary |
| --- | --- | --- |
| Quick Log extraction | Text the user entered | Signed-in user; explicit button |
| Goal builder | Objective/context the user entered | Signed-in user; explicit button |
| Writing desk | Source facts the user entered | Signed-in user; explicit button |
| Personal review | Selected fields from the user's own activities, goals, and tasks | `user_id` equals the session user |
| Record quality | Selected fields from the user's own recent activities | `user_id` equals the session user |
| Evaluation narrative | Selected fields from the user's own activities in the requested period | `user_id` equals the session user |
| MARADMIN summary | Cached public message metadata/summary | Signed-in user; official link remains authoritative |
| Command brief | Counts and totals from one exact unit | Requires `EXPORT_DATA` in that exact unit |

Names, usernames, email addresses, attachments, evidence links, private notes, audit payloads, incident reports, rosters, credentials, and session values are excluded from record-driven prompts. Command briefs use aggregates only. Parent-command hierarchy never expands the authorized unit.

## Deployment

Set the secret in the hosting environment:

```text
VANTAGE_GENAI_API_KEY=<GenAI.mil API key>
VANTAGE_AI_ENABLED=true
```

Optional settings:

```text
VANTAGE_GENAI_MODEL=gemini-2.5-flash
VANTAGE_GENAI_MAX_OUTPUT_TOKENS=1800
VANTAGE_GENAI_TIMEOUT_MS=45000
VANTAGE_GENAI_REQUESTS_PER_MINUTE=100
VANTAGE_GENAI_PER_USER_REQUESTS_PER_MINUTE=12
VANTAGE_GENAI_DAILY_TOKEN_BUDGET=45000000
VANTAGE_GENAI_PER_USER_DAILY_TOKENS=250000
```

These defaults reserve headroom below the GenAI.mil allocation of 120 requests per minute and 50 million tokens per day. The Instance Operator can enable/disable AI and adjust the model, maximum output, and per-user budget in the Owner Console. The base URL is pinned to `https://api.genai.mil/v1`.

Do not put the key in `config/app.yaml`, a committed `.env` file, browser storage, or frontend source. Rotate it immediately if exposed.

For the existing Render service, add `VANTAGE_GENAI_API_KEY` manually in **Dashboard → vantage → Environment** and redeploy. `sync: false` in `render.yaml` prevents Git-based secret synchronization but does not prompt again when an existing Blueprint is updated.

## Eight-hour key lock

When GenAI.mil returns `401` with a valid `genai.mil` unlock URL, VANTAGE gives users a generic unavailable response and exposes the validated URL only in the Owner Console. The Instance Operator must open it and unlock the key. VANTAGE never follows an unlock URL automatically.

## Logging, retention, and handling

VANTAGE stores daily request/token totals by user and workflow. Audit entries contain only workflow, request ID, model, token count, success/failure, and the advisory-output marker. Prompt and response bodies are not retained by the VANTAGE gateway.

Confirm GenAI.mil tenant retention and the approved data/classification boundary with the relevant Authorizing Official or ISSM before enabling operational-data use. The UI warns users not to submit classified material or content outside that boundary.

## Failure and safety behavior

- `401`: mark the key locked; unlock URL is operator-only.
- `403`/`404`: key or model is not authorized.
- `429`: return a retry interval when available.
- timeout/network/`5xx`: change no records and return a retryable failure.
- non-JSON output: reject it; apply no suggestion.

Record content is placed in a JSON evidence envelope and labeled untrusted data, not instructions. Prompts prohibit invented figures and promotion, disciplinary, eligibility, readiness, classification, and access-control decisions. Human verification remains mandatory.
