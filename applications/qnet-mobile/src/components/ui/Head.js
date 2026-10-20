/**
 * A screen's head: its one title at the start. A sub-screen (Send, Receive, a transaction) has Back, the word, on its
 * own 44 dp row above the title; the system back gesture and button keep doing what they do.
 */
import React from 'react';
import { Text, View } from 'react-native';
import Action from './Action';
import { color, size, space, themed } from '../../theme';

export default function Head({ title, onBack, backLabel, backTestID, style, titleStyle, testID, children = null }) {
  return (
    <View style={[s.head, onBack && s.sub, style]}>
      {onBack ? (
        <View style={s.backRow}>
          <Action kind="quiet" label={backLabel} onPress={onBack} testID={backTestID} />
        </View>
      ) : null}
      {title ? <Text style={[s.title, titleStyle]} accessibilityRole="header" testID={testID}>{title}</Text> : null}
      {children}
    </View>
  );
}

const s = themed((type) => ({
  head: { alignSelf: 'stretch', paddingTop: space.s16, paddingBottom: space.s16 },
  sub: { paddingTop: 0 },
  backRow: { minHeight: size.rowMin, justifyContent: 'center', alignItems: 'flex-start' },
  title: { ...type('title'), color: color.paper, alignSelf: 'flex-start' },
}));

export const headStyles = s;
