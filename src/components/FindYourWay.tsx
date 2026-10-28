import { Link } from 'react-router-dom';
import { Panel } from '@/components/ui/primitives';
import { pageFor, placeName } from '@/config/nav';
import { useNav } from '@/lib/useNav';

interface Answer { id: string; q: string; a: string; to: string[]; otherwise?: string }

/**
 * The questions a new user asks first (VANTAGE_CLAUDE_MASTER.md section 16, the UX definition of done), each answered
 * with where to go. Places are named and linked from the menu, and only those this person may open are offered.
 */
const ANSWERS: Answer[] = [
  { id: 'what', q: 'What is Vantage?', a: 'One place for your work, your records and your training. Doing the work here records it for you, and Reports turn the records into evaluation input you can cite.', to: [] },
  { id: 'today', q: 'What do I need to do today?', a: 'Today lists what you hold, what is waiting on someone else, and what is open to claim.', to: ['/'] },
  { id: 'work', q: 'Where does my work live?', a: 'Taskers and cases in the queue, your to-dos, projects, and the correspondence behind them.', to: ['/work/queue', '/work/tasks'] },
  { id: 'records', q: 'Where do my records live?', a: 'Everything you did and what backs it up: activities, awards and counseling, and a timeline of all of it.', to: ['/record', '/record/timeline'] },
  { id: 'training', q: 'Where does training live?', a: 'PME, courses and certifications, with your career plan, goals and readiness beside them.', to: ['/career/training', '/career/readiness'] },
  { id: 'personnel', q: 'Where are my Marines?', a: 'Personnel shows the people of your units; whoever leads one also sees its roster and who holds what.', to: ['/team/roster', '/team/workload', '/team'], otherwise: 'Personnel appears in the menu when you lead a unit or hold a role that sees its members.' },
  { id: 'record', q: 'How do I record something?', a: 'Press N anywhere, or Log activity at the top of the page, and write what you did in a sentence. Awards, training and counseling each have a New button on their own page.', to: ['/record/activities', '/career/awards', '/career/training'] },
  { id: 'import', q: 'How do I import something?', a: 'Your records of every kind, from a Vantage export or a workbook, with Import records in Your data; activities from a CSV with Import activities; taskers and cases from a spreadsheet with Import work.', to: ['/settings?tab=data&import=1', '/record/activities?import=1', '/work/queue?import=1'] },
  { id: 'export', q: 'How do I export something?', a: 'Export activities gives a CSV you can edit and import back; Training, Awards and Counseling each export their own; Analysis exports a PDF for your reporting senior; Your data, in Settings, downloads everything Vantage holds about you, or the categories you choose.', to: ['/record/activities', '/reports/analysis', '/settings?tab=data'] },
  { id: 'performance', q: 'How do I see how I am doing?', a: 'Analysis shows what your record says, period against period. Readiness shows your JEPES or FITREP figures. A leader’s unit dashboard shows the unit’s shared work.', to: ['/reports/analysis', '/career/readiness', '/team/dashboard'] },
  { id: 'duty', q: 'Where is duty?', a: 'Log a duty as an activity, in a sentence: “Stood duty as DNCO, 0800 to 0800, at the barracks.” Vantage suggests Operations as its category; your activities filtered to Operations, and your timeline, show the duty you stood.', to: ['/record/activities?category=Operations', '/record/timeline'] },
  { id: 'help', q: 'Where do I get help?', a: 'This guide; ⌘K or / to search everything; ? for the keyboard shortcuts; and Support to ask a person.', to: ['/support'], otherwise: 'This guide; ⌘K or / to search everything; and ? for the keyboard shortcuts.' },
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
                  <span className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                    {links.map((to) => <Link key={to} to={to} className="link text-xs font-medium">{placeName(to)}</Link>)}
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
