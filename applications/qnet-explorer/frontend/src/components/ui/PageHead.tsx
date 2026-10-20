// The title band of a page (B-SPEC 5.23): the field behind it, the page's one h1, an optional kicker, lead and actions
// or search field, and optional readouts under it. The field is weighted to the right, and no glyph sits behind any line
// of the band's text (data-field-band: components/field/Field.tsx clears the cells under each line).

import type { ReactNode } from 'react';
import Field from '@/components/field/Field';
import type { FieldKind } from '@/lib/field/rain';

interface PageHeadProps {
  title: ReactNode;
  kicker?: ReactNode;
  lead?: ReactNode;
  // Actions, the search field or a line of facts under the title.
  children?: ReactNode;
  // Readouts or anything else under the band's text.
  more?: ReactNode;
  // B-SPEC 4.2: explorer 0.55, My node 0.32 (cabinet, at .7 opacity), every other page 0.3.
  strength?: number;
  kind?: FieldKind;
  opacity?: number;
}

export default function PageHead({ title, kicker, lead, children, more, strength = 0.3, kind = 'tool', opacity }: PageHeadProps) {
  return (
    <div className="page-head" data-field-band>
      <Field strength={strength} kind={kind} opacity={opacity} />
      <div className="wrap page-head-in">
        {kicker && <p className="label kicker">{kicker}</p>}
        <h1 className="page-title">{title}</h1>
        {lead && <p className="lead">{lead}</p>}
        {children}
        {more && <div className="page-head-more">{more}</div>}
      </div>
    </div>
  );
}
