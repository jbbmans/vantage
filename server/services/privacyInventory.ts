/**
 * The data inventory behind a Privacy Impact Assessment.
 *
 * A PIA asks what personal information a system holds, why it is allowed to, who sees it, and how
 * long it is kept. Answering that in a document means the answer is correct on the day it is written
 * and slowly stops being true afterwards, because the schema keeps moving and the document does not.
 *
 * So the classification lives here as a declaration, and is checked against the live database every
 * time it is asked for. A column nobody has classified is reported as unclassified rather than
 * quietly omitted — that gap is the finding, and it is better surfaced by the tool than by an
 * assessor.
 */
import type { AppContext } from '../context.ts';
import { listSchedules } from './retention.ts';

export type PiiCategory =
  | 'none'            // not about a person
  | 'identifier'      // names a person: EDIPI, username, email
  | 'contact'
  | 'employment'      // rank, unit, MOS, billet, dates of service
  | 'performance'     // what somebody did and how it was judged
  | 'authentication'  // secrets and credential material
  | 'technical';      // addresses, agents, timestamps

export interface TableDeclaration {
  purpose: string;
  /** The legal basis for holding it. An instance edits these to match its own determination. */
  authority: string;
  /** Who can read it inside the app. */
  access: string;
  /** Column name → what kind of personal information it is. */
  columns: Record<string, PiiCategory>;
}

/**
 * What each table is for. Written to be read by a records officer, not by a developer: it is the
 * text that goes into the PIA, so it says what the data is rather than how it is stored.
 */
export const DECLARATIONS: Record<string, TableDeclaration> = {
  users: {
    purpose: 'Identifies the account holder and carries the service details their record is reported under.',
    authority: '10 U.S.C. 5013; DoDI 1336.05 (evaluation reporting); collected under the instance Privacy Act statement.',
    access: 'The person. A unit leader sees name, rank and billet for their own unit. The owner sees accounts but never private record contents.',
    columns: {
      id: 'identifier', username: 'identifier', email: 'contact', edipi: 'identifier',
      first_name: 'identifier', last_name: 'identifier', middle_initial: 'identifier',
      rank_id: 'employment', mos: 'employment', eas: 'employment',
      password_hash: 'authentication', totp_secret: 'authentication', totp_enabled: 'authentication',
      is_operator: 'employment', active: 'employment', must_change_password: 'authentication',
      identity_source: 'employment', identity_synced_at: 'employment', demo_workspace_id: 'technical',
      prefs: 'none', digest_last_sent_at: 'technical', last_login_at: 'technical',
      created_at: 'technical', updated_at: 'technical',
    },
  },
  personnel_roster: {
    purpose: 'The authoritative service record as an upstream personnel system states it, so the app does not keep its own divergent copy.',
    authority: 'Mirrored from the source system of record under its own authority; retained here only while the person is assigned.',
    access: 'Administrators. A person sees their own row through their profile.',
    columns: {
      edipi: 'identifier', last_name: 'identifier', first_name: 'identifier', middle_initial: 'identifier',
      rank_id: 'employment', mos: 'employment', eas: 'employment', unit_code: 'employment', billet: 'employment',
      status: 'employment', source: 'technical', row_hash: 'technical', synced_at: 'technical',
      created_at: 'technical', updated_at: 'technical',
    },
  },
  activities: {
    purpose: 'What the person did, quantified, so their evaluation input is built from a dated record rather than recollection.',
    authority: 'Voluntarily recorded by the person about their own work.',
    access: 'The person. Shared entries are visible to their unit only when the person marks them shared.',
    columns: {
      id: 'technical', user_id: 'identifier', unit_id: 'employment', date: 'performance', title: 'performance',
      category: 'performance', eval_area: 'performance', quantity: 'performance', unit_label: 'performance',
      dollar_amount: 'performance', dollar_type: 'performance', result: 'performance', organization: 'employment',
      system: 'none', project_id: 'technical', status: 'performance', notes: 'performance', evidence_links: 'performance',
      visibility: 'none', fingerprint: 'technical', frozen_at: 'technical', deleted_at: 'technical',
      created_at: 'technical', updated_at: 'technical', version: 'technical',
    },
  },
  counselings: {
    purpose: 'Counseling given or received, including acknowledgement, so the conversation has a dated record both sides can see.',
    authority: 'Recorded under the counseling policy the unit operates by. Directly about a named person and treated as the most sensitive record here.',
    access: 'The subject and the counselor. Private counselings are never readable by other leaders or by the owner through the app.',
    columns: {
      id: 'technical', user_id: 'identifier', unit_id: 'employment', counselor_id: 'identifier',
      date: 'performance', type: 'performance', counselor_name: 'identifier', summary: 'performance',
      strengths: 'performance', improvements: 'performance', goals_set: 'performance', follow_up_date: 'performance',
      acknowledged_at: 'performance', visibility: 'none', frozen_at: 'technical', deleted_at: 'technical',
      created_at: 'technical', updated_at: 'technical', version: 'technical',
    },
  },
  work_events: {
    purpose: 'The attributed history of one piece of work: who claimed, researched, decided, submitted, verified or handed it on, when, and on what reference.',
    authority: 'Operational work records of the unit that owns the work item. Append-only.',
    access: 'People who can read the work item. A person keeps seeing the entries they authored.',
    columns: {
      id: 'technical', work_item_id: 'technical', unit_id: 'employment', actor_id: 'identifier', kind: 'performance', step: 'performance',
      subject_id: 'identifier', body: 'performance', supersedes_id: 'technical', correlation_id: 'technical', idempotency_key: 'technical',
      occurred_at: 'performance', created_at: 'technical',
    },
  },
  record_drafts: {
    purpose: 'A private accomplishment draft a person prepares from facts they recorded, before deciding whether to use it.',
    authority: 'Voluntarily prepared by the person about their own work.',
    access: 'The person only. No leader, reviewer or operator route reads it.',
    columns: {
      id: 'technical', user_id: 'identifier', work_item_id: 'technical', title: 'performance', facts: 'performance', wording: 'performance',
      wording_source: 'technical', activity_id: 'technical', version: 'technical', deleted_at: 'technical', created_at: 'technical', updated_at: 'technical',
    },
  },
  career_steps: {
    purpose: 'A person’s own development plan: next steps, where the guidance came from, and whether it was checked.',
    authority: 'Voluntarily recorded by the person.',
    access: 'The person only.',
    columns: {
      id: 'technical', user_id: 'identifier', title: 'employment', category: 'employment', status: 'employment', due_date: 'employment',
      notes: 'employment', source_label: 'none', source_url: 'none', source_checked_on: 'technical', version: 'technical',
      deleted_at: 'technical', created_at: 'technical', updated_at: 'technical',
    },
  },
  career_profiles: {
    purpose: 'A person’s stated military goal and civilian interests, to organise their own next steps.',
    authority: 'Voluntarily recorded by the person.',
    access: 'The person only.',
    columns: { user_id: 'identifier', military_goal: 'employment', civilian_interests: 'employment', updated_at: 'technical' },
  },
  audit_log: {
    purpose: 'Who did what, so access to somebody else’s record can be answered for. Hash-chained so an entry cannot be removed without detection.',
    authority: 'Security and accountability logging. Required to demonstrate the access controls work.',
    access: 'The owner. A person sees the entries where somebody else acted on their record.',
    columns: {
      id: 'technical', seq: 'technical', actor_id: 'identifier', action: 'none', entity: 'none', entity_id: 'technical',
      subject_id: 'identifier', unit_id: 'employment', detail: 'technical', ip: 'technical', at: 'technical',
      prev_hash: 'technical', entry_hash: 'technical',
    },
  },
  sessions: {
    purpose: 'Signed-in devices, so a person can see and end them.',
    authority: 'Necessary to operate authenticated access.',
    access: 'The person, for their own sessions.',
    columns: {
      id: 'authentication', user_id: 'identifier', ip: 'technical', user_agent: 'technical',
      method: 'technical', sudo_until: 'technical', created_at: 'technical', last_used_at: 'technical',
      expires_at: 'technical', absolute_expires_at: 'technical',
    },
  },
  retention_schedules: {
    purpose: 'How long each kind of record is kept and what happens then, with the authority it is kept under.',
    authority: 'Records management. The schedule itself is the instrument, so it is retained as long as the records it governs.',
    access: 'The owner.',
    columns: {
      id: 'technical', record_type: 'none', retain_days: 'none', disposition: 'none', authority: 'none',
      notes: 'none', enabled: 'none', created_at: 'technical', updated_at: 'technical',
    },
  },
  legal_holds: {
    purpose: 'Which records are frozen against disposition, why, and who froze them.',
    authority: 'Preservation obligation. A hold naming a person is about that person, so it is treated as identifying.',
    access: 'The owner.',
    columns: {
      id: 'technical', scope: 'none', subject_id: 'identifier', record_type: 'none', reason: 'employment',
      placed_by: 'identifier', placed_at: 'technical', released_by: 'identifier', released_at: 'technical',
    },
  },
  disposition_runs: {
    purpose: 'What disposition did on each run, which is the evidence that retention was applied as written.',
    authority: 'Records management accountability.',
    access: 'The owner.',
    columns: {
      id: 'technical', actor_id: 'identifier', dry_run: 'none', record_type: 'none', disposition: 'none',
      eligible: 'none', acted: 'none', held: 'none', detail: 'technical', at: 'technical',
    },
  },
  personnel_sync_runs: {
    purpose: 'Every applied roster sync and what it changed, so a person can be told why their record changed under them.',
    authority: 'Records management accountability for the personnel feed.',
    access: 'The owner.',
    columns: {
      id: 'technical', source: 'technical', actor_id: 'identifier', dry_run: 'none', rows_seen: 'none',
      created: 'none', updated: 'none', separated: 'none', conflicts: 'none', detail: 'technical', at: 'technical',
    },
  },
  product_events: {
    purpose: 'Whether the product works: which screens get used and where people give up. Holds names and numbers only, never anything anybody typed.',
    authority: 'Operational measurement. Reported only in aggregate above a minimum cohort size.',
    access: 'The owner, as counts. Never as one person’s row. On a synthetic demo instance with VANTAGE_POSTHOG_KEY set, and nowhere else, event names and declared properties are also sent to PostHog under a keyed pseudonym of the demo workspace: no user, unit or session id leaves.',
    columns: {
      id: 'technical', name: 'none', user_id: 'identifier', unit_id: 'employment', session_id: 'technical',
      origin: 'none', properties: 'none', form_ms: 'none', active_editor_ms: 'none', confirmed_work_minutes: 'none',
      occurred_at: 'technical', received_at: 'technical',
    },
  },
};

export interface InventoryTable {
  table: string;
  purpose: string | null;
  authority: string | null;
  access: string | null;
  rows: number;
  retention: { retain_days: number; disposition: string; authority: string | null; enabled: boolean } | null;
  columns: Array<{ column: string; category: PiiCategory | 'unclassified' }>;
  /** Columns present in the database that nobody has classified. These are the gaps a PIA must close. */
  unclassified: string[];
  /** Columns the declaration names that no longer exist. These mean the declaration has gone stale. */
  stale: string[];
}

export interface Inventory {
  generatedAt: string;
  instance: string;
  tables: InventoryTable[];
  summary: { tables: number; declared: number; undeclared: string[]; unclassifiedColumns: number; staleColumns: number; piiTables: number };
}

const SENSITIVE: PiiCategory[] = ['identifier', 'contact', 'employment', 'performance', 'authentication'];

/** Build the inventory from the live schema. Read-only; safe to call from a report. */
export function buildInventory(ctx: AppContext): Inventory {
  const { db } = ctx;
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name);
  const schedules = new Map(listSchedules(ctx).map((s) => [s.record_type, s]));

  const out: InventoryTable[] = [];
  const undeclared: string[] = [];
  let unclassifiedColumns = 0; let staleColumns = 0; let piiTables = 0;

  for (const table of tables) {
    const declaration = DECLARATIONS[table];
    const live = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
    if (!declaration) undeclared.push(table);

    const columns = live.map((column) => ({
      column,
      category: (declaration?.columns[column] ?? 'unclassified') as PiiCategory | 'unclassified',
    }));
    const unclassified = columns.filter((c) => c.category === 'unclassified').map((c) => c.column);
    const stale = declaration ? Object.keys(declaration.columns).filter((c) => !live.includes(c)) : [];
    unclassifiedColumns += unclassified.length;
    staleColumns += stale.length;
    if (columns.some((c) => SENSITIVE.includes(c.category as PiiCategory))) piiTables += 1;

    const schedule = schedules.get(table);
    let rows = 0;
    try { rows = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n; } catch { rows = -1; }

    out.push({
      table,
      purpose: declaration?.purpose ?? null,
      authority: declaration?.authority ?? null,
      access: declaration?.access ?? null,
      rows,
      retention: schedule ? { retain_days: schedule.retain_days, disposition: schedule.disposition, authority: schedule.authority, enabled: Boolean(schedule.enabled) } : null,
      columns,
      unclassified,
      stale,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    instance: ctx.runtime.organizationName || ctx.runtime.displayName || 'Vantage',
    tables: out,
    summary: { tables: tables.length, declared: tables.length - undeclared.length, undeclared, unclassifiedColumns, staleColumns, piiTables },
  };
}

/** The same inventory as Markdown, which is the form it goes into a PIA package in. */
export function inventoryMarkdown(inv: Inventory): string {
  const lines: string[] = [];
  lines.push(`# Data inventory — ${inv.instance}`, '', `Generated ${inv.generatedAt} from the live schema.`, '');
  lines.push(`${inv.summary.tables} tables, ${inv.summary.piiTables} holding personal information.`);
  if (inv.summary.unclassifiedColumns) lines.push('', `**${inv.summary.unclassifiedColumns} columns are unclassified.** Each one is a question this assessment cannot yet answer.`);
  if (inv.summary.staleColumns) lines.push('', `**${inv.summary.staleColumns} declared columns no longer exist.** The declaration has drifted from the schema.`);
  if (inv.summary.undeclared.length) lines.push('', `**Undeclared tables:** ${inv.summary.undeclared.join(', ')}`);

  for (const t of inv.tables) {
    lines.push('', `## ${t.table}`, '');
    lines.push(`- **Rows:** ${t.rows < 0 ? 'unknown' : t.rows.toLocaleString()}`);
    lines.push(`- **Purpose:** ${t.purpose ?? '_not declared_'}`);
    lines.push(`- **Authority:** ${t.authority ?? '_not declared_'}`);
    lines.push(`- **Who can see it:** ${t.access ?? '_not declared_'}`);
    lines.push(`- **Retention:** ${t.retention ? `${t.retention.retain_days} days, then ${t.retention.disposition}${t.retention.enabled ? '' : ' (schedule not enabled)'}${t.retention.authority ? ` — ${t.retention.authority}` : ''}` : '_no schedule set_'}`);
    const sensitive = t.columns.filter((c) => SENSITIVE.includes(c.category as PiiCategory));
    if (sensitive.length) {
      lines.push('', '| Column | Category |', '| --- | --- |');
      for (const c of sensitive) lines.push(`| ${c.column} | ${c.category} |`);
    }
    if (t.unclassified.length) lines.push('', `_Unclassified: ${t.unclassified.join(', ')}_`);
    if (t.stale.length) lines.push('', `_Declared but absent: ${t.stale.join(', ')}_`);
  }
  return lines.join('\n');
}
