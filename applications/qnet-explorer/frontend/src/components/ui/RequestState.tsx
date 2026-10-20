// A request to a wallet, the network or a server, in the slot of the control that started it (B-SPEC 5.22): waiting
// (what to do, the blinking cursor, Cancel where it can be cancelled), answered (the answer, Start again where it applies)
// or failed (what happened and what to do, Try again). Answers to the visitor's own actions are announced.

import type { ReactNode } from 'react';
import Action from './Action';

interface LineProps {
  children: ReactNode;
  // The small action after the line, with its words.
  action?: { label: string; onClick: () => void } | null;
}

export function Waiting({ children, action }: LineProps) {
  return (
    <div className="rq">
      <p className="wait" role="status">{children}</p>
      {action && <Action kind="quiet" onClick={action.onClick}>{action.label}</Action>}
    </div>
  );
}

export function Answered({ children, action }: LineProps) {
  return (
    <div className="rq">
      <p className="rq-answer" role="status">{children}</p>
      {action && <Action kind="act" onClick={action.onClick}>{action.label}</Action>}
    </div>
  );
}

export function Failed({ children, action }: LineProps) {
  return (
    <div className="rq">
      <p className="rq-failed" role="alert">{children}</p>
      {action && <Action kind="act" onClick={action.onClick}>{action.label}</Action>}
    </div>
  );
}
