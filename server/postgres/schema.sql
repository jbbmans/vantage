-- VANTAGE PostgreSQL schema, aligned with SQLite schema version 17.
-- This file intentionally preserves the application's current TEXT timestamp and
-- SMALLINT 0/1 contracts so a later runtime-adapter change does not alter API JSON.

CREATE TABLE ranks (
  id TEXT PRIMARY KEY,
  grade TEXT NOT NULL,
  abbr TEXT NOT NULL,
  name TEXT NOT NULL,
  tier TEXT NOT NULL,
  sort INTEGER NOT NULL
);

CREATE TABLE billets (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  echelon TEXT,
  default_role TEXT NOT NULL DEFAULT 'member',
  active SMALLINT NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  cac_subject TEXT,
  last_name TEXT NOT NULL,
  first_name TEXT NOT NULL,
  middle_initial TEXT,
  rank_id TEXT REFERENCES ranks(id) DEFERRABLE INITIALLY DEFERRED,
  mos TEXT,
  email TEXT,
  is_admin SMALLINT NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  active SMALLINT NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  must_change_password SMALLINT NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
  eas TEXT,
  pft_score INTEGER,
  cft_score INTEGER,
  rifle_score INTEGER,
  rifle_qual TEXT,
  mcmap_belt TEXT,
  ceus DOUBLE PRECISION,
  college_credits DOUBLE PRECISION,
  degree TEXT,
  pme_complete TEXT,
  cmd_character DOUBLE PRECISION,
  cmd_mos DOUBLE PRECISION,
  cmd_leadership DOUBLE PRECISION,
  prefs TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_users_username_nocase ON users (lower(username));
CREATE UNIQUE INDEX idx_users_cac_subject ON users(cac_subject) WHERE cac_subject IS NOT NULL;

CREATE TABLE units (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  short_name TEXT,
  echelon TEXT NOT NULL,
  location TEXT,
  parent_id TEXT REFERENCES units(id) DEFERRABLE INITIALLY DEFERRED,
  level TEXT,
  data_mode TEXT NOT NULL DEFAULT 'full',
  owner_user_id TEXT REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED,
  active SMALLINT NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_units_parent ON units(parent_id);
CREATE INDEX idx_units_owner ON units(owner_user_id);

CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units(id) DEFERRABLE INITIALLY DEFERRED,
  template_key TEXT,
  name TEXT NOT NULL,
  description TEXT,
  color TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  permissions INTEGER NOT NULL DEFAULT 0,
  is_default SMALLINT NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  is_system SMALLINT NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (id, unit_id)
);
CREATE INDEX idx_roles_unit ON roles(unit_id);

CREATE TABLE unit_members (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED,
  unit_id TEXT NOT NULL REFERENCES units(id) DEFERRABLE INITIALLY DEFERRED,
  kind TEXT NOT NULL DEFAULT 'member',
  joined_at TEXT NOT NULL,
  expires_at TEXT,
  invited_by TEXT REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (user_id, unit_id)
);
CREATE INDEX idx_unit_members_user ON unit_members(user_id);
CREATE INDEX idx_unit_members_unit ON unit_members(unit_id);

CREATE TABLE member_roles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED,
  role_id TEXT NOT NULL,
  unit_id TEXT NOT NULL REFERENCES units(id) DEFERRABLE INITIALLY DEFERRED,
  granted_by TEXT REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, role_id, unit_id),
  FOREIGN KEY (role_id, unit_id) REFERENCES roles(id, unit_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX idx_member_roles_user ON member_roles(user_id);
CREATE INDEX idx_member_roles_unit ON member_roles(unit_id);
CREATE INDEX idx_member_roles_role_unit ON member_roles(role_id, unit_id);

CREATE TABLE assignments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED,
  unit_id TEXT NOT NULL REFERENCES units(id) DEFERRABLE INITIALLY DEFERRED,
  billet_id TEXT REFERENCES billets(id) DEFERRABLE INITIALLY DEFERRED,
  role TEXT NOT NULL DEFAULT '',
  is_primary SMALLINT NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  start_date TEXT,
  end_date TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_assign_user ON assignments(user_id);
CREATE INDEX idx_assign_unit ON assignments(unit_id);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED,
  unit_id TEXT REFERENCES units(id) DEFERRABLE INITIALLY DEFERRED,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'active',
  priority TEXT DEFAULT 'medium',
  progress DOUBLE PRECISION DEFAULT 0,
  start_date TEXT,
  target_date TEXT,
  organization TEXT,
  visibility TEXT NOT NULL DEFAULT 'private',
  version INTEGER NOT NULL DEFAULT 1,
  frozen_at TEXT,
  frozen_reason TEXT,
  derived_from_record_id TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE activities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED,
  unit_id TEXT REFERENCES units(id) DEFERRABLE INITIALLY DEFERRED,
  date TEXT,
  title TEXT NOT NULL,
  category TEXT,
  jepes_area TEXT,
  quantity DOUBLE PRECISION,
  unit_label TEXT,
  dollar_amount DOUBLE PRECISION,
  dollar_type TEXT,
  result TEXT,
  organization TEXT,
  system TEXT,
  project_id TEXT,
  status TEXT DEFAULT 'completed',
  notes TEXT,
  evidence_links TEXT,
  visibility TEXT NOT NULL DEFAULT 'unit',
  fingerprint TEXT,
  frozen_at TEXT,
  frozen_reason TEXT,
  derived_from_record_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_act_user ON activities(user_id);
CREATE INDEX idx_act_unit ON activities(unit_id);
CREATE INDEX idx_act_date ON activities(date);
CREATE UNIQUE INDEX idx_act_fingerprint ON activities(fingerprint)
  WHERE fingerprint IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED,
  assignee_id TEXT REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED,
  unit_id TEXT REFERENCES units(id) DEFERRABLE INITIALLY DEFERRED,
  project_id TEXT REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED,
  title TEXT NOT NULL,
  notes TEXT,
  status TEXT DEFAULT 'planned',
  priority TEXT DEFAULT 'medium',
  due_date TEXT,
  visibility TEXT NOT NULL DEFAULT 'private',
  version INTEGER NOT NULL DEFAULT 1,
  frozen_at TEXT,
  frozen_reason TEXT,
  derived_from_record_id TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_task_assignee ON tasks(assignee_id);

CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED,
  assignee_id TEXT REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED,
  unit_id TEXT REFERENCES units(id) DEFERRABLE INITIALLY DEFERRED,
  title TEXT NOT NULL,
  description TEXT,
  type TEXT DEFAULT 'quarterly',
  category TEXT,
  current_value DOUBLE PRECISION DEFAULT 0,
  target_value DOUBLE PRECISION,
  unit_label TEXT,
  status TEXT DEFAULT 'active',
  period_start TEXT,
  period_end TEXT,
  visibility TEXT NOT NULL DEFAULT 'private',
  version INTEGER NOT NULL DEFAULT 1,
  frozen_at TEXT,
  frozen_reason TEXT,
  derived_from_record_id TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE recognitions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED,
  unit_id TEXT REFERENCES units(id) DEFERRABLE INITIALLY DEFERRED,
  date TEXT,
  title TEXT NOT NULL,
  type TEXT,
  from_whom TEXT,
  organization TEXT,
  notes TEXT,
  visibility TEXT NOT NULL DEFAULT 'unit',
  version INTEGER NOT NULL DEFAULT 1,
  frozen_at TEXT,
  frozen_reason TEXT,
  derived_from_record_id TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE trainings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED,
  unit_id TEXT REFERENCES units(id) DEFERRABLE INITIALLY DEFERRED,
  date TEXT,
  title TEXT NOT NULL,
  type TEXT,
  hours DOUBLE PRECISION,
  provider TEXT,
  status TEXT DEFAULT 'completed',
  notes TEXT,
  visibility TEXT NOT NULL DEFAULT 'unit',
  version INTEGER NOT NULL DEFAULT 1,
  frozen_at TEXT,
  frozen_reason TEXT,
  derived_from_record_id TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  subject_id TEXT REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED,
  unit_id TEXT,
  detail TEXT,
  at TEXT NOT NULL,
  prev_hash TEXT,
  entry_hash TEXT,
  sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE
);
CREATE INDEX idx_audit_subject ON audit_log(subject_id);
CREATE INDEX idx_audit_at ON audit_log(at);
CREATE INDEX idx_audit_unit ON audit_log(unit_id);
CREATE UNIQUE INDEX idx_audit_entry_hash ON audit_log(entry_hash) WHERE entry_hash IS NOT NULL;

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL REFERENCES activities(id) DEFERRABLE INITIALLY DEFERRED,
  uploaded_by TEXT NOT NULL REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  content BYTEA NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_attachments_activity ON attachments(activity_id);
CREATE UNIQUE INDEX idx_attachments_live_digest ON attachments(activity_id, sha256)
  WHERE deleted_at IS NULL;

CREATE TABLE ux_daily_metrics (
  day TEXT NOT NULL,
  event TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, event)
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT,
  action_url TEXT,
  dedupe_key TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_notifications_user_created ON notifications(user_id, created_at DESC);
CREATE UNIQUE INDEX idx_notifications_user_dedupe ON notifications(user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE TABLE rank_change_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED,
  current_rank_id TEXT REFERENCES ranks(id) DEFERRABLE INITIALLY DEFERRED,
  requested_rank_id TEXT NOT NULL REFERENCES ranks(id) DEFERRABLE INITIALLY DEFERRED,
  reason TEXT,
  unit_id TEXT REFERENCES units(id) DEFERRABLE INITIALLY DEFERRED,
  status TEXT NOT NULL DEFAULT 'pending',
  reviewed_by TEXT REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED,
  reviewed_at TEXT,
  review_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_rank_requests_user ON rank_change_requests(user_id, created_at DESC);
CREATE INDEX idx_rank_requests_status ON rank_change_requests(status, created_at DESC);
CREATE UNIQUE INDEX idx_rank_requests_one_pending ON rank_change_requests(user_id)
  WHERE status = 'pending';

CREATE TABLE maradmins (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Active',
  tags TEXT NOT NULL DEFAULT '[]',
  audience TEXT NOT NULL DEFAULT '[]',
  published_at TEXT NOT NULL,
  source_hash TEXT,
  fetched_at TEXT NOT NULL
);
CREATE INDEX idx_maradmins_published ON maradmins(published_at DESC);

CREATE TABLE maradmin_user_state (
  user_id TEXT NOT NULL REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED,
  maradmin_id TEXT NOT NULL REFERENCES maradmins(id) DEFERRABLE INITIALLY DEFERRED,
  read_at TEXT,
  saved_at TEXT,
  PRIMARY KEY (user_id, maradmin_id)
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL DEFAULT '9999-12-31T00:00:00.000Z',
  last_used_at TEXT,
  ip TEXT,
  user_agent TEXT
);

CREATE TABLE integration_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  unit_id TEXT NOT NULL REFERENCES units(id) DEFERRABLE INITIALLY DEFERRED,
  scope TEXT NOT NULL DEFAULT 'unit.shared.read' CHECK (scope = 'unit.shared.read'),
  token_prefix TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  active SMALLINT NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_by TEXT NOT NULL REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  revoked_by TEXT REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX idx_integration_clients_unit ON integration_clients(unit_id);

CREATE TABLE security_incidents (
  id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED,
  category TEXT NOT NULL CHECK (category IN (
    'vulnerability', 'security_incident', 'privacy', 'account_access',
    'data_integrity', 'availability', 'other'
  )),
  severity TEXT NOT NULL CHECK (severity IN ('informational', 'low', 'moderate', 'high', 'critical')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  affected_area TEXT,
  observed_at TEXT,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN (
    'submitted', 'acknowledged', 'investigating', 'mitigated', 'closed'
  )),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  acknowledged_at TEXT,
  resolved_at TEXT,
  last_actor_id TEXT REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX idx_security_incidents_reporter ON security_incidents(reporter_id, created_at DESC);
CREATE INDEX idx_security_incidents_status ON security_incidents(status, severity, updated_at DESC);

CREATE TABLE security_incident_events (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES security_incidents(id) DEFERRABLE INITIALLY DEFERRED,
  actor_id TEXT NOT NULL REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED,
  kind TEXT NOT NULL CHECK (kind IN ('submitted', 'status', 'reporter_follow_up', 'operator_note')),
  from_status TEXT,
  to_status TEXT,
  message TEXT,
  visible_to_reporter SMALLINT NOT NULL DEFAULT 1 CHECK (visible_to_reporter IN (0, 1)),
  created_at TEXT NOT NULL,
  sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE
);
CREATE INDEX idx_security_incident_events_case ON security_incident_events(incident_id, created_at);

CREATE TABLE ai_usage_daily (
  day TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED,
  workflow TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_id, workflow)
);
CREATE INDEX idx_ai_usage_day ON ai_usage_daily(day);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
