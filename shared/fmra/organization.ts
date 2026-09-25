import { cite } from './source.ts';

export const MISSION = 'Financial management supports a unit’s ability to equip, train, deploy and sustain its forces. A requirement begins with a mission need: the using unit requests the good or service, supply and procurement arrange it, and the comptroller organization manages and accounts for the resources.';

export const MAGTF = [
  { key: 'CE', name: 'Command Element', function: 'Plans, coordinates and controls operations.' },
  { key: 'GCE', name: 'Ground Combat Element', function: 'Ground combat capability, including infantry and artillery.' },
  { key: 'ACE', name: 'Aviation Combat Element', function: 'Aviation support, transport and firepower.' },
  { key: 'LCE', name: 'Logistics Combat Element', function: 'Supply, maintenance, transportation, medical support and sustainment.' },
] as const;

export const ORG_MODEL = {
  chain: ['HQMC', 'MARFORs', 'MEFs', 'MSCs', 'Using units'],
  note: 'The book’s teaching model. Its claim that each MARFOR commands a MEF is not a safe universal routing rule.',
  hqmc: 'Central policy, strategic guidance and oversight.',
  marfors: 'MARFORPAC (Pacific / Indo-Pacific), MARFORCOM (East Coast forces and Northern Command support), and MARCENT, MARFOREUR/AF, MARFORK and MARSOC for geographic or mission-specific responsibilities. Context, not a current directory.',
  mef: 'The largest standing MAGTF. Major formations: Marine Divisions (MARDIV), Marine Aircraft Wings (MAW), Marine Logistics Groups (MLG), Marine Information Groups (MIG). MEUs provide rapidly deployable task forces.',
  usingUnits: 'Battalions, squadrons and companies turn higher-level direction into daily operations and submit the requirements that drive financial execution.',
  cite: cite('1.1', '1-10'),
} as const;

export const GROUND_UNITS = [
  { unit: 'Marine Division', led: 'Major General', detail: 'The largest organized GCE formation, with infantry and artillery regiments and supporting units. Generates, deploys and returns forces.' },
  { unit: 'Infantry regiment', led: 'Colonel', detail: 'Normally three infantry battalions and a Headquarters and Service Company.' },
  { unit: 'Infantry battalion', led: 'Lieutenant Colonel', detail: 'Staff principals support functional execution. The commander sets priorities, directs planning and readiness, manages risk and sustainment, and delegates authority while retaining ultimate responsibility.' },
] as const;

export const STAFF_SECTIONS = [
  { key: 'S-1', function: 'Personnel accountability, administration, and pay-impacting actions.' },
  { key: 'S-2', function: 'Intelligence and threat assessment.' },
  { key: 'S-3', function: 'Operations, training plans, scheduling, orders and certifications.' },
  { key: 'S-4', function: 'Logistics, supply, maintenance, transportation and sustainment.' },
  { key: 'S-6', function: 'Communications, networks, radios, data systems and communications security.' },
] as const;

export const ORG_NOTE = {
  text: 'The source abbreviates Marine Logistics Group as MIG in one passage. This reference uses MLG for logistics and reserves MIG for Marine Information Group.',
  cite: cite('1.1', '3', 'discrepancy'),
};
