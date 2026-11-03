/**
 * The screens that hold no data (first read, loading, welcome, lock): the app's mark at the centre of the
 * window, where the launch screen draws it, at its size and from its own image, so the mark never moves or changes size
 * from launch to wallet or between these screens. Under it what the screen says (`head`), and the screen's actions at
 * the foot (`children`), in a column hung from the mark's own line that starts START_GAP under its drawn rings, so no
 * inset, text size or content can bring a line over the mark: what does not fit scrolls. `field`: the live field over
 * the top half (welcome, lock). Drawn over the screen's own root, a SafeAreaView with START_EDGES: nothing pads the root,
 * so the mark's centre is the window's; only the keyboard of a field in the column (StartField: the lock screen's
 * password) lifts the mark and the column together, never a sheet's field over the screen, and the column keeps clear of
 * the system bars itself.
 */
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Image, KeyboardAvoidingView, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Field from './Field';
import HexField from './HexField';
import { size, space, themed } from '../../theme';

// The launch screen's image, one name on both platforms (iOS's splash_logo image set in LaunchScreen.storyboard,
// Android's splash_logo drawable in launch_screen.xml and the system splash), read from the app's own resources: a box
// of 192 with the mark 134 across at its centre.
export const START_MARK = Object.freeze({ box: 192, drawn: 134 });
export const START_MARK_SOURCE = { uri: 'splash_logo' };
export const START_EDGES = Object.freeze([]);
// Between the mark's outer ring and the first line under it.
export const START_GAP = space.s16;

// Sets which field of the column has focus (StartField; null for none). Outside a StartScreen nothing listens.
const Typing = createContext(() => {});

/**
 * A field of the column: while it has focus the keyboard lifts the mark and the column; losing focus, or leaving the
 * screen with it, ends that. Every Field prop passes through.
 */
export function StartField({ onFocus, onBlur, ...props }) {
  const setTyping = useContext(Typing);
  const me = useRef({}).current;
  const leave = useCallback(() => setTyping((on) => (on === me ? null : on)), [setTyping, me]);
  useEffect(() => leave, [leave]);
  return (
    <Field
      {...props}
      onFocus={(e) => { setTyping(me); if (onFocus) onFocus(e); }}
      onBlur={(e) => { leave(); if (onBlur) onBlur(e); }}
    />
  );
}

export default function StartScreen({ field = false, head = null, children = null, testID }) {
  const [typing, setTyping] = useState(null);
  return (
    <Typing.Provider value={setTyping}>
      <KeyboardAvoidingView behavior="padding" enabled={typing !== null} style={s.window}>
        <View style={s.room}>
          {field ? <HexField /> : null}
          <View style={s.markBox} pointerEvents="none" testID="start-mark">
            <Image source={START_MARK_SOURCE} style={s.mark} resizeMode="contain" accessibilityIgnoresInvertColors />
          </View>
          {/* From the same line as the mark, never from a share of flex room that an inset or a sibling can move. */}
          <SafeAreaView edges={['left', 'right', 'bottom']} style={s.frame}>
            <ScrollView style={s.under} contentContainerStyle={s.column} keyboardShouldPersistTaps="handled" testID={testID}>
              {head}
              <View style={s.gap} />
              {children}
            </ScrollView>
          </SafeAreaView>
        </View>
      </KeyboardAvoidingView>
    </Typing.Provider>
  );
}

const s = themed(() => ({
  // The whole root, less the keyboard of a field in the column: the room the mark is centred in.
  window: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 },
  room: { flex: 1 },
  markBox: {
    position: 'absolute', left: 0, right: 0, top: '50%', height: START_MARK.box, marginTop: -START_MARK.box / 2,
    alignItems: 'center', justifyContent: 'center',
  },
  mark: { width: START_MARK.box, height: START_MARK.box },
  frame: { position: 'absolute', top: '50%', bottom: 0, left: 0, right: 0 },
  under: { marginTop: START_MARK.drawn / 2 + START_GAP },
  // One column of at most 640 (a tablet shows the phone layout), its head under the mark, its actions at its foot.
  column: {
    flexGrow: 1, width: '100%', maxWidth: size.column, alignSelf: 'center', alignItems: 'stretch', paddingHorizontal: space.gut,
    paddingBottom: space.gut,
  },
  gap: { flexGrow: 1 },
}));

export const startStyles = s;
