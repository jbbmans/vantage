/**
 * Vantage — evaluation references (v3.3 findings 23, 48, 50).
 *
 * One place for every policy citation the evaluation pages make, so a new MCO
 * or MARADMIN is a one-line change here rather than a hunt through components.
 * Verified against marines.mil on the date below; when that date gets stale,
 * re-verify before trusting the citations.
 *
 * Rule of the file: only official marines.mil / official-command URLs. Never
 * link a third-party calculator or aggregator from the product.
 */

export const EVAL_VERIFIED = '2026-08-20';

export const EVAL_REFERENCES = {
  jepes: {
    system: 'Junior Enlisted Performance Evaluation System',
    order: 'MCO 1616.1',
    citation: 'MCO 1616.1 (25 Nov 2020, effective 1 Feb 2021)',
    url: 'https://www.marines.mil/News/Publications/MCPEL/Electronic-Library-Display/Article/2431802/mco-16161/',
    updates: [
      { id: 'MARADMIN 025/21', note: 'MarineNet self-education points became CEUs', url: 'https://www.marines.mil/News/Messages/Messages-Display/Article/2473454/' },
      { id: 'MARADMIN 367/21', note: 'MOS Courses and Qualifications initiative', url: 'https://www.marines.mil/News/Messages/Messages-Display/Article/2693294/' },
      { id: 'MARADMIN 272/22', note: 'JEPES retention score', url: 'https://www.marines.mil/News/Messages/MARADMINS/' },
      { id: 'MARADMIN 046/24', note: 'MOS Qualifications expanded to all MOSs; reported via MCTIMS', url: 'https://www.marines.mil/News/Messages/Messages-Display/Article/3662965/' },
    ],
    // The four-pillar / 1,000-point framework is public in the order. The
    // per-element point tables (Appendix B) and the annual peer-percentile
    // distributions are not — MOL is the only authoritative score.
    authoritative: 'Your JEPES score on Marine Online (MOL) is the only official number.',
  },
  fitrep: {
    system: 'Performance Evaluation System (fitness reports)',
    order: 'MCO 1610.7B',
    citation: 'MCO 1610.7B (5 Jun 2023)',
    url: 'https://www.marines.mil/News/Publications/MCPEL/Electronic-Library-Display/Article/1513503/mco-16107b/',
    updates: [],
    authoritative: 'Your report is written by your Reporting Senior; the record of it lives on MOL.',
  },
  pftcft: {
    order: 'MCO 6100.13A',
    citation: 'MCO 6100.13A w/ CH-5 (28 May 2025; plank finalized by CH-4, 23 Mar 2022)',
    url: 'https://www.marines.mil/Portals/1/Publications/MCO%206100.13A%20W%20ADMIN%20CH-5%20(SECURED).pdf',
    updates: [
      { id: 'MARADMIN 613/25', note: 'From 1 Jan 2026, combat-arms PMOS Marines score on the male age-normed tables and need a 210 minimum', url: 'https://www.marines.mil/News/Messages/Messages-Display/Article/4363582/' },
      { id: 'MARADMIN 066/26', note: 'Body composition moved to a waist-to-height standard (0.52 or less)', url: 'https://www.marines.mil/News/Messages/Messages-Display/Article/4414762/' },
    ],
  },
  arq: {
    order: 'MCO 3574.2M',
    citation: 'MCO 3574.2M (6 Apr 2022)',
    url: 'https://www.marines.mil/News/Publications/MCPEL/Electronic-Library-Display/Article/2996982/mco-35742m/',
  },
  mcmap: {
    order: 'MCO 1500.59A',
    citation: 'MCO 1500.59A (23 Sep 2019)',
    url: 'https://www.marines.mil/News/Publications/MCPEL/Electronic-Library-Display/Article/899428/mco-150059a/',
  },
  mcpel: { label: 'Marine Corps publications library', url: 'https://www.marines.mil/News/Publications/MCPEL/' },
};

/**
 * Every recommendation Vantage shows carries one of these kinds, so a Marine
 * can always tell a policy pointer from Vantage's opinion (finding 22).
 */
export const REC_KINDS = {
  data: { label: 'From your log', tone: 'neutral' },
  heuristic: { label: 'Coaching heuristic', tone: 'signal' },
  official: { label: 'Official reference', tone: 'ledger' },
};
