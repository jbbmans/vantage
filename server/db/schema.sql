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
