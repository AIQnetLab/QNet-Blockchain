// My node's building blocks (B-SPEC 5.14, 6.7): rows and space, no cards. A titled group of rows, label/value rows, the
// notes under a block and the numbered steps of a flow, shared by every section.

import { useId, type ReactNode } from 'react';
import { t } from '@/lib/texts';

// A titled group: a hairline on top, the title (with an optional datum or link at its right), then its rows. `level` 3
// under a section that has its own title (Activate).
export function Group({ id, title, meta, level = 2, children, className }: {
  id?: string; title?: ReactNode; meta?: ReactNode; level?: 2 | 3; children: ReactNode; className?: string;
}) {
  const headId = useId();
  const Heading = level === 3 ? 'h3' : 'h2';
  return (
    <section id={id} className={`cab-group${className ? ` ${className}` : ''}`} aria-labelledby={title ? headId : undefined}>
      {title && (
        <div className="cab-group-head">
          <Heading className="cab-h" id={headId}>{title}</Heading>
          {meta}
        </div>
      )}
      {children}
    </section>
  );
}

// One action with its title and what it does (the Device tab's two, side by side on a computer).
export function ActionBlock({ title, children }: { title: ReactNode; children: ReactNode }) {
  const headId = useId();
  return (
    <section className="cab-act" aria-labelledby={headId}>
      <h3 className="h3" id={headId}>{title}</h3>
      {children}
    </section>
  );
}

// Label/value rows (details): the label on the left, the value on the right; stacked on a phone.
export function Facts({ children }: { children: ReactNode }) {
  return <dl className="cab-facts">{children}</dl>;
}

export function Fact({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

// The one next step (B-SPEC 5.14): what to do in at most two sentences, then at most one solid action.
export function Next({ children, action, alert = false }: { children: ReactNode; action?: ReactNode; alert?: boolean }) {
  return (
    <div className="cab-next" role={alert ? 'alert' : undefined}>
      {children}
      {action && <div className="cab-next-act">{action}</div>}
    </div>
  );
}

// The notes under the block they explain.
export function Notes({ children }: { children: ReactNode }) {
  return <div className="cab-notes">{children}</div>;
}

export type StepAt = 'done' | 'now' | 'ahead';

// A numbered list whose order is the information (the activation, the way to a running node): each step its number,
// its title with Done or Now after it, and what it holds.
export function Steps({ label, children }: { label?: string; children: ReactNode }) {
  return <ol className="cab-steps" aria-label={label}>{children}</ol>;
}

// `level` 4 under a group whose own title is an h3.
export function Step({ n, at, title, level = 3, children }: { n: number; at: StepAt; title: ReactNode; level?: 3 | 4; children?: ReactNode }) {
  const Heading = level === 4 ? 'h4' : 'h3';
  return (
    <li className="cab-step" data-at={at} aria-current={at === 'now' ? 'step' : undefined}>
      <span className="cab-step-n" aria-hidden="true">{n}</span>
      <div className="cab-step-body">
        <Heading className="cab-step-t">
          {title}
          {at !== 'ahead' && <span className="cab-step-k">{t(at === 'done' ? 'progress_done' : 'progress_now')}</span>}
        </Heading>
        {children}
      </div>
    </li>
  );
}
