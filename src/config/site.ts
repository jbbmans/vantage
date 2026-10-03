/**
 * What the public page says about itself, in one place: public.html's head, the prerendered page, the
 * structured data and the sitemap all read from here, so search engines are told one consistent story.
 */

export const SITE = {
  name: 'Vantage',
  alternateName: 'VANTAGE USMC',
  /** Under 60 characters, so results show it whole. */
  title: 'VANTAGE USMC | Marine Performance & JEPES/FITREP Input',
  /** Under 160 characters for the same reason. */
  description: 'Vantage helps Marines and their leaders track work, performance records, readiness and goals, and build JEPES and FITREP input from traceable evidence.',
  imageAlt: 'The Vantage mark beside the words Performance, Productivity, Readiness',
  disclaimer: 'Vantage is an independent software project. It is not affiliated with, endorsed by or sponsored by the Department of Defense, the Department of the Navy or the U.S. Marine Corps, and it is not an official system of record.',
  /** The date the public page last changed in substance. The sitemap reports it; bump it when the page does. */
  updated: '2026-09-29',
} as const;

export const FAQS: ReadonlyArray<readonly [string, string]> = [
  ['What is Vantage?', 'Vantage is a self-hosted performance, productivity, readiness, work-management, reporting and decision-support platform. It turns day-to-day operational work into clear, traceable records, and those records into the views and reports a Marine and their leaders actually use.'],
  ['Who is Vantage for?', 'Individual Marines, NCOs and team leaders, staff sections such as a comptroller’s budget and execution shop, command teams, and the people who run a deployment. Each sees the part of the picture their role allows.'],
  ['Is Vantage an official Marine Corps system?', 'No. Vantage is an independent software project and is not an official Department of Defense or U.S. Marine Corps system of record. It complements approved processes and systems; it does not replace them, and it never writes to them.'],
  ['What can teams track?', 'Work actions and outcomes, configurable value metrics, projects, spreadsheet-driven queues, cases that follow cited procedures, goals, correspondence, readiness dates, training, awards, counselings and report drafts.'],
  ['Does it help financial management analysts?', 'Yes. Imported open balances are read in lifecycle order (commitment, obligation, delivered, paid), the open condition is named, and each case can follow a versioned procedure with its evidence gates. The reference content it uses is training material, and Vantage labels it that way rather than presenting it as policy.'],
  ['Can it support Marine Corps performance documentation?', 'Vantage organises source records and drafts material that can help prepare JEPES or FITREP input. Official submissions still belong in the authoritative systems and processes.'],
  ['How does Vantage handle accountability?', 'Every case keeps an append-only history that is sealed and signed, access follows current unit membership, and important changes are attributable in a hash-chained audit log. Outputs can be traced back to the facts used to make them.'],
  ['Does Vantage use AI?', 'Only when the deployment owner enables it, and only through GenAI.mil. AI sits inside the workflows where it helps, never as a separate destination, and everything it drafts is something a person reviews.'],
];
