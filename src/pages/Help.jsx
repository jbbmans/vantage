import React, { useMemo, useState } from 'react';
import { Search, LifeBuoy } from 'lucide-react';
import { useEvalTrack } from '@/store/useStore';
import { PageHeader, Input, Panel } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

/**
 * The SOP.
 *
 * Written as an operating procedure rather than marketing: what the tool does,
 * exactly how visibility works, what each rank should be doing with it, and
 * the handful of rules that keep the data trustworthy. If a question comes up
 * twice in the section, the answer belongs here.
 */

const SOP = [
  {
    id: 'purpose',
    title: '1. Purpose',
    body: [
      `Vantage is a performance record system for a section. Marines log work as it happens — one line at a time, in plain language — and the system turns the accumulated record into the documents that careers actually run on: JEPES inputs, FITREP inputs, bullet packages, and period-over-period reports.`,
      `The problem it solves is reconstruction. The week an evaluation is due, nobody remembers March. A Marine with a year of dated, quantified entries hands their reporting chain a package; a Marine without one hands them an apology and a guess. Every feature in this tool exists to make the first Marine the normal case.`,
      `One rule governs everything: the tool composes, it does not invent. Every figure in every output traces to a field on a record you can open.`,
    ],
  },
  {
    id: 'first-day',
    title: '2. First day',
    body: [
      `Sign in with the account your section lead created. Set your rank, MOS and readiness figures under Readiness — the advisor can only coach what it can see.`,
      `Log your first entry: press N anywhere, or the Log activity button. Write it the way you'd say it: "Reconciled 30 ULOs totaling $1,118.38 in DAI yesterday." The parser pulls the date, quantity, dollar figure and system out of the sentence; check what it inferred, tag the evaluation area, and save.`,
      `Then stop. That's the whole daily habit — thirty seconds when something happens, not a Sunday-night reconstruction. The streak counter on the Command Center exists because the habit is the product.`,
    ],
  },
  {
    id: 'logging',
    title: '3. Logging entries that survive scrutiny',
    body: [
      `A defensible entry has four things: a date, a quantity, a dollar figure where one exists, and a stated outcome. The strength pips next to every entry score exactly those four. "Worked on ULOs" is a diary line; "Corrected 30 ULOs valued at $1,118.38 in DAI; cleared the section's aged backlog" is evidence.`,
      `The outcome field is the one Marines skip and the one that matters most. An entry without a result is a task you did, not an accomplishment — and it's the first thing cut from a package. Ask yourself "so what?" and write the answer down while you still know it.`,
      `Dollar figures carry a type: reconciled, obligated, recovered, reviewed, impact. Reviewed dollars are tracked but excluded from headline totals, because "I reviewed $40M" and "I moved $40M" are different claims and a board can tell. The Needs strengthening panel on the Command Center queues entries that won't hold up yet — fix them the week you log them, not the week the package is due.`,
      `Evidence links attach the artifact — the report, the email, the tracker — so a claim is one click from its proof.`,
    ],
  },
  {
    id: 'visibility',
    title: '4. Visibility: who sees what',
    body: [
      `Every record carries one of three visibilities, and the server enforces them on every read — the interface never decides access, it only reflects it.`,
      `PRIVATE — only you. Not your team lead, not the section head, not an administrator. Private means private; there is no override, and the tests try.`,
      `MY CHAIN OF COMMAND — the default for logged work. Anyone holding a records-viewing role over your unit sees it. This is how your work rolls up into an evaluation input without you doing anything.`,
      `EVERYONE IN MY UNIT — everyone assigned to that exact unit, and no one else. A leader above the unit does not see a unit-visibility record through rank; chain is the visibility that travels up and down the command tree. For shared context inside the unit, not upward reporting.`,
      `Leaders posting downward is the same field in reverse: a task or goal posted to a unit with chain visibility reaches that unit and everything beneath it. Posting to a unit you don't belong to requires a role that grants it.`,
      `Every time someone opens a record that isn't theirs, an audit row is written — who, what, when. You can see every read of your own record under Settings. A system that lets leaders read personnel data without a trace shouldn't hold personnel data.`,
    ],
  },
  {
    id: 'tracks',
    title: '5. Evaluation tracks: JEPES vs FITREP',
    body: [
      `Rank decides your evaluation system, and Vantage follows it. Private through Corporal are on JEPES (MCO 1616.1); the official score is computed on MOL — Vantage organizes the evidence behind it. Sergeants and above — SNCOs, warrants, officers — are on fitness reports (MCO 1610.7B). The tool reads your rank and shows you the right one: area tags, the Readiness page, and the narrative on Reports all switch.`,
      `The distinction matters because the games are different. JEPES is a composite you grind: four pillars, monthly recalculation, a cutting score to beat, and three quarters of it entirely in your own hands. A FITREP is a document somebody else writes: fourteen attributes marked by your Reporting Senior against every Marine they've ever reported on. There's no score to grind — only the quality of the evidence in front of the RS when the pen comes out.`,
      `A leader viewing a Marine's record sees that Marine's track, not their own. A Corporal team lead looking at a Sergeant sees FITREP framing, because that's what the Sergeant needs.`,
    ],
  },
  {
    id: 'jepes',
    title: '6. JEPES (Pvt–Cpl)',
    body: [
      `Four pillars, 250 points each, 1000-point composite, plus bonus points. Warfighting is your rifle percentile and MCMAP belt. Physical Toughness is PFT and CFT, converted against peers in your grade. Mental Agility is MarineNet CEUs, formal PME, off-duty education and MOS quals. Command Input is three marks (Character, MOS/Mission, Leadership) from your chain — the only quarter you don't control.`,
      `HQMC publishes a cutting score monthly per MOS; meet it with the gates met and you pick up. Corporals are scored on steeper tables than Lance Corporals — the same 280 PFT is worth less after you pin on.`,
      `The Readiness page ranks your levers by points against effort. The pattern it usually finds: Marines grind the command input they don't control while leaving cheap points in a belt they never advanced, a rifle qual they never re-shot, and CEUs they never clicked through. Log your actual figures — anything not entered reads as unknown, never zero.`,
      `The estimate is for planning. The official conversion is percentile-based, per-grade, and republished; your worksheet on MOL is authoritative.`,
    ],
  },
  {
    id: 'fitrep',
    title: '7. FITREPs (Sgt and above)',
    body: [
      `Your Reporting Senior marks fourteen attributes across five sections — D Mission Accomplishment, E Individual Character, F Leadership, G Intellect and Wisdom, H Evaluation Responsibilities — and a Reviewing Officer reviews. The mark that matters is relative: where you land against every Marine that RS has ever written on.`,
      `Your leverage is the input. An RS drafting from memory writes a regressed-to-the-middle report; an RS drafting from your quantified package writes the year that actually happened. The Readiness page tracks your reporting period, maps your logged entries against all fourteen attributes, and flags the ones with no obvious evidence — mentoring and welfare checks are the classic work Marines do and never write down.`,
      `Reports builds the FITREP input itself: your period's record grouped by section, strongest material first. Print it, book fifteen minutes with your RS before drafting starts, and hand it over. That meeting is the highest-leverage thing on this page.`,
      `PME for grade sits in Section G as its own attribute and gates promotion regardless of how good the year was. Fitness scores ride on the report's front page even though they're not point-scored the JEPES way.`,
    ],
  },
  {
    id: 'roles',
    title: '8. Roles and permissions',
    body: [
      `Access comes from roles, not rank. A role is a named bundle of permissions, granted in a unit, and a Marine can hold several — they get the union. The CASCADES flag on a role decides whether it reaches the units beneath where it's granted: that one switch is the entire difference between a fire team leader and a section head.`,
      `Ships with Marine (everyone, automatically), Fire Team Leader, Training NCO, NCOIC, Section Head, and Administrator. Build your own on the Roles page for anything else — a role that sees PME across the section but opens nobody's record is two checkboxes.`,
      `Two rules keep the system honest, both enforced server-side: you cannot create, edit, delete or grant a role at or above your own position, and you cannot grant a permission you don't hold. Without them, anyone who manages roles promotes themselves to administrator.`,
      `Seeing someone on a roster and opening their record are separate permissions on purpose. Every open of someone else's record is logged, and they can see the log.`,
    ],
  },
  {
    id: 'units',
    title: '9. Units',
    body: [
      `The org tree ships with MARFORRES down to the G-8 branches, and grows from there in the app. Anyone holding Manage units on a parent creates beneath it — a section head stands up a new fire team without an administrator in the loop.`,
      `Units archive rather than delete, and archiving refuses while Marines or sub-units are still attached. Records keep pointing at archived units, so history stays whole.`,
    ],
  },
  {
    id: 'team',
    title: '10. Team management',
    body: [
      `The Team page shows every Marine your roles reach, grouped by unit. Opening a Marine shows their record at the depth your permissions allow: entries they've shared, their evaluation input ready to paste, what needs strengthening before the package is due, and their recognition and training history.`,
      `Add Marines from the Team page (needs Manage members in the target unit). Everyone starts with the Marine role; grant more from the same dialog or the Roles page. Reassigning moves unit and billet; billets are labels for the org chart, roles are what actually grant access.`,
      `Leaders can post tasks and goals to a unit — with chain visibility they reach every Marine beneath it. That's the tasking loop: section head posts "Submit Q4 inputs by 15 Sep," every fire team sees it, and each Marine's log already holds the material.`,
    ],
  },
  {
    id: 'reports',
    title: '11. Reports and printing',
    body: [
      `Three views, one source of truth — your log for the selected window.`,
      `EVALUATION INPUT — a JEPES input (hard 1000-character ceiling) or FITREP input depending on your track. Composes to a budget: headline figures per area first, then supporting detail round-robin so one busy area can't starve the rest. Anything that didn't fit is counted, never silently dropped.`,
      `BULLETS — one bullet per entry plus a rolled-up bullet per area, in three genuinely different styles. JEPES names the org and system for a board reading a hundred packages. FITREP compresses, dropping what the report header already carries. Résumé writes for a civilian reader: acronyms expanded on first use, outcomes promoted into the sentence.`,
      `CHANGE REPORT — this period against the equivalent one before it, fiscal quarter against fiscal quarter. Every figure carries its prior value and the movement, because 1,247 ULOs is either excellent or a collapse depending on last quarter.`,
      `Print any view. The stylesheet strips the app chrome, adds a masthead with the reporting window, and keeps rows from splitting across pages. Leaders can switch scope from Me to My chain to report on everything their roles reach.`,
    ],
  },
  {
    id: 'dashboard',
    title: '12. The Command Center',
    body: [
      `Every section on the dashboard collapses to its title bar or hides entirely — the Display menu at the top right controls it, and the chevron on each section collapses in place. The layout is saved to your account, so it follows you between machines.`,
      `Collapsed and hidden are different on purpose: collapsed keeps the title bar as a reminder the data exists; hidden removes it until Display brings it back. A clerk who never touches goals shouldn't scroll past a goals panel every morning.`,
      `The fiscal tape along the top is the year at a glance — every day you logged, colored by weight. Click a day to open it.`,
    ],
  },
  {
    id: 'data',
    title: '13. Data: import, export, deletion',
    body: [
      `IMPORT — Settings takes CSV or XLSX, lets you map columns, and screens every row against what's already stored. Importing the same tracker twice does not double your fiscal year: exact collisions (same date, same money, same essential words) are skipped and counted.`,
      `EXPORT — a full workbook of everything you can see, from Settings or Reports. Unit-wide export needs the Export data permission.`,
      `DELETION — soft, always. A deleted record leaves the rollups immediately but is retained server-side, and every delete has an Undo in the moment. A performance record that vanishes without trace is the failure mode that gets a system thrown out of a shop; ask an administrator if something must be removed for real.`,
    ],
  },
  {
    id: 'security',
    title: '14. Security posture',
    body: [
      `One process, one SQLite file, no third-party services in the data path, no telemetry. Sessions are opaque server-side tokens — revocable the moment a Marine transfers — with scrypt-hashed passwords and a ten-attempt-per-quarter-hour throttle on sign-in. Production turns on strict transport security, a content-security policy that stops the app talking to any other origin, and secure same-site cookies.`,
      `Private records are private from everyone including administrators. Reads of anyone else's record are audited, and the subject can see the audit. These aren't settings; they're how the server is built, and the test suite spends most of its effort trying to break them.`,
      `Before real Marines' records go into a publicly hosted instance, involve your ISSM. Personnel and performance data on commercial infrastructure is a command decision, not a developer one. The tool is built so the answer can be yes; it doesn't make the answer yes.`,
    ],
  },
  {
    id: 'shortcuts',
    title: '15. Keyboard',
    body: [
      `N logs an activity from anywhere. / or Cmd-K opens search. ? shows the full shortcut map. Navigation is two-key: tap G, release, then the section key — G D for Command, G A for the log, G J for Readiness, G T for Team, G P for Reports, G H for this page.`,
      `The report views are a tablist: arrow keys move between Evaluation input, Bullets and the Change report.`,
    ],
  },
  {
    id: 'faq',
    title: '16. Questions that come up',
    body: [
      `"My Sergeant sees a JEPES page." They shouldn't and won't — the track follows rank. If their rank is wrong in the system, fix it on the Team page and the tool follows.`,
      `"I logged something sensitive." Set it private. It will never appear to anyone else, in any rollup, input, or leader view, and there is no override.`,
      `"Who's been reading my record?" Settings → Who has viewed your record. Every open by anyone else is there.`,
      `"The advisor's number doesn't match MOL." It won't exactly — it estimates so you can rank your own levers. MOL is authoritative and the page says so.`,
      `"I imported twice." You didn't double anything — duplicates are screened on the way in and the import told you how many it skipped. Already-doubled history shows up under review with the inflated dollar figure per cluster.`,
      `"I deleted the wrong thing." Undo on the toast in the moment; afterwards, it's soft-deleted server-side — an administrator can restore it.`,
    ],
  },
];

export default function Help() {
  const [query, setQuery] = useState('');
  const track = useEvalTrack();

  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SOP;
    return SOP
      .map((s) => ({
        ...s,
        hit: s.title.toLowerCase().includes(q) || s.body.some((p) => p.toLowerCase().includes(q)),
      }))
      .filter((s) => s.hit);
  }, [query]);

  return (
    <div className="mx-auto max-w-3xl space-y-3">
      <PageHeader
        title="Standard operating procedure"
        subtitle={`How Vantage works, end to end · you are on the ${track === 'fitrep' ? 'FITREP' : 'JEPES'} track`}
      >
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-text-3" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the SOP…"
            className="w-56 pl-7"
            aria-label="Search the SOP"
          />
        </div>
      </PageHeader>

      {/* jump list */}
      {!query && (
        <nav className="panel flex flex-wrap gap-x-4 gap-y-1 rounded px-3 py-2" aria-label="SOP sections">
          {SOP.map((s) => (
            <a key={s.id} href={`#${s.id}`} className="text-xs text-text-3 hover:text-signal">
              {s.title}
            </a>
          ))}
        </nav>
      )}

      {sections.length === 0 ? (
        <Panel>
          <p className="py-4 text-center text-sm text-text-3">
            Nothing in the SOP matches "{query}". Try a shorter word.
          </p>
        </Panel>
      ) : (
        sections.map((s) => (
          <section key={s.id} id={s.id} className="panel scroll-mt-16 rounded p-4">
            <h2 className="font-mono text-sm uppercase tracking-[0.12em] text-signal">{s.title}</h2>
            <div className="mt-2 space-y-2.5">
              {s.body.map((para, i) => (
                <p
                  key={i}
                  className={cn(
                    'text-base leading-relaxed text-text-2',
                    /^[A-Z\s—-]+ —/.test(para) && 'pl-3 border-l-2 border-rule'
                  )}
                >
                  {para}
                </p>
              ))}
            </div>
          </section>
        ))
      )}

      <p className="flex items-start gap-2 px-1 pb-4 text-xs leading-relaxed text-text-3">
        <LifeBuoy className="mt-0.5 h-3 w-3 shrink-0" />
        Vantage v3 · designed and built by John Bernard Boletz. This SOP ships inside the tool so it can never drift
        from the version you're running.
      </p>
    </div>
  );
}
