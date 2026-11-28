import { PageShell } from '@/components/common';
import MarineStatisticsView from '@/components/MarineStatistics';
import { usePlace } from '@/lib/place';

/** One's own statistics (ADR-0051): every record one keeps, over a range, month by month. */
export default function Statistics() {
  const place = usePlace();
  return (
    <PageShell eyebrow={place.group} title="Statistics" lede="Your own record over a range: entries and outcomes, duty, training and awards, counseling, and what you added in Vantage, counted as the Analysis and the Duty report count them. Nobody else’s figures are read or compared.">
      <MarineStatisticsView />
    </PageShell>
  );
}
