import React from 'react';
import { Link } from 'react-router-dom';
import { DOLLAR_TYPES } from '@/lib/constants';
import { formatDollarsExact } from '@/lib/metrics';

export default function DollarTypeBreakdown({ amounts = {}, linkToRecords = false, className = '' }) {
  return (
    <section className={className} aria-label="Transaction value by dollar type">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-rule bg-rule sm:grid-cols-5">
        {DOLLAR_TYPES.map((type) => {
          const content = (
            <>
              <span className="eyebrow block">{type.label}</span>
              <strong className="fig mt-1 block text-base font-medium text-text">
                {formatDollarsExact(Number(amounts[type.key]) || 0)}
              </strong>
              <span className="mt-1 block text-2xs text-text-3">
                {type.summable ? 'included in headline' : 'tracked separately'}
              </span>
            </>
          );

          return linkToRecords ? (
            <Link
              key={type.key}
              to={`/activities?dollarType=${encodeURIComponent(type.key)}`}
              className="bg-panel px-3 py-2.5 transition-colors hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-signal"
              aria-label={`View ${type.label.toLowerCase()} transaction values`}
            >
              {content}
            </Link>
          ) : (
            <div key={type.key} className="bg-panel px-3 py-2.5">
              {content}
            </div>
          );
        })}
      </div>
    </section>
  );
}
