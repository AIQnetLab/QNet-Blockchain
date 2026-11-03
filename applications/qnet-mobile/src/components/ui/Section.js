/**
 * A section: content on the theme's one card (theme.card), its kicker (`title`) inside it at the top; the screens are
 * built of sections, not of lines across the page. Its rows (components/InfoRow) run to the card's edges,
 * parted by their own hairlines; the body clips the pixel past each end, so no hairline runs along the card's top or
 * bottom edge whichever row comes first or last. A card that is one target is a Press on theme.card instead.
 */
import React, { createContext } from 'react';
import { Text, View } from 'react-native';
import { card, color, space, themed } from '../../theme';

// The padding inside a card, which a row inside it runs over to reach the card's edges.
export const SECTION_PAD = space.s16;
// Whether a row is drawn inside a section (components/InfoRow reads it).
export const SectionContext = createContext(false);

export default function Section({ title, children, style, testID }) {
  return (
    <View style={[s.card, style]} testID={testID}>
      {title ? <Text style={s.title}>{title}</Text> : null}
      <View style={s.body}>
        <View style={s.rows}>
          <SectionContext.Provider value>{children}</SectionContext.Provider>
        </View>
      </View>
    </View>
  );
}

const s = themed((type) => ({
  card: { ...card, overflow: 'hidden', marginBottom: space.s12 },
  title: { ...type('label'), color: color.fog, paddingHorizontal: SECTION_PAD, paddingTop: space.s16, paddingBottom: space.s4 },
  // The rows' hairlines at the ends fall one pixel outside the body, which clips them.
  body: { paddingHorizontal: SECTION_PAD, overflow: 'hidden' },
  rows: { marginVertical: -1 },
  // A row inside a section (components/InfoRow, a not-settled transaction on Assets): over the card's padding to its
  // edges, its text kept where the padding put it.
  bleed: { marginHorizontal: -SECTION_PAD, paddingHorizontal: SECTION_PAD },
}));

export const sectionStyles = s;
