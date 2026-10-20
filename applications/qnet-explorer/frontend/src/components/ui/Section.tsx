// A section (B-SPEC 5.14): a hairline on top, the section rhythm, and a head with the title on the left (7 of 12
// columns) and the lead on the right (5), aligned to the bottom. Tool pages use the tighter rhythm.

import type { ReactNode } from 'react';

interface SectionProps {
  id?: string;
  title?: ReactNode;
  lead?: ReactNode;
  variant?: 'home' | 'tool';
  className?: string;
  children: ReactNode;
}

export default function Section({ id, title, lead, variant = 'home', className, children }: SectionProps) {
  const headId = id ? `${id}-h` : undefined;
  return (
    <section id={id} className={`sec${className ? ` ${className}` : ''}`} data-variant={variant === 'tool' ? 'tool' : undefined} aria-labelledby={title ? headId : undefined}>
      <div className="wrap">
        {title && (
          <div className="sec-head">
            <h2 id={headId} className="h2">{title}</h2>
            {lead && <p className="lead">{lead}</p>}
          </div>
        )}
        {children}
      </div>
    </section>
  );
}
