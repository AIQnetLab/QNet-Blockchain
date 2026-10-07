// A text whose {name} slots hold elements (a link, an address). Server and client alike.

import { Fragment, type ReactNode } from 'react';
import { TEXTS, templateParts, type MessageKey } from './texts';

export function rich(key: MessageKey, nodes: Record<string, ReactNode>): ReactNode[] {
  return templateParts(TEXTS[key]).map((part, i) => (
    <Fragment key={i}>
      {typeof part === 'string' ? part : Object.prototype.hasOwnProperty.call(nodes, part.name) ? nodes[part.name] : `{${part.name}}`}
    </Fragment>
  ));
}
