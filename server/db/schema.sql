-- Vantage 5 schema. Fresh install; migrations extend this through server/db/migrations.ts.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ranks (
  id    TEXT PRIMARY KEY,
  grade TEXT NOT NULL,
  abbr  TEXT NOT NULL,
  name  TEXT NOT NULL,
  tier  TEXT NOT NULL,
  sort  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id                   TEXT PRIMARY KEY,
  username             TEXT NOT NULL COLLATE NOCASE UNIQUE,
  email                TEXT COLLATE NOCASE,
  password_hash        TEXT NOT NULL,
  first_name           TEXT NOT NULL,
  last_name            TEXT NOT NULL,
  middle_initial       TEXT,
  rank_id              TEXT REFERENCES ranks(id),
  mos                  TEXT,
  eas                  TEXT,
  is_operator          INTEGER NOT NULL DEFAULT 0 CHECK (is_operator IN (0, 1)),
  active               INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
  totp_secret          TEXT,
  totp_enabled         INTEGER NOT NULL DEFAULT 0 CHECK (totp_enabled IN (0, 1)),
  prefs                TEXT NOT NULL DEFAULT '{}',
  digest_last_sent_at  TEXT,
  last_login_at        TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS readiness (
  user_id           TEXT PRIMARY KEY REFERENCES users(id),
  pft_score         INTEGER,
  cft_score         INTEGER,
  rifle_qual        TEXT,
  mcmap_belt        TEXT,
  ceus              REAL,
  college_credits   REAL,
  degree            TEXT,
  pme_complete      TEXT,
  cmd_character     REAL,
  cmd_mos           REAL,
  cmd_leadership    REAL,
  fitrep_period_end TEXT,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id),
  created_at          TEXT NOT NULL,
  last_used_at        TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  sudo_until          TEXT,
  method              TEXT NOT NULL DEFAULT 'password',
  ip                  TEXT,
  user_agent          TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS passkeys (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  public_key   BLOB NOT NULL,
  counter      INTEGER NOT NULL DEFAULT 0,
  transports   TEXT NOT NULL DEFAULT '[]',
  device_type  TEXT,
  backed_up    INTEGER NOT NULL DEFAULT 0,
  name         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_passkeys_user ON passkeys(user_id);

CREATE TABLE IF NOT EXISTS recovery_codes (
  id        TEXT PRIMARY KEY,
  user_id   TEXT NOT NULL REFERENCES users(id),
  code_hash TEXT NOT NULL,
  used_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_recovery_user ON recovery_codes(user_id);

CREATE TABLE IF NOT EXISTS tokens (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('reset', 'invite', 'login_mfa', 'email_change')),
  token_hash TEXT NOT NULL UNIQUE,
  user_id    TEXT REFERENCES users(id),
  email      TEXT,
  payload    TEXT NOT NULL DEFAULT '{}',
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tokens_kind ON tokens(kind, expires_at);

CREATE TABLE IF NOT EXISTS units (
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  short_name    TEXT,
  echelon       TEXT NOT NULL DEFAULT 'section',
  location      TEXT,
  parent_id     TEXT REFERENCES units(id),
  owner_user_id TEXT REFERENCES users(id),
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_units_parent ON units(parent_id);
CREATE INDEX IF NOT EXISTS idx_units_owner ON units(owner_user_id);

CREATE TABLE IF NOT EXISTS unit_members (
  user_id    TEXT NOT NULL REFERENCES users(id),
  unit_id    TEXT NOT NULL REFERENCES units(id),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  billet     TEXT,
  joined_at  TEXT NOT NULL,
  invited_by TEXT REFERENCES users(id),
  PRIMARY KEY (user_id, unit_id)
);
CREATE INDEX IF NOT EXISTS idx_unit_members_unit ON unit_members(unit_id);

CREATE TABLE IF NOT EXISTS roles (
  id          TEXT PRIMARY KEY,
  unit_id     TEXT NOT NULL REFERENCES units(id),
  key         TEXT,
  name        TEXT NOT NULL,
  description TEXT,
  color       TEXT,
  position    INTEGER NOT NULL DEFAULT 0,
  permissions INTEGER NOT NULL DEFAULT 0,
  is_default  INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  is_system   INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_roles_unit ON roles(unit_id);

CREATE TABLE IF NOT EXISTS member_roles (
  user_id    TEXT NOT NULL REFERENCES users(id),
  role_id    TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  unit_id    TEXT NOT NULL REFERENCES units(id),
  granted_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, role_id)
);
CREATE INDEX IF NOT EXISTS idx_member_roles_unit ON member_roles(unit_id, user_id);
CREATE TRIGGER IF NOT EXISTS member_roles_unit_match
BEFORE INSERT ON member_roles
FOR EACH ROW WHEN NOT EXISTS (SELECT 1 FROM roles r WHERE r.id = NEW.role_id AND r.unit_id = NEW.unit_id)
BEGIN
  SELECT RAISE(ABORT, 'role and grant unit mismatch');
END;

CREATE TABLE IF NOT EXISTS activities (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id),
  unit_id        TEXT REFERENCES units(id),
  visibility     TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'unit')),
  date           TEXT,
  title          TEXT NOT NULL,
  category       TEXT,
  eval_area      TEXT,
  quantity       REAL,
  unit_label     TEXT,
  dollar_amount  REAL,
  dollar_type    TEXT,
  result         TEXT,
  organization   TEXT,
  system         TEXT,
  project_id     TEXT,
  status         TEXT NOT NULL DEFAULT 'completed',
  notes          TEXT,
  evidence_links TEXT NOT NULL DEFAULT '[]',
  fingerprint    TEXT,
  version        INTEGER NOT NULL DEFAULT 1,
  frozen_at      TEXT,
  deleted_at     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activities_user_date ON activities(user_id, date);
CREATE INDEX IF NOT EXISTS idx_activities_unit ON activities(unit_id, visibility, date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_activities_fingerprint ON activities(user_id, fingerprint) WHERE fingerprint IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  unit_id      TEXT REFERENCES units(id),
  visibility   TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'unit')),
  name         TEXT NOT NULL,
  description  TEXT,
  status       TEXT NOT NULL DEFAULT 'active',
  priority     TEXT NOT NULL DEFAULT 'medium',
  progress     REAL NOT NULL DEFAULT 0,
  start_date   TEXT,
  target_date  TEXT,
  organization TEXT,
  version      INTEGER NOT NULL DEFAULT 1,
  frozen_at    TEXT,
  deleted_at   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_projects_unit ON projects(unit_id, visibility);

CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  assignee_id TEXT REFERENCES users(id),
  unit_id     TEXT REFERENCES units(id),
  visibility  TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'unit')),
  project_id  TEXT,
  title       TEXT NOT NULL,
  notes       TEXT,
  status      TEXT NOT NULL DEFAULT 'planned',
  priority    TEXT NOT NULL DEFAULT 'medium',
  due_date    TEXT,
  version     INTEGER NOT NULL DEFAULT 1,
  frozen_at   TEXT,
  deleted_at  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);
CREATE INDEX IF NOT EXISTS idx_tasks_unit ON tasks(unit_id, visibility);

CREATE TABLE IF NOT EXISTS goals (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  assignee_id   TEXT REFERENCES users(id),
  unit_id       TEXT REFERENCES units(id),
  visibility    TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'unit')),
  title         TEXT NOT NULL,
  description   TEXT,
  type          TEXT NOT NULL DEFAULT 'quarterly',
  category      TEXT,
  metric        TEXT NOT NULL DEFAULT 'manual',
  current_value REAL NOT NULL DEFAULT 0,
  target_value  REAL,
  unit_label    TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  period_start  TEXT,
  period_end    TEXT,
  version       INTEGER NOT NULL DEFAULT 1,
  frozen_at     TEXT,
  deleted_at    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goals_user ON goals(user_id);
CREATE INDEX IF NOT EXISTS idx_goals_unit ON goals(unit_id, visibility);

CREATE TABLE IF NOT EXISTS trainings (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  unit_id    TEXT REFERENCES units(id),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'unit')),
  date       TEXT,
  title      TEXT NOT NULL,
  type       TEXT,
  hours      REAL,
  provider   TEXT,
  status     TEXT NOT NULL DEFAULT 'completed',
  notes      TEXT,
  version    INTEGER NOT NULL DEFAULT 1,
  frozen_at  TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trainings_user ON trainings(user_id);
CREATE INDEX IF NOT EXISTS idx_trainings_unit ON trainings(unit_id, visibility);

CREATE TABLE IF NOT EXISTS awards (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL REFERENCES users(id),
  unit_id               TEXT REFERENCES units(id),
  visibility            TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'unit')),
  date                  TEXT,
  name                  TEXT NOT NULL,
  type                  TEXT NOT NULL DEFAULT 'personal_award',
  status                TEXT NOT NULL DEFAULT 'planned',
  recommending_official TEXT,
  approving_authority   TEXT,
  citation              TEXT,
  notes                 TEXT,
  submitted_at          TEXT,
  approved_at           TEXT,
  presented_at          TEXT,
  version               INTEGER NOT NULL DEFAULT 1,
  frozen_at             TEXT,
  deleted_at            TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_awards_user ON awards(user_id);
CREATE INDEX IF NOT EXISTS idx_awards_unit ON awards(unit_id, visibility);

CREATE TABLE IF NOT EXISTS counselings (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  counselor_id    TEXT REFERENCES users(id),
  counselor_name  TEXT,
  unit_id         TEXT REFERENCES units(id),
  visibility      TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'unit')),
  date            TEXT,
  type            TEXT NOT NULL DEFAULT 'monthly',
  summary         TEXT NOT NULL,
  strengths       TEXT,
  improvements    TEXT,
  goals_set       TEXT,
  follow_up_date  TEXT,
  acknowledged_at TEXT,
  version         INTEGER NOT NULL DEFAULT 1,
  frozen_at       TEXT,
  deleted_at      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_counselings_user ON counselings(user_id);
CREATE INDEX IF NOT EXISTS idx_counselings_counselor ON counselings(counselor_id);
CREATE INDEX IF NOT EXISTS idx_counselings_unit ON counselings(unit_id, visibility);

CREATE TABLE IF NOT EXISTS attachments (
  id            TEXT PRIMARY KEY,
  record_table  TEXT NOT NULL,
  record_id     TEXT NOT NULL,
  uploaded_by   TEXT NOT NULL REFERENCES users(id),
  original_name TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  content       BLOB NOT NULL,
  created_at    TEXT NOT NULL,
  deleted_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_attachments_record ON attachments(record_table, record_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_attachments_live_digest ON attachments(record_table, record_id, sha256) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS audit_log (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT NOT NULL UNIQUE,
  actor_id   TEXT REFERENCES users(id),
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  TEXT,
  subject_id TEXT REFERENCES users(id),
  unit_id    TEXT,
  detail     TEXT,
  ip         TEXT,
  at         TEXT NOT NULL,
  prev_hash  TEXT,
  entry_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_subject ON audit_log(subject_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_audit_unit ON audit_log(unit_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id, seq DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  message    TEXT,
  action_url TEXT,
  dedupe_key TEXT,
  read_at    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe ON notifications(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS maradmins (
  id           TEXT PRIMARY KEY,
  number       TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  summary      TEXT NOT NULL,
  url          TEXT NOT NULL,
  tags         TEXT NOT NULL DEFAULT '[]',
  audience     TEXT NOT NULL DEFAULT '[]',
  published_at TEXT NOT NULL,
  source_hash  TEXT,
  fetched_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_maradmins_published ON maradmins(published_at DESC);

CREATE TABLE IF NOT EXISTS maradmin_user_state (
  user_id     TEXT NOT NULL REFERENCES users(id),
  maradmin_id TEXT NOT NULL REFERENCES maradmins(id),
  read_at     TEXT,
  saved_at    TEXT,
  PRIMARY KEY (user_id, maradmin_id)
);

CREATE TABLE IF NOT EXISTS ai_usage_daily (
  day               TEXT NOT NULL,
  user_id           TEXT NOT NULL REFERENCES users(id),
  workflow          TEXT NOT NULL,
  model             TEXT NOT NULL,
  requests          INTEGER NOT NULL DEFAULT 0,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  failures          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_id, workflow, model)
);

CREATE TABLE IF NOT EXISTS email_log (
  id         TEXT PRIMARY KEY,
  user_id    TEXT REFERENCES users(id),
  to_address TEXT NOT NULL,
  kind       TEXT NOT NULL,
  subject    TEXT NOT NULL,
  status     TEXT NOT NULL,
  error      TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_log_created ON email_log(created_at DESC);

-- Phase 2: work intake ------------------------------------------------------
-- An uploaded workbook, kept exactly as it arrived. Nothing here is ever rewritten:
-- a reimport reads these bytes again rather than trusting a derived copy.
CREATE TABLE IF NOT EXISTS source_files (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  unit_id      TEXT REFERENCES units(id),
  visibility   TEXT NOT NULL DEFAULT 'unit' CHECK (visibility IN ('private', 'unit')),
  filename     TEXT NOT NULL,
  content_type TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('xlsx', 'delimited')),
  byte_size    INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  -- quarantined until a scan clears it; nothing is parsed for import while quarantined.
  scan_status  TEXT NOT NULL DEFAULT 'quarantined' CHECK (scan_status IN ('quarantined', 'clean', 'rejected', 'skipped')),
  scan_detail  TEXT,
  scanner      TEXT,
  scanned_at   TEXT,
  notes        TEXT NOT NULL DEFAULT '[]',
  content      BLOB NOT NULL,
  deleted_at   TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_source_files_user ON source_files(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_source_files_unit ON source_files(unit_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_source_files_sha ON source_files(sha256);

-- One run of an import over one sheet of one source file. Survives a restart mid-run.
CREATE TABLE IF NOT EXISTS import_jobs (
  id              TEXT PRIMARY KEY,
  source_file_id  TEXT NOT NULL REFERENCES source_files(id),
  user_id         TEXT NOT NULL REFERENCES users(id),
  unit_id         TEXT REFERENCES units(id),
  visibility      TEXT NOT NULL DEFAULT 'unit' CHECK (visibility IN ('private', 'unit')),
  sheet_name      TEXT NOT NULL,
  header_row      INTEGER NOT NULL DEFAULT 1,
  mapping         TEXT NOT NULL DEFAULT '{}',
  key_columns     TEXT NOT NULL DEFAULT '[]',
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  total_rows      INTEGER NOT NULL DEFAULT 0,
  processed_rows  INTEGER NOT NULL DEFAULT 0,
  inserted_rows   INTEGER NOT NULL DEFAULT 0,
  updated_rows    INTEGER NOT NULL DEFAULT 0,
  unchanged_rows  INTEGER NOT NULL DEFAULT 0,
  rejected_rows   INTEGER NOT NULL DEFAULT 0,
  rejections      TEXT NOT NULL DEFAULT '[]',
  error           TEXT,
  idempotency_key TEXT UNIQUE,
  started_at      TEXT,
  finished_at     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_import_jobs_user ON import_jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_import_jobs_source ON import_jobs(source_file_id);

-- A normalized row of work. Its natural key comes verbatim from the source: never reconstructed,
-- never padded, never re-derived from a truncated display value.
CREATE TABLE IF NOT EXISTS work_items (
  id              TEXT PRIMARY KEY,
  unit_id         TEXT REFERENCES units(id),
  owner_id        TEXT NOT NULL REFERENCES users(id),
  visibility      TEXT NOT NULL DEFAULT 'unit' CHECK (visibility IN ('private', 'unit')),
  source_file_id  TEXT REFERENCES source_files(id),
  import_job_id   TEXT REFERENCES import_jobs(id),
  natural_key     TEXT NOT NULL,
  row_hash        TEXT NOT NULL,
  source_row      INTEGER,
  title           TEXT NOT NULL,
  reference       TEXT,
  due_date        TEXT,
  amount          REAL,
  amount_type     TEXT,
  quantity        REAL,
  unit_label      TEXT,
  state           TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'in_progress', 'waiting', 'resolved', 'not_applicable')),
  data            TEXT NOT NULL DEFAULT '{}',
  claimed_by      TEXT REFERENCES users(id),
  claimed_at      TEXT,
  resolved_at     TEXT,
  -- set when a later import of the same key changed the source values under an in-flight claim
  source_changed_at TEXT,
  version         INTEGER NOT NULL DEFAULT 1,
  deleted_at      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_key ON work_items(unit_id, natural_key) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_work_items_unit_state ON work_items(unit_id, state, due_date);
CREATE INDEX IF NOT EXISTS idx_work_items_claim ON work_items(claimed_by, state);
CREATE INDEX IF NOT EXISTS idx_work_items_source ON work_items(source_file_id);

-- Something a person did about a work item. This is the bridge from doing the work to the record of it.
CREATE TABLE IF NOT EXISTS work_actions (
  id              TEXT PRIMARY KEY,
  work_item_id    TEXT NOT NULL REFERENCES work_items(id),
  user_id         TEXT NOT NULL REFERENCES users(id),
  unit_id         TEXT REFERENCES units(id),
  kind            TEXT NOT NULL,
  note            TEXT,
  occurred_at     TEXT NOT NULL,
  -- the measurable outcome this action produced, if any
  quantity        REAL,
  unit_label      TEXT,
  dollar_amount   REAL,
  dollar_type     TEXT,
  -- the personal record drafted from this action, if the person kept it
  activity_id     TEXT REFERENCES activities(id),
  idempotency_key TEXT UNIQUE,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_work_actions_item ON work_actions(work_item_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_actions_user ON work_actions(user_id, occurred_at DESC);

-- A saved arrangement of the workbench: filters, sort, columns.
CREATE TABLE IF NOT EXISTS work_views (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  unit_id    TEXT REFERENCES units(id),
  name       TEXT NOT NULL,
  shared     INTEGER NOT NULL DEFAULT 0,
  config     TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_work_views_user ON work_views(user_id);
CREATE INDEX IF NOT EXISTS idx_work_views_unit ON work_views(unit_id, shared);

-- Phase 3: typed goals and report revisions ---------------------------------
-- Goals gain a typed measure. Those columns are added by migration 003 rather than here, because
-- ALTER TABLE is not idempotent and this file is replayed on every boot. The legacy `metric` column
-- stays for rows created before this and is read through a compatibility path, never rewritten.

-- A report someone is building. The draft is a name and a period; its content lives in revisions.
CREATE TABLE IF NOT EXISTS report_drafts (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  subject_id   TEXT NOT NULL REFERENCES users(id),
  unit_id      TEXT REFERENCES units(id),
  visibility   TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'unit')),
  title        TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end   TEXT NOT NULL,
  track        TEXT NOT NULL DEFAULT 'jepes',
  latest_revision INTEGER NOT NULL DEFAULT 0,
  version      INTEGER NOT NULL DEFAULT 1,
  deleted_at   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_report_drafts_user ON report_drafts(user_id, updated_at DESC);

-- One saved version of a report. Immutable once written: a later edit is a new revision.
-- source_snapshots records the exact version of every record the wording was built from, which is
-- what makes a later export provably the thing that was reviewed.
CREATE TABLE IF NOT EXISTS report_revisions (
  id               TEXT PRIMARY KEY,
  report_id        TEXT NOT NULL REFERENCES report_drafts(id),
  revision         INTEGER NOT NULL,
  title            TEXT NOT NULL,
  period_start     TEXT NOT NULL,
  period_end       TEXT NOT NULL,
  sections         TEXT NOT NULL DEFAULT '[]',
  source_snapshots TEXT NOT NULL DEFAULT '[]',
  note             TEXT,
  created_by       TEXT NOT NULL REFERENCES users(id),
  created_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_report_revisions_number ON report_revisions(report_id, revision);

-- Phase 4: correspondence ---------------------------------------------------
-- A person or office the unit deals with. Kept apart from users: a vendor is not an account.
CREATE TABLE IF NOT EXISTS contacts (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL REFERENCES users(id),
  unit_id      TEXT REFERENCES units(id),
  visibility   TEXT NOT NULL DEFAULT 'unit' CHECK (visibility IN ('private', 'unit')),
  name         TEXT NOT NULL,
  email        TEXT,
  organization TEXT,
  role         TEXT,
  phone        TEXT,
  notes        TEXT,
  version      INTEGER NOT NULL DEFAULT 1,
  deleted_at   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contacts_unit ON contacts(unit_id, visibility);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);

-- One conversation. Its state is the thing a person actually wants to know: is anyone waiting on me,
-- am I waiting on them, did the document arrive, is this finished.
CREATE TABLE IF NOT EXISTS threads (
  id             TEXT PRIMARY KEY,
  owner_id       TEXT NOT NULL REFERENCES users(id),
  unit_id        TEXT REFERENCES units(id),
  visibility     TEXT NOT NULL DEFAULT 'unit' CHECK (visibility IN ('private', 'unit')),
  contact_id     TEXT REFERENCES contacts(id),
  subject        TEXT NOT NULL,
  -- draft: written, not sent. sent: gone out. awaiting_reply: sent and nothing back yet.
  -- response_received: they replied. ksd_received: the supporting document actually arrived.
  -- resolved: the underlying question is closed. These are four different facts, not one.
  state          TEXT NOT NULL DEFAULT 'draft'
                 CHECK (state IN ('draft', 'sent', 'awaiting_reply', 'response_received', 'ksd_received', 'resolved')),
  follow_up_at   TEXT,
  last_message_at TEXT,
  response_at    TEXT,
  ksd_at         TEXT,
  resolved_at    TEXT,
  -- set when the thread came from a connected mailbox rather than being written here
  provider       TEXT,
  provider_thread_id TEXT,
  connector_id   TEXT,
  version        INTEGER NOT NULL DEFAULT 1,
  deleted_at     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_threads_unit ON threads(unit_id, state, follow_up_at);
CREATE INDEX IF NOT EXISTS idx_threads_owner ON threads(owner_id, state);
CREATE INDEX IF NOT EXISTS idx_threads_contact ON threads(contact_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_provider ON threads(connector_id, provider_thread_id) WHERE provider_thread_id IS NOT NULL;

-- One message in a conversation. Bodies are stored sanitized; the raw HTML is never rendered.
CREATE TABLE IF NOT EXISTS thread_messages (
  id            TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL REFERENCES threads(id),
  direction     TEXT NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  -- the provider's own id. Threading follows this, never a subject line, which anyone can copy.
  provider_message_id TEXT,
  connector_id  TEXT,
  source        TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'eml', 'graph')),
  from_name     TEXT,
  from_email    TEXT,
  to_emails     TEXT NOT NULL DEFAULT '[]',
  cc_emails     TEXT NOT NULL DEFAULT '[]',
  sent_at       TEXT,
  subject       TEXT,
  body_text     TEXT,
  body_html     TEXT,
  blocked_remote_images INTEGER NOT NULL DEFAULT 0,
  blocked_active_content INTEGER NOT NULL DEFAULT 0,
  attachments   TEXT NOT NULL DEFAULT '[]',
  created_by    TEXT REFERENCES users(id),
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_thread_messages_thread ON thread_messages(thread_id, sent_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_messages_provider ON thread_messages(connector_id, provider_message_id) WHERE provider_message_id IS NOT NULL;

-- One email can concern a hundred documents. It is still one email: the link lives here, so a
-- message is never copied per document and never counted per document.
CREATE TABLE IF NOT EXISTS thread_links (
  id           TEXT PRIMARY KEY,
  thread_id    TEXT NOT NULL REFERENCES threads(id),
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  created_by   TEXT NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_links_pair ON thread_links(thread_id, work_item_id);
CREATE INDEX IF NOT EXISTS idx_thread_links_item ON thread_links(work_item_id);

-- A mailbox connection. Read-only, and the national cloud is recorded rather than inferred.
CREATE TABLE IF NOT EXISTS connectors (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id),
  provider       TEXT NOT NULL,
  -- global, usgov (GCC High), usgovdod (DoD). Chosen by the operator; never guessed from an address.
  cloud          TEXT NOT NULL DEFAULT 'global',
  account_label  TEXT NOT NULL,
  access         TEXT NOT NULL DEFAULT 'read_only' CHECK (access IN ('read_only', 'read_write')),
  status         TEXT NOT NULL DEFAULT 'disconnected'
                 CHECK (status IN ('disconnected', 'needs_authorization', 'connected', 'error')),
  scopes         TEXT NOT NULL DEFAULT '[]',
  delta_token    TEXT,
  last_sync_at   TEXT,
  last_error     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_connectors_user ON connectors(user_id, provider);

-- Product analytics ----------------------------------------------------
-- What people did with Vantage, in a shape that can be counted. This table holds names and numbers
-- only. It never holds draft text, workbook cells, email bodies, keystrokes, or anything a person
-- typed: a property whose value is not a declared scalar is refused before it reaches here.
CREATE TABLE IF NOT EXISTS product_events (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  -- the actor, kept so adoption can be counted per person. Never joined into an exported analytic.
  user_id      TEXT REFERENCES users(id),
  unit_id      TEXT,
  session_id   TEXT,
  -- the surface the event came from: 'client' or 'server'.
  origin       TEXT NOT NULL DEFAULT 'client' CHECK (origin IN ('client', 'server')),
  -- declared properties, already validated against the catalog. JSON object of scalars.
  properties   TEXT NOT NULL DEFAULT '{}',
  -- The three time concepts are separate columns because they are separate facts and must never be
  -- added together: how long a form was open, how long the editor judged the person to be actively
  -- working, and how long the person said the work itself took.
  form_ms          INTEGER,
  active_editor_ms INTEGER,
  confirmed_work_minutes REAL,
  -- when it happened on the client, and when the server received it. Both kept: a device clock lies.
  occurred_at  TEXT NOT NULL,
  received_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_product_events_name ON product_events(name, occurred_at);
CREATE INDEX IF NOT EXISTS idx_product_events_user ON product_events(user_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_product_events_received ON product_events(received_at);
