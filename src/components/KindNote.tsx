import { Award, GraduationCap } from 'lucide-react';
import type { KindReading } from '../../shared/recordKinds';

const PLACE: Record<KindReading['kind'], string> = {
  award: 'Awards have their own record under Career, with the citation and who signed off.',
  training: 'Courses, PME and qualifications have their own record under Career.',
};

/**
 * A word, while an entry is being written, that it reads like an award received or training completed, which keep records
 * of their own (ADR-0015). It only suggests: the entry can always be saved as an activity, and the words are the owner's call.
 */
export function KindNote({ reading, note, children }: { reading: KindReading; note?: React.ReactNode; children: React.ReactNode }) {
  const Icon = reading.kind === 'award' ? Award : GraduationCap;
  return (
    <div className="rounded-md border border-line bg-surface-2/60 px-3 py-2.5 text-sm">
      <p className="flex items-start gap-2 leading-snug text-ink-2">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
        <span><span className="font-medium text-ink">{reading.why}</span> {PLACE[reading.kind]}{note ? <> {note}</> : null}</span>
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2 pl-6">{children}</div>
    </div>
  );
}
