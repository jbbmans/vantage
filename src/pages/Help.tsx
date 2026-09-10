import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { PageHeader, Panel, Kbd } from '@/components/ui/primitives';
import { EVAL_REFERENCES, EVAL_VERIFIED } from '../../shared/evalRefs';
import { dollarSumRule } from '../../shared/constants';
import { useMetrics } from '@/lib/queries';
import { VERSION } from '@/lib/version';

const SHORTCUTS: Array<[string, string]> = [['N', 'Log an activity from anywhere'], ['⌘K or /', 'Search and jump'], ['G then D / R / W / G / C / J / P / T / M / S', 'Go to a page'], ['?', 'This shortcut list'], ['⌘↵', 'Save the open form'], ['Esc', 'Close a dialog']];

export default function Help() {
  const cfg = useMetrics();
  return (
    <div className="page max-w-4xl">
      <PageHeader eyebrow="Help" title="How Vantage works" lede="Short answers to the questions people ask in the first week." />
      <div className="space-y-4">
        <Panel title="The idea">
          <div className="prose-tight space-y-2 text-sm leading-relaxed text-ink-2">
            <p>Every evaluation you will ever get is written from whatever is in front of the writer at the time. Vantage keeps the evidence: dated, quantified accomplishments with an outcome. When a JEPES or FITREP comes due, <Link to="/reports" className="link">Reports</Link> turns them into a narrative and a bullet package, and a PDF you can hand over.</p>
            <p>Write entries the way you would say them out loud: <em>“Reconciled 30 ULOs totaling $1,118.38 in DAI yesterday.”</em> Press <Kbd>N</Kbd> anywhere and Vantage pulls out the date, the quantity, the dollars, and a likely evaluation area. You confirm and save. On a phone with no signal, entries queue and sync later.</p>
          </div>
        </Panel>
        <Panel title="What makes a strong entry">
          <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-ink-2">
            <li><strong className="text-ink">A number.</strong> How many, how much, how long. “Processed MIPRs” is a billet description; “processed 12 MIPRs, zero returns” is evidence.</li>
            <li><strong className="text-ink">An outcome.</strong> What changed because you did it. Entries without a result are the first cut from any package.</li>
            <li><strong className="text-ink">An area.</strong> JEPES marks character, MOS, and leadership separately. FITREPs mark fourteen attributes across five sections. An empty area is marked from impression.</li>
            <li><strong className="text-ink">{cfg.currency_label}, typed.</strong> {dollarSumRule(cfg)}</li>
          </ul>
        </Panel>
        <Panel title="Privacy and sharing">
          <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-ink-2">
            <li>Every record is <strong className="text-ink">private by default</strong>. Only you can see it. Leaders, owners, and the instance operator cannot read private entries through the app.</li>
            <li><strong className="text-ink">Shared with unit</strong> makes an entry visible to members of that unit who hold a role with the <em>View shared records</em> permission. It also feeds the unit dashboard.</li>
            <li>Every time a leader opens your record, the access is written to an audit log you can read in <Link to="/settings?tab=security" className="link">Settings</Link>.</li>
            <li>Leaving a unit freezes the entries you shared there. They stay on your record; they stop appearing to the unit.</li>
          </ul>
        </Panel>
        <Panel title="For leaders">
          <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-ink-2">
            <li>The <Link to="/team" className="link">Team</Link> page shows the roster, a unit dashboard built only from shared entries, and the access log.</li>
            <li>Roles are per unit. A role you hold in one unit confers nothing in another, including sub-units. The unit leader holds every permission inside that unit.</li>
            <li>Counselings you record ask the Marine to acknowledge them. Award recommendations track from draft to presented.</li>
            <li>Invitations are links that work for seven days. If email is configured they are sent for you.</li>
          </ul>
        </Panel>
        <Panel title="Signing in on personal devices">
          <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-ink-2">
            <li>Use a long password, fifteen characters or more. A sentence you can remember beats symbols you cannot.</li>
            <li>Add a <strong className="text-ink">passkey</strong> in Settings → Security. Face ID, Windows Hello, or a hardware key then signs you in without typing anything, and cannot be phished.</li>
            <li>Turn on an <strong className="text-ink">authenticator app</strong> for a second step. Store the recovery codes somewhere other than the phone.</li>
            <li>Sensitive settings ask for your password again. That step-up lasts ten minutes.</li>
          </ul>
        </Panel>
        <Panel title="Keyboard shortcuts"><ul className="grid grid-cols-1 gap-1.5 text-sm sm:grid-cols-2">{SHORTCUTS.map(([k, v]) => <li key={k} className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-1.5"><span className="text-ink-2">{v}</span><Kbd>{k}</Kbd></li>)}</ul></Panel>
        <Panel title="AI assistance" subtitle="when the owner has enabled it">
          <p className="text-sm leading-relaxed text-ink-2">Drafting help runs through GenAI.mil, the Department's approved gateway, using the model you pick in Settings. Only the fields needed for the task are sent, never private records of other Marines. Every suggestion is a draft: check every figure, date, and reference before you use it. Nothing is saved automatically, and every request is logged.</p>
        </Panel>
        <Panel title="References" subtitle={`verified ${EVAL_VERIFIED}; the order on MOL is authoritative`}>
          <ul className="space-y-1.5 text-sm">{Object.entries(EVAL_REFERENCES).map(([k, r]) => <li key={k}><a className="link inline-flex items-center gap-1" href={r.url} target="_blank" rel="noopener noreferrer">{r.citation}<ExternalLink className="h-3 w-3" /></a>{r.system && <span className="text-ink-3"> · {r.system}</span>}</li>)}</ul>
        </Panel>
        <p className="text-2xs text-ink-3">Vantage v{VERSION}. Not a system of record. Marine Online is.</p>
      </div>
    </div>
  );
}
