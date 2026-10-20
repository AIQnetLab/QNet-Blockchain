// The site's actions (B-SPEC 5.5): solid (one per view), text (secondary, an underline always there) and act (a small
// action inside a line of data; quiet for Cancel and Close). No arrows (owner 19.10): an action is shown by its fill or
// its underline alone. An internal href is a client-side link, an external one opens in a new tab, no href is a button.

import Link from 'next/link';
import type { MouseEventHandler, ReactNode } from 'react';

export type ActionKind = 'solid' | 'text' | 'act' | 'quiet';

interface ActionProps {
  kind?: ActionKind;
  href?: string;
  // A link off the site.
  external?: boolean;
  small?: boolean;
  busy?: boolean;
  disabled?: boolean;
  onClick?: MouseEventHandler<HTMLElement>;
  type?: 'button' | 'submit';
  className?: string;
  children: ReactNode;
}

const CLASS: Record<ActionKind, string> = { solid: 'btn btn-solid', text: 'btn btn-text', act: 'act', quiet: 'act quiet' };

export default function Action({ kind = 'text', href, external, small, busy, disabled, onClick, type = 'button', className, children }: ActionProps) {
  const cls = `${CLASS[kind]}${small && kind === 'solid' ? ' btn-sm' : ''}${className ? ` ${className}` : ''}`;
  if (href && !disabled) {
    if (external) {
      return <a className={cls} href={href} target="_blank" rel="noopener noreferrer" onClick={onClick}>{children}</a>;
    }
    return <Link className={cls} href={href} onClick={onClick}>{children}</Link>;
  }
  return (
    <button type={type} className={cls} onClick={onClick} disabled={disabled || busy} aria-busy={busy || undefined}>
      {children}
    </button>
  );
}
