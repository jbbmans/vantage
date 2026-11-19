import { Link } from 'react-router-dom';
import { Panel } from '@/components/ui/primitives';
import { pageFor, placeName } from '@/config/nav';
import { useNav } from '@/lib/useNav';

interface Answer { id: string; q: string; a: string; to: string[]; otherwise?: string }

/**
 * The questions a new user asks first (the UX definition of done), each answered
 * with where to go. Places are named and linked from the menu, and only those this person may open are offered.
 */
const ANSWERS: Answer[] = [
  { id: 'what', q: 'What is Vantage?', a: 'One place for your work, your records and your training. Doing the work here records it for you, and Reports turn the records into evaluation input you can cite.', to: [] },
  { id: 'today', q: 'What do I need to do today?', a: 'Today lists what you hold, what is waiting on someone else, and what is open to claim.', to: ['/'] },
  { id: 'work', q: 'Where does my work live?', a: 'Taskers and cases in the queue, your to-dos, projects and the correspondence behind them; a unit’s error reports, compared report to report; and the Reference, whose balance diagnoser opens a balance as a case.', to: ['/work/queue', '/work/tasks', '/work/error-reports', '/reference'] },
  { id: 'records', q: 'Where do my records live?', a: 'Everything you did and what backs it up: activities, awards and counseling, and a timeline of all of it.', to: ['/record', '/record/timeline'] },
  { id: 'training', q: 'Where does training live?', a: 'PME, courses and certifications, with your career plan, goals and readiness beside them.', to: ['/career/training', '/career/readiness'] },
  { id: 'personnel', q: 'Where are my Marines?', a: 'Personnel → Overview shows who is in each unit you belong to and the goals it shares. A role that reads the unit’s shared records adds its Roster and Workload, and one that manages its members adds the Roster.', to: ['/team/roster', '/team/workload', '/team'], otherwise: 'Personnel appears in the menu once you belong to a unit. Ask a leader for an invitation or a join code, and enter a code in Settings, under Join with a code.' },
  { id: 'record', q: 'How do I record something?', a: 'Choose Log activity at the top of the page, or the + at the foot of the screen on a phone, or press N, and write what you did in a sentence. Awards, training and counseling each have a New button on their own page, and duty has Record duty.', to: ['/record/activities', '/career/awards', '/career/training'] },
  { id: 'import', q: 'How do I import something?', a: 'Your records of every kind, from a Vantage export, a CSV or a workbook, with Import records in Settings → Your data, or with Import on Training, Awards, Counseling and Duty; activities from a CSV with Import activities; taskers and cases from a spreadsheet with Import work; and a unit’s ULO, OCMT or UMT report with File a report under Error reports.', to: ['/settings?tab=data&import=1', '/record/activities?import=1', '/work/queue?import=1', '/work/error-reports'] },
  { id: 'export', q: 'How do I export something?', a: 'Export activities gives a CSV you can edit and import back; Training, Awards, Counseling and Duty each export their own; the Report library prints any report you may run, and files it as a PDF, a spreadsheet, an Excel workbook or JSON as far as your permissions allow; Settings → Your data downloads everything Vantage holds about you, or the categories you choose.', to: ['/record/activities', '/reports/library', '/settings?tab=data'] },
  { id: 'performance', q: 'How do I see how I am doing?', a: 'Analysis shows what your record says, period against period. Readiness shows your JEPES or FITREP figures. A leader’s Unit dashboard shows the unit’s output, casework, duty, training and roster in figures, and most of them open the records they count.', to: ['/reports/analysis', '/career/readiness', '/team/dashboard'] },
  { id: 'duty', q: 'Where is duty?', a: 'Record each duty you stood on its own page: its duty type, when it began and when it ended. Vantage works out its hours and its points under your Unit Instance’s scoring, and it waits for a reviewer before it counts. An activity whose words read like duty you stood is offered there to move.', to: ['/record/duty', '/record/timeline'] },
  { id: 'help', q: 'Where do I get help?', a: 'This guide and its tutorials; ⌘K (Ctrl+K on Windows) or / to search everything; ? for the keyboard shortcuts; and Support to ask a person.', to: ['/support'], otherwise: 'This guide and its tutorials; ⌘K (Ctrl+K on Windows) or / to search everything; and ? for the keyboard shortcuts.' },
];

export default function FindYourWay() {
  const { visibleNav } = useNav();
  const offered = (to: string) => { const page = pageFor(to.split(/[?#]/)[0]); return Boolean(page && visibleNav.some((p) => p.to === page.to)); };
  return (
    <Panel id="find-your-way" title="Find your way" subtitle="What Vantage is, and where each thing lives. Every link opens the page it names." bodyClassName="p-0">
      <dl className="divide-y divide-line">
        {ANSWERS.map((x) => {
          const links = x.to.filter(offered);
          return (
            <div key={x.id} className="grid gap-1 px-4 py-3 sm:grid-cols-[14rem_1fr] sm:gap-4">
              <dt className="text-sm font-medium text-ink">{x.q}</dt>
              <dd className="text-sm leading-relaxed text-ink-2">
                {links.length || !x.otherwise ? x.a : x.otherwise}
                {links.length > 0 && (
                  // Each link is at least 24px tall with room between rows, so a finger or a shaky hand hits the one meant (WCAG 2.5.8).
                  <span className="mt-1 flex flex-wrap gap-x-3 gap-y-2">
                    {links.map((to) => <Link key={to} to={to} className="link inline-flex min-h-6 items-center text-xs font-medium">{placeName(to)}</Link>)}
                  </span>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </Panel>
  );
}
