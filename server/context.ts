import type { Db } from './db/index.ts';
import type { AppConfig } from './config.ts';
import type { Mailer } from './services/email.ts';
import type { MetricsConfig } from '../shared/constants.ts';

export interface AppContext {
  db: Db;
  config: AppConfig;
  mailer: Mailer;
  /** Mutable runtime settings edited by operators and persisted in meta. */
  runtime: RuntimeSettings;
  saveRuntime: () => void;
}

export interface RuntimeSettings {
  displayName: string;
  organizationName: string;
  announcement: string;
  selfRegistration: boolean;
  aiEnabled: boolean;
  aiModels: string[];
  aiDefaultModel: string;
  attachmentsEnabled: boolean;
  maradminsEnabled: boolean;
  maintenance: boolean;
  /** What this instance measures: money label and symbol, value types, categories, unit suggestions. */
  metrics: MetricsConfig;
}

export interface SessionUser {
  id: string; username: string; email: string | null; first_name: string; last_name: string; middle_initial: string | null;
  rank_id: string | null; mos: string | null; eas: string | null; is_operator: number; active: number; must_change_password: number;
  totp_enabled: number; prefs: string; last_login_at: string | null; created_at: string; updated_at: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    ctx: AppContext;
    user: SessionUser;
    sessionId: string;
    sessionRow: { id: string; sudo_until: string | null; method: string };
  }
}
