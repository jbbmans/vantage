/**
 * The in-app tutorials (ADR-0034), by id. The server keeps which of them a person has finished in their preferences, so
 * it accepts only these; their steps are the web app's (src/config/tutorials.ts). In the order the Field guide lists them.
 */
export const TUTORIAL_IDS = [
  'getting-started',
  'logging-work',
  'personnel',
  'import-export',
  'error-reports',
  'case-diagnosis',
  'duty',
  'training',
  'certificates',
  'counselings',
  'reports',
  'analytics',
] as const;

export type TutorialId = (typeof TUTORIAL_IDS)[number];

export const isTutorialId = (id: unknown): id is TutorialId => typeof id === 'string' && (TUTORIAL_IDS as readonly string[]).includes(id);
