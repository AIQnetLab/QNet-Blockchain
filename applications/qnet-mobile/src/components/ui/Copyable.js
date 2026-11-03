/**
 * A value a tap copies: the whole element is the target, the copy mark ends the value's line (a `label` stands above it);
 * once copied the mark is a tick and "Copied" holds the value's place for COPIED_MS. A secret uses ui/SecretCopy.
 */
import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Text, View } from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import CopyGlyph from './CopyGlyph';
import Press from './Press';
import { tr } from '../../i18n';
import { color, space, themed } from '../../theme';

// How long the tick stays after a copy.
export const COPIED_MS = 2000;
// The whole address on the one line of the Assets card, and "Copied" in its place: shrunk to fit a 320 dp screen, never
// cut, a larger system text size counted up to 1.2 times.
export const ADDRESS_LINE = Object.freeze({ numberOfLines: 1, adjustsFontSizeToFit: true, minimumFontScale: 0.45, maxFontSizeMultiplier: 1.2 });

/**
 * One copy's state, for every copy of the app: `copy(write)` runs `write` (it puts the text on the clipboard and
 * resolves whether it did); once it did, `done` is true for `hold` ms and "Copied" is announced. Returns [done, copy].
 */
export function useCopied(hold = COPIED_MS, t = tr) {
  const [done, setDone] = useState(false);
  const timer = useRef(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; clearTimeout(timer.current); }, []);
  const copy = async (write) => {
    let ok;
    try {
      ok = await write();
    } catch (_) {
      ok = false;
    }
    if (!ok || !alive.current) return;
    clearTimeout(timer.current);
    setDone(true);
    timer.current = setTimeout(() => { timer.current = null; if (alive.current) setDone(false); }, hold);
    AccessibilityInfo.announceForAccessibility(t('common_copied'));
  };
  return [done, copy];
}

export default function Copyable({
  text, label = null, children, style, doneStyle, scale = true, t = tr, accessibilityLabel, testID,
}) {
  const [done, copy] = useCopied(COPIED_MS, t);
  return (
    <Press
      scale={scale}
      onPress={() => copy(() => {
        Clipboard.setString(String(text));
        return true;
      })}
      style={({ pressed }) => [style, done && doneStyle, pressed && s.pressed]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={t(done ? 'common_copied' : 'common_tap_to_copy')}
      testID={testID}
    >
      {label}
      <View style={s.line}>
        <View style={s.value}>
          <View style={done ? s.hidden : null}>{children}</View>
          {done ? (
            <View style={s.over}>
              <Text style={s.copied} {...ADDRESS_LINE} testID="copied">{t('common_copied')}</Text>
            </View>
          ) : null}
        </View>
        <CopyGlyph done={done} />
      </View>
    </Press>
  );
}

const s = themed((type) => ({
  // The mark centred on the value's line: a value under a label is one line (components/InfoRow InfoField).
  line: { flexDirection: 'row', alignItems: 'center', columnGap: space.s12 },
  value: { flex: 1, minWidth: 0 },
  hidden: { opacity: 0 },
  over: { position: 'absolute', top: 0, bottom: 0, start: 0, end: 0, justifyContent: 'center' },
  // The word the address on Assets has always shown: its face, in Signal.
  copied: { ...type('address', 14), color: color.signal },
  pressed: { backgroundColor: color.fillPress },
}));

export const copyableStyles = s;
