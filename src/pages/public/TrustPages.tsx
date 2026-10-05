import type { ReactNode } from 'react';
import { CHANGES, LATEST_CHANGE } from '@/config/changes';
import { VERSION } from '@/lib/version';

/**
 * The public site's plain-language pages: how Vantage is secured, how accessible it is, what it keeps about a
 * person, and what changed lately. Each statement here is something the code does today; where a deployment chooses (AI, email, scanning),
 * the page says so rather than promising it. scripts/prerender.mjs renders each one into its own document, and the
 * server answers its path with that document (server/app.ts, TRUST_DOCUMENTS).
 */
export interface TrustSection { id: string; title: string; body: ReactNode }
export interface TrustPage {
  path: '/security' | '/accessibility' | '/privacy' | '/changes';
  /** The document title, under 60 characters. */
  title: string;
  /** The meta description, under 160 characters. */
  description: string;
  eyebrow: string;
  heading: string;
  lede: string;
  /** When the page last changed in substance. */
  updated: string;
  sections: TrustSection[];
}

const longDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

const Facts = ({ items }: { items: Array<[string, string]> }) => (
  <dl className="ps-doc-facts">{items.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
);

const SECURITY: TrustPage = {
  path: '/security',
  title: 'Security | Vantage',
  description: 'How Vantage protects the records it keeps: sign-in, access by unit membership, sealed histories, a strict browser policy, and how to report a vulnerability.',
  eyebrow: 'Security',
  heading: 'Built so a record can answer for itself.',
  lede: 'What protects the work and records people keep in Vantage, what a deployment decides for itself, and how to tell us about a weakness.',
  updated: '2026-10-03',
  sections: [
    {
      id: 'glance', title: 'At a glance',
      body: <Facts items={[
        ['Passwords', '15 characters or more, hashed with PBKDF2-HMAC-SHA256'],
        ['Second factors', 'Passkeys, authenticator codes with recovery codes, or CAC/PIV'],
        ['Organization sign-in', 'OpenID Connect, including Entra ID in commercial, GCC High and DoD clouds'],
        ['Sessions', 'End after 15 idle minutes (10 for owners); a background poll cannot keep one alive'],
        ['Failed sign-ins', 'Three in a row pause the account for 15 minutes'],
        ['Records', 'Private by default; shared with a unit only when the author chooses'],
        ['History', 'Case histories and the audit log are hash-chained and signed'],
        ['Third parties in the browser', 'None: no analytics, tag managers, ad scripts or remote fonts'],
      ]} />,
    },
    {
      id: 'sign-in', title: 'Signing in',
      body: <>
        <p>Every account has a password of at least fifteen characters, checked against common and repeated patterns and stored only as a PBKDF2-HMAC-SHA256 hash. A passkey (WebAuthn), an authenticator app with single-use recovery codes, or a Common Access Card adds the second factor. A deployment can also hand sign-in to its organization’s identity provider over OpenID Connect, with PKCE, a single-use state and nonce, and the token checked against the provider’s keys.</p>
        <p>Sensitive changes (email, second factors, passkeys, the owner console) ask for the password again. Everyone can see the devices they are signed in on and end any of them. A deployment can require the DoD Notice and Consent Banner before anyone signs in, and the server enforces it, not only the page.</p>
      </>,
    },
    {
      id: 'access', title: 'Who can see what',
      body: <>
        <p>A Marine’s record is private until they share an entry with a unit. Leaders see what was shared with the units they lead, and the units beneath them; access flows down the chain of command and never up. Leaving a unit ends access to its work at once, and work that was held goes back to the queue with the reason recorded.</p>
        <p>No role in the application, including the instance owner, can open another person’s private entries. When a leader opens a member’s record, that is itself logged in the unit’s access log. Team totals drawn from fewer than three people are withheld so a total cannot be used to single someone out.</p>
      </>,
    },
    {
      id: 'integrity', title: 'Integrity you can check',
      body: <>
        <p>Every entry on a case is appended to a per-case chain that is sealed with a keyed hash and a signed head. Each day the heads are anchored in a hash-chained audit log of sign-ins, access and changes. The owner console verifies both chains; a changed, removed or inserted entry shows as broken, never as merely unsealed. Audit records can also be sent off the host to a syslog collector or SIEM as they are written.</p>
        <p>Corrections are added, never edited in place: the original stays in the history, marked as corrected, and anything calculated from it is shown as stale.</p>
      </>,
    },
    {
      id: 'browser', title: 'In the browser',
      body: <>
        <p>Pages carry a strict Content Security Policy (scripts only from this site, each inline script allowed by its hash), HSTS, and headers that forbid framing, cross-origin embedding and referrer leakage. The session cookie is HttpOnly, Secure and SameSite, and every change needs a header a forged cross-site request cannot send. Nothing is loaded from another site: fonts, icons and films are served from the deployment itself.</p>
      </>,
    },
    {
      id: 'files', title: 'Files and imports',
      body: <>
        <p>Attachments and imported spreadsheets and email have size limits, and a workbook is charged for its real expanded size, not what it claims. A deployment can scan every upload with ClamAV and refuse what could not be scanned. Imported email is shown with remote images and active content blocked.</p>
      </>,
    },
    {
      id: 'deployment', title: 'For your ISSM',
      body: <>
        <p>Vantage is an independent project. It holds no FedRAMP authorization and no Authority to Operate of its own; a command that runs it does so inside its own environment, under that environment’s controls and its own authorization process. To help with that:</p>
        <ul>
          <li>It runs as one Node.js process with a local volume behind your own TLS proxy, and makes no outbound requests by default. AI, the MARADMIN feed and search-engine notices are each off until an owner turns them on.</li>
          <li>When AI is turned on it goes only to GenAI.mil, the key stays on the server, and a request carries only the fields that workflow needs.</li>
          <li>Records management is built in: retention schedules with their authority, legal holds that stop every path that could delete, and disposition evidence for every run.</li>
          <li>A privacy-impact data inventory is generated from the live database schema, so it cannot quietly stop being true.</li>
          <li>Every build is linted, type-checked and tested; dependencies are audited; a CycloneDX software bill of materials is published; the code is scanned with CodeQL and the image with Trivy; the base image is pinned by digest.</li>
        </ul>
        <p>The public site at this address is a demonstration host run on commercial infrastructure. It is not accredited for classified information or Controlled Unclassified Information.</p>
      </>,
    },
    {
      id: 'report', title: 'Report a vulnerability',
      body: <>
        <p>If you find a weakness, please tell us privately before telling anyone else. Send it through the <a href="/login?help=security">request form</a> (no account needed), or to the contact in <a href="/.well-known/security.txt">security.txt</a>. Include the version (the address <code>/api/health</code> reports it), the steps to reproduce, and what an attacker could do with it.</p>
        <p>We will not pursue or support legal action against anyone who reports in good faith, tests only against their own account or a local copy, avoids privacy violations and disruption, and gives us reasonable time to fix the problem before disclosing it. Please do not run automated scans against this site, try to reach other people’s data, or test denial of service.</p>
      </>,
    },
  ],
};

const ACCESSIBILITY: TrustPage = {
  path: '/accessibility',
  title: 'Accessibility | Vantage',
  description: 'Vantage aims to meet WCAG 2.2 Level AA and Section 508. How it is tested, what works by keyboard, known limitations, and how to report a barrier.',
  eyebrow: 'Accessibility',
  heading: 'Usable by everyone who has to use it.',
  lede: 'Vantage aims to conform to the Web Content Accessibility Guidelines (WCAG) 2.2 at Level AA, which is also the standard Section 508 points to.',
  updated: '2026-10-03',
  sections: [
    {
      id: 'testing', title: 'How it is tested',
      body: <>
        <p>Every change runs an automated accessibility check (axe-core) against the core pages, the case page, the reference and this public site, in both the light and dark themes, and the build fails on any serious or critical problem. Colour tokens are generated to clear contrast thresholds: body text 14:1 or better, muted text at least 4.5:1 on every surface it can sit on.</p>
        <p>Automated checks find only part of what matters. Vantage has not yet had an independent accessibility audit.</p>
      </>,
    },
    {
      id: 'keyboard', title: 'Keyboard and screen readers',
      body: <>
        <p>Everything can be reached and used from the keyboard, with a visible focus ring and a link to skip to the content. Dialogs keep focus inside them and return it when they close. Fields carry their own labels, hints and errors, and charts that matter carry a table a screen reader can read.</p>
        <Facts items={[
          ['⌘K or Ctrl+K', 'Search anything, and go anywhere'],
          ['N', 'Log what you did, from any page'],
          ['G then a letter', 'Go to a destination (G then D for Today)'],
          ['V', 'Switch between your command and its teams'],
          ['?', 'Every shortcut'],
        ]} />
      </>,
    },
    {
      id: 'display', title: 'Seeing it your way',
      body: <>
        <p>Light and dark themes follow your device unless you choose one. Twelve colour palettes are available under Settings, each checked for contrast. Motion is turned off when your device asks for reduced motion, and every page is laid out for a phone as well as a desk. The films on this page have captions on by default.</p>
      </>,
    },
    {
      id: 'limits', title: 'Known limitations',
      body: <>
        <ul>
          <li>Some dense tables (the queue, workload by person) scroll sideways on a narrow screen rather than reflowing.</li>
          <li>The films have captions but no audio description.</li>
          <li>Generated PDFs are not tagged for screen readers; what they contain is always available as a page in the app.</li>
        </ul>
      </>,
    },
    {
      id: 'feedback', title: 'Report a barrier',
      body: <>
        <p>If something in Vantage is hard or impossible for you to use, tell us through the <a href="/login?help">request form</a> (no account needed) or, once signed in, from Support. Say which page, what you were trying to do, and what assistive technology you use. A barrier is treated as a defect, not a feature request.</p>
      </>,
    },
  ],
};

const PRIVACY: TrustPage = {
  path: '/privacy',
  title: 'Privacy | Vantage',
  description: 'What Vantage keeps about a person, who can see it, how long it is kept, and what it never collects: no trackers, no advertising, no selling of data.',
  eyebrow: 'Privacy',
  heading: 'Your record is yours.',
  lede: 'What Vantage keeps, why, who can see it and for how long. Each deployment is run by its own owner, who decides some of this; where they do, the page says so.',
  updated: '2026-10-03',
  sections: [
    {
      id: 'never', title: 'What Vantage never does',
      body: <Facts items={[
        ['Tracking', 'No analytics, tag managers, advertising or social scripts, on this site or in the app'],
        ['Selling or sharing', 'Nothing about anyone is sold, rented or shared for marketing'],
        ['Profiling', 'People are never scored, ranked or labelled; counts are not a measure of effort'],
        ['Systems of record', 'Vantage never writes to an official Marine Corps or DoD system'],
      ]} />,
    },
    {
      id: 'keeps', title: 'What it keeps',
      body: <>
        <ul>
          <li><strong>Your account:</strong> name, username, rank, MOS, units and roles, and an email address if you give one (for reset links and the weekly digest).</li>
          <li><strong>Your work and record:</strong> what you log, the work you claim and act on, goals, training, awards, counselings, readiness dates and the files you attach.</li>
          <li><strong>Security records:</strong> sign-in times, the address and browser of each session, and an audit log of access and changes.</li>
          <li><strong>Usage counts:</strong> which screens are opened and whether a save worked, so the owner can see whether Vantage is working. These never contain anything you typed, are reported only as counts across people, and are deleted after about thirteen months.</li>
        </ul>
      </>,
    },
    {
      id: 'sees', title: 'Who can see it',
      body: <>
        <p>Entries are private until you share one with a unit. Leaders see what was shared with the units they lead, and every time a leader opens a member’s record it is logged. The deployment’s owner runs the server and could read its database directly, as anyone who runs a server can; the application itself gives no one, the owner included, a way to open your private entries.</p>
      </>,
    },
    {
      id: 'device', title: 'On your device',
      body: <>
        <p>Signing in sets two cookies: the session itself (HttpOnly, so scripts cannot read it) and a marker that you are signed in. Your browser’s storage remembers your theme, palette and whether the sidebar is collapsed, and holds anything you log while offline until it reaches the server. This public site sets no cookies at all.</p>
      </>,
    },
    {
      id: 'others', title: 'Services a deployment may use',
      body: <>
        <p>Off by default, and each a choice the owner makes: <strong>email</strong> (sent directly from the deployment’s own domain, or through a mail provider it names), <strong>AI drafting</strong> (only through GenAI.mil, sending only the fields the task needs, never another person’s private data, and nothing saved until you save it), and <strong>organization sign-in</strong> through your command’s identity provider.</p>
      </>,
    },
    {
      id: 'choices', title: 'Your choices',
      body: <>
        <ul>
          <li>Download everything tied to your account, at any time, from Settings → Your data: one JSON file and a CSV for each kind of record, with your attachments.</li>
          <li>Delete an entry and it goes to a recycle bin for thirty days, then is removed for good, unless a legal hold applies.</li>
          <li>Ask your unit leader or the owner to turn your account off.</li>
        </ul>
        <p>Retention schedules and legal holds are set by the deployment’s owner and state the authority they follow. Do not enter classified information, and keep sensitive personal details (such as Social Security numbers or medical specifics) out of free text.</p>
      </>,
    },
    {
      id: 'contact', title: 'Questions',
      body: <p>Ask through the <a href="/login?help">request form</a> (no account needed) or, once signed in, from Support. Vantage is an independent software project, not affiliated with, endorsed by or sponsored by the Department of Defense, the Department of the Navy or the U.S. Marine Corps.</p>,
    },
  ],
};

/** The same list the app's "What's new" shows (src/config/changes.ts), for anyone deciding whether Vantage is looked after. */
const CHANGELOG: TrustPage = {
  path: '/changes',
  title: 'What’s new | Vantage',
  description: 'What changed in Vantage, newest first: the fixes and improvements a Marine, a leader or an owner would notice.',
  eyebrow: 'What’s new',
  heading: 'What changed, and when.',
  lede: `Vantage ${VERSION}. The changes someone using it would notice, newest first.`,
  updated: LATEST_CHANGE,
  sections: CHANGES.map((change) => ({
    id: `changes-${change.date}`,
    title: `${change.title}, ${longDate(change.date)}`,
    body: <ul>{change.items.map((item) => <li key={item}>{item}</li>)}</ul>,
  })),
};

export const TRUST_PAGES: Record<TrustPage['path'], TrustPage> = { '/security': SECURITY, '/accessibility': ACCESSIBILITY, '/privacy': PRIVACY, '/changes': CHANGELOG };

export function trustPageFor(pathname: string): TrustPage | null {
  const path = (pathname.replace(/\/+$/, '') || '/') as TrustPage['path'];
  return Object.prototype.hasOwnProperty.call(TRUST_PAGES, path) ? TRUST_PAGES[path] : null;
}


/** The page's heading, set in the site's navy band. */
export function TrustHero({ page }: { page: TrustPage }) {
  return (
    <div id="ps-content" className="ps-container ps-doc-hero">
      <p className="ps-eyebrow ps-eyebrow-dark">{page.eyebrow}</p>
      <h1>{page.heading}</h1>
      <p className="ps-lede">{page.lede}</p>
      <p className="ps-doc-updated">Updated {longDate(page.updated)}</p>
    </div>
  );
}

/** The page's sections, with a contents list that stays in view on a wide screen. */
export function TrustBody({ page }: { page: TrustPage }) {
  return (
    <div className="ps-container ps-doc">
      <nav className="ps-doc-toc" aria-label="On this page">
        <p>On this page</p>
        <ol>{page.sections.map((s) => <li key={s.id}><a href={`#${s.id}`}>{s.title}</a></li>)}</ol>
      </nav>
      <article className="ps-doc-body">
        {page.sections.map((s) => (
          <section key={s.id} id={s.id} aria-labelledby={`${s.id}-title`}>
            <h2 id={`${s.id}-title`}>{s.title}</h2>
            {s.body}
          </section>
        ))}
      </article>
    </div>
  );
}
