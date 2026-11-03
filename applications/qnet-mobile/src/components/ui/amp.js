/**
 * Archivo draws '&' as its own ornament, which reads as a crooked letter on a button or a title: the sign is set in the
 * platform's sans face at the weight of the Archivo face around it, and the words keep Archivo.
 */
import React from 'react';
import { Text } from 'react-native';
import { systemFace } from '../../theme';

/** `text` as a Text's children, each '&' in the sans face at `face`'s weight ('regular', 'semibold' or 'title'). */
export function plainAmp(text, face) {
  if (typeof text !== 'string' || !text.includes('&')) return text;
  const sign = systemFace(face, true);
  return text.split('&').flatMap((part, i) => (i === 0 ? [part] : [<Text key={i} style={sign}>&</Text>, part]));
}
