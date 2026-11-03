// A text whose {name} slots hold elements (a link, an address), in the translator's language. Server and client alike;
// a page reaches it as `rich` from its language (src/i18n), and a plain sentence it shows as `say`.

import { Fragment, type ReactNode } from 'react';
import { nameParts, templateParts, type MessageKey, type T, type Vars } from './texts';

export type Rich = (key: MessageKey, nodes: Record<string, ReactNode>) => ReactNode[];
export type Say = (key: MessageKey, vars?: Vars) => ReactNode;

// What the page shows, each product name in a text of it in an element of its own marked translate="no": a browser's
// page translation would rewrite "QNet Blockchain" as words of its language, and leaves the rest of the sentence
// translatable. An element passes as it is.
export function named(text: ReactNode): ReactNode {
  if (typeof text !== 'string') return text;
  const parts = nameParts(text);
  if (parts.length === 1 && typeof parts[0] === 'string') return text;
  return parts.map((part, i) => (typeof part === 'string' ? <Fragment key={i}>{part}</Fragment> : <span key={i} translate="no">{part.product}</span>));
}

export function richOf(t: T): Rich {
  return (key, nodes) => templateParts(t.catalog[key] ?? t(key)).map((part, i) => (
    <Fragment key={i}>
      {typeof part === 'string' ? named(part) : Object.prototype.hasOwnProperty.call(nodes, part.name) ? nodes[part.name] : `{${part.name}}`}
    </Fragment>
  ));
}

// t() for a sentence the page shows as text: its product names out of page translation. Attributes take t() itself.
export function sayOf(t: T): Say {
  return (key, vars) => named(t(key, vars));
}
