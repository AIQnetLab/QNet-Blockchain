/**
 * The mark at the end of a value a tap copies: two overlapping sheets in Fog, and a Signal tick once the copy landed.
 */
import React from 'react';
import Svg, { Path, Rect } from 'react-native-svg';
import { color } from '../../theme';

export default function CopyGlyph({ done = false, size = 18 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" testID={done ? 'copy-glyph-done' : 'copy-glyph'}>
      {done ? (
        <Path d="M5 12.5l4.5 4.5L19 7.5" stroke={color.signal} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <>
          <Rect x={8.5} y={8.5} width={12} height={12} rx={3} stroke={color.fog} strokeWidth={1.8} />
          <Path d="M15.5 5.5V5a2 2 0 0 0-2-2H6a2.5 2.5 0 0 0-2.5 2.5V13a2 2 0 0 0 2 2h.5" stroke={color.fog} strokeWidth={1.8} strokeLinecap="round" />
        </>
      )}
    </Svg>
  );
}
