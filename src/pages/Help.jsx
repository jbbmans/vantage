import React, { useMemo, useState } from 'react';
import { Search, LifeBuoy } from 'lucide-react';
import { useEvalTrack } from '@/store/useStore';
import { Input, Panel } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

const GUIDE = [
  {
    id: 'welcome', title: '1. Welcome to Vantage 3.6', body: [
      `Vantage is the command-ready workspace for capturing accomplishments, organizing work, preparing evaluations, and keeping a defensible performance record. It turns the small facts of daily work into a clear operational picture without inventing a score, result, or claim.`,
      `Every output stays connected to its source record. Open a metric to reach the supporting work, open a report to reach the selected period, and use exact-unit controls whenever a role includes team responsibility.`,
    ],
  },
  {
    id: 'first-day', title: '2. First day', body: [
      `Sign in with the account created for you, then open Settings to choose your theme, information density, default Command period, report format, and Quick Log behavior. These preferences follow your account between devices.`,
      `Press N anywhere or choose Log activity. Write the action in plain language — for example, "Reconciled 30 ULOs totaling $1,118.38 in DAI yesterday." Confirm the date, quantity, impact, evaluation area, visibility, and outcome before saving.`,
      `Open Command after the first save. Headline measures, the twelve-week trend, attention items, recent activity, record quality, goals, and fiscal tape all build from the same source data.`,
    ],
  },
  {
    id: 'records', title: '3. Records that hold up', body: [
      `A strong record answers four questions: what happened, when it happened, how much work or value was involved, and what changed because of it. Vantage shows record-strength cues so missing context can be added while it is still easy to remember.`,
      `Use visibility deliberately. Private records remain personal. Unit records are readable only through an active membership and an exact-unit permission. Org-chart ancestry is a breadcrumb, never an access grant.`,
      `Quick Log preserves an unfinished draft in the current browser session. Detailed forms also protect against stale edits by showing the newest saved copy before anything is overwritten.`,
    ],
  },
  {
    id: 'command', title: '4. Command center', body: [
      `Command is the at-a-glance view: impact, transactions, completeness, work logged, and next actions sit above the primary trend. Supporting views stay below the operational picture so the page remains readable at briefing speed.`,
      `Use the period picker to focus the metrics. The Display menu hides or collapses supporting sections, and those choices follow your account. Every alert and metric is a drill-down, not a decorative number.`,
      `An empty Command page begins with one clear action instead of a meaningless zero chart: log the first activity and the workspace starts building itself.`,
    ],
  },
  {
    id: 'work', title: '5. Work and goals', body: [
      `Work holds tasks and projects. Due dates, ownership, status, and exact-unit visibility keep execution separate from the accomplishment record while still making overdue work visible on Command.`,
      `Goals attach a measurable target to a period. Choose a category to count matching activities automatically, or track progress manually when the target is not record-based.`,
      `Career brings Training & PME and Recognition into one progression story. The index links directly to Readiness, Goals, and the Package Builder without repeating the same controls in multiple places.`,
    ],
  },
  {
    id: 'evaluations', title: '6. JEPES vs FITREP', body: [
      `JEPES (Pvt–Cpl) uses the evaluation areas and preparation inputs relevant to junior Marines. Readiness surfaces official references, personal data, and coaching heuristics as different kinds of information. Official MOL values and the current cutting score remain authoritative.`,
      `FITREP (Sgt and above) organizes material for the applicable performance sections and reporting period. Vantage prepares source-backed input for the Reporting Senior; it does not make the Reporting Senior's judgment or calculate an official evaluation.`,
      `The active track follows rank. If the vocabulary is wrong, an authorized leader should correct the rank assignment rather than working around the interface.`,
    ],
  },
  {
    id: 'reports', title: '7. Report studio', body: [
      `Evaluation input creates a character-aware narrative from the selected period. Bullet package produces source-backed accomplishments grouped by evaluation area. Change report compares the period with its equivalent prior window and labels the movement.`,
      `Choose a personal or authorized exact-unit scope, then copy, download, print, or export. Unit output is offered only when the current role grants export in that unit.`,
      `A new account can preview every report format before data exists, with one direct path to log the first source record.`,
    ],
  },
  {
    id: 'team', title: '8. Team, units, and roles', body: [
      `Team is the roster and personnel workspace for authorized leaders. Add or enroll members, manage assignments, review access, and open a Marine's record only inside the exact unit where the role grants that action.`,
      `Units describe the organization. Parent-child relationships provide a readable hierarchy but never cascade access. Unit ownership is explicit and survives ordinary role changes.`,
      `Roles are edited one unit at a time. Permissions stack across the roles a Marine holds in that unit, while position rules prevent a role manager from creating or granting authority at or above their own.`,
    ],
  },
  {
    id: 'settings', title: '9. Settings console', body: [
      `Every Marine can configure theme, density, default Command and Report views, Quick Log detail, password, active sessions, imports, exports, and personal audit visibility from inside the app.`,
      `Instance Operators can also manage approved runtime controls: registration, attachment availability and limits, guest duration, the default theme, and aggregate experience metrics. Changes are validated, saved, applied immediately, and audited.`,
      `Proxy trust, authentication headers, database paths, session policy, retention guarantees, and secrets remain deployment-managed because changing them is an infrastructure decision.`,
    ],
  },
  {
    id: 'data', title: '10. Import, export, and recovery', body: [
      `Import accepts CSV or TSV, maps columns, validates required fields, and screens exact duplicates before anything is created. Export produces spreadsheet-safe output from records the signed-in account is authorized to read.`,
      `Records use recoverable deletion. A delete leaves active views immediately and can be undone in context; restoration remains permission-controlled.`,
      `Instance Operators can download a consistent SQLite backup from Settings. The README includes deployment, backup, restore, maintenance, and administrator-recovery procedures.`,
    ],
  },
  {
    id: 'security', title: '11. Security model', body: [
      `Vantage uses opaque, revocable server-side sessions, secure same-site cookies in production, long-password policy, layered sign-in throttling, write throttling, validation, security headers, and exact-unit authorization on every protected API route.`,
      `Private scope is not an administrator shortcut. Cross-person record reads are audited, and each Marine can review who opened their record. Configuration and interface visibility never replace server authorization.`,
      `Use synthetic or specifically authorized information while the deployment is in controlled evaluation. Before operational personnel data is introduced, follow command approval, privacy, hosting, and ISSM requirements.`,
    ],
  },
  {
    id: 'shortcuts', title: '12. Keyboard and navigation', body: [
      `N opens Quick Log. Slash or Command-K opens search and jump. Question mark opens the shortcut map. Tap G and then a destination key for two-key navigation.`,
      `Report format tabs support arrow-key movement. Dialogs keep focus contained, controls have visible labels, and status uses text or icons in addition to color.`,
    ],
  },
];

export default function Help() {
  const [query, setQuery] = useState('');
  const track = useEvalTrack();
  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return GUIDE;
    return GUIDE.filter((section) => section.title.toLowerCase().includes(q)
      || section.body.some((paragraph) => paragraph.toLowerCase().includes(q)));
  }, [query]);

  return (
    <div className="page-canvas help-page">
      <div className="flex flex-wrap items-end justify-between gap-5 border-b border-rule pb-5">
        <div>
          <p className="eyebrow">Vantage 3.6 field guide</p>
          <h2 className="mt-2 text-3xl font-medium tracking-tight text-text sm:text-4xl">From first record to finished package</h2>
          <p className="mt-1.5 max-w-2xl text-base text-text-3">Complete operating guidance · you are on the {track === 'fitrep' ? 'FITREP' : 'JEPES'} track</p>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-3" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search the field guide…" className="w-64 pl-8" aria-label="Search the SOP" />
        </div>
      </div>

      <div className={cn('grid gap-7 pt-6', !query && 'lg:grid-cols-[230px_minmax(0,1fr)]')}>
        {!query && <aside className="lg:sticky lg:top-24 lg:self-start" aria-label="Field guide sections">
          <p className="eyebrow mb-3">In this guide</p>
          <nav className="space-y-1 border-l border-rule pl-3">
            {GUIDE.map((section) => (
              <a key={section.id} href={`#${section.id}`} className="block rounded-sm px-2 py-1.5 text-sm text-text-3 hover:bg-panel-2 hover:text-signal">
                {section.title.replace(/^\d+\.\s*/, '')}
              </a>
            ))}
          </nav>
        </aside>}

        <main className="min-w-0 space-y-4">
          {sections.length === 0 ? (
            <Panel><p className="py-8 text-center text-sm text-text-3">Nothing matches “{query}”. Try a shorter term.</p></Panel>
          ) : sections.map((section) => (
            <section key={section.id} id={section.id} className="panel scroll-mt-24 rounded p-5">
              <h2 className="font-mono text-sm uppercase tracking-[0.12em] text-signal">{section.title}</h2>
              <div className="mt-3 space-y-3">
                {section.body.map((paragraph, index) => (
                  <p key={index} className={cn('text-base leading-relaxed text-text-2', /^[A-Z][A-Z\s&–-]+\s/.test(paragraph) && 'border-l-2 border-rule pl-3')}>
                    {paragraph}
                  </p>
                ))}
              </div>
            </section>
          ))}
        </main>
      </div>

      <p className="mt-6 flex items-start gap-2 border-t border-rule px-1 pt-4 text-xs leading-relaxed text-text-3">
        <LifeBuoy className="mt-0.5 h-3 w-3 shrink-0" />
        Vantage 3.6 · designed and built by John Bernard Boletz. This field guide ships with the product so operating guidance stays with the running version.
      </p>
    </div>
  );
}
