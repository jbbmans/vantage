import { cite } from './source.ts';

/**
 * Financial data and pre-execution setup (FMRAC ch. 5).
 *
 * A Financial Data Element (FDE) is a coded identifier used in budgeting, accounting or reporting.
 * FDEs connect an event to the right resources; a mismatched fiscal year, appropriation, POET or
 * document identifier is one of the commonest reasons an interface fails or a payment goes
 * unmatched.
 */

export const FDE = {
  definition: 'A coded identifier used in budgeting, accounting or reporting. FDEs connect an event to the correct resources.',
  why: 'Accurate data supports standardization, auditability, reporting and interfaces.',
  cite: cite('5.1', '65-68'),
};

/** POET: Project, Organization, Expenditure Type, Task. The examples are training specimens, not live funding data. */
export const POET = [
  { element: 'Project', meaning: 'The activity or effort being funded; drives spending controls.', example: 'M12000_251106_HQBSLN' },
  { element: 'Organization', meaning: 'The executing command (shown as L4 in the example).', example: 'T_M12000.2D MARINE DIV' },
  { element: 'Expenditure Type', meaning: 'The category of purchase.', example: '260.10 Office Supplies' },
  { element: 'Task', meaning: 'Work or commodity grouping within a project.', example: 'M12001_BNOPS' },
] as const;

export const SLOA = {
  definition: 'The Standard Line of Accounting: the standardized DoD accounting string the book describes.',
  fieldCount: 16,
  namedFields: [
    'Department Code', 'Fiscal Year', 'Main Account Code', 'Object Class', 'Budget Line Item', 'Agency Accounting Identifier',
    'Funding Center', 'Cost Center', 'Project', 'Task', 'Expenditure Type',
  ],
  specimen: '017 2021 2021 1106 000 320 D 1A1A 0000 00008522 044320 M67898 M37898.M20500_MA M47898_0001_000000_000000 M37898_21005BJK0 320.20 Building',
  limit: 'Page 67 says an SLOA has 16 elements but names only these and gives no position-by-position definition. No field specification is invented here, and the specimen is a training example.',
  translation: 'The book shows translation between another agency’s FDEs, the SLOA, and Marine Corps POET. The strings are not interchangeable without mapping.',
  cite: cite('5.1', '67'),
} as const;

/** Method identifiers and what generates them. Preserve the issued identifier; never regenerate one from its appearance. */
export const GENERATORS = [
  { methods: ['servmart'], identifier: 'ServMart JON', generator: 'GSA Alias Table load request', owner: 'HQMC (P&R), L1; FMRA prepares/validates the request' },
  { methods: ['fuel'], identifier: 'Fuel key combination', generator: 'Fuel Key Alias Table load request', owner: 'HQMC (P&R), L1; FMRA prepares/validates the request' },
  { methods: ['gcss'], identifier: 'Cost JON / CostJON', generator: 'GCSS-MC JON Builder', owner: '3451 FMRA; FDM role used for system loading (p. 96)' },
  { methods: ['tdy'], identifier: 'DTS LOA', generator: 'DTS Label Report', owner: 'FDTA, 3451; creates LOAs and DTS budgets' },
  { methods: ['gpc', 'contract', 'mipr'], identifier: 'DAI POET', generator: 'FCCCB POET Load Sheet', owner: 'HQMC (P&R), L1' },
] as const;

export const FCCCB = 'Fiscal Code Configuration Control Board (expanded on orig. p. 78).';
export const JON = 'The book’s job/order accounting identifier. Preserve the exact issued identifier rather than regenerating one from its appearance.';

/** The foundation every Block III narrative begins with. */
export const SHARED_SETUP = [
  'The comptroller office determines the fiscal year’s POET structure before the fiscal year starts.',
  'Budget Officer(s) complete the FCCCB POET Load Sheet.',
  'The load sheet goes to L1, HQMC Programs and Resources (P&R).',
  'L1 loads the POET structure into DAI.',
  'Additional POETs may be created during the year as needed.',
] as const;

export const SETUP_RULE = {
  text: 'A POET load is not proof of sufficient available funding. The method also needs the correct feeder configuration, approved access, and resources for the intended transaction.',
  cite: cite('5.3', '65-76'),
};

export const METHOD_SETUP = [
  { methods: ['servmart', 'fuel'], adds: 'Card or key alias mapping.' },
  { methods: ['gcss'], adds: 'CostJONs, approval groups and budget journals.' },
  { methods: ['tdy'], adds: 'LOAs and budget shells.' },
  { methods: ['mipr'], adds: 'The agreement and the other agency’s financial-contact preparation.' },
] as const;
