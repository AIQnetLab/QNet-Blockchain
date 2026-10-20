/**
 * A sheet over the screen: a dim scrim, and a panel at the bottom edge (thumb reach; an open keyboard pushes it up),
 * the whole width up to 560 dp, on Surface with a strong rule along its top and the safe area kept clear under it. Its
 * head is a kicker or a title at the start and Close at the end when it can be closed without an answer; its actions
 * sit at the bottom, its body scrolls inside. It slides up in 240 ms (in place with reduce motion on).
 * `level` places it among the root overlays (theme.layer): an alert or prompt by default.
 */
import React, { useContext, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, KeyboardAvoidingView, ScrollView, Text, View } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import Action from './Action';
import { color, layer, motion, sheet, space, themed } from '../../theme';
import { tr } from '../../i18n';

const NO_INSETS = { top: 0, bottom: 0, left: 0, right: 0 };

export default function Sheet({
  title, kicker, onClose, closeLabel, actions = null, children, level = 'alert', scroll = true, height, testID, t = tr,
  bodyStyle,
}) {
  const insets = useContext(SafeAreaInsetsContext) || NO_INSETS;
  const shown = useRef(new Animated.Value(0)).current;
  const [still, setStill] = useState(null);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => { if (alive) setStill(!!v); }, () => { if (alive) setStill(true); });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (still === null) return;
    if (still) { shown.setValue(1); return; }
    Animated.timing(shown, {
      toValue: 1, duration: motion.sheet, easing: Easing.bezier(...motion.curve), useNativeDriver: true,
    }).start();
  }, [still, shown]);
  const slide = { transform: [{ translateY: shown.interpolate({ inputRange: [0, 1], outputRange: [48, 0] }) }] };
  const head = title || kicker || onClose;
  return (
    <KeyboardAvoidingView behavior="padding" style={[s.overlay, layer[level] || layer.alert]} testID={testID}>
      <Animated.View style={[s.scrim, { opacity: shown }]} />
      <Animated.View
        style={[s.panel, { paddingBottom: space.s16 + insets.bottom }, height && { height }, slide]}
        accessibilityViewIsModal
      >
        {head ? (
          <View style={s.head}>
            {kicker || onClose ? (
              <View style={s.headRow}>
                <View style={s.headText}>{kicker ? <Text style={s.kicker}>{kicker}</Text> : null}</View>
                {onClose ? <Action kind="quiet" label={closeLabel || t('common_close')} onPress={onClose} align="end" /> : null}
              </View>
            ) : null}
            {/* The title takes the whole width under Close, so its longest word fits a narrow screen. */}
            {title ? <Text style={s.title} accessibilityRole="header">{title}</Text> : null}
          </View>
        ) : null}
        {scroll ? (
          <ScrollView style={s.scroll} contentContainerStyle={bodyStyle} keyboardShouldPersistTaps="handled">{children}</ScrollView>
        ) : <View style={[s.body, bodyStyle]}>{children}</View>}
        {actions ? <View style={s.actions}>{actions}</View> : null}
      </Animated.View>
    </KeyboardAvoidingView>
  );
}

const s = themed((type) => ({
  overlay: sheet.overlay,
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: color.scrim },
  panel: { ...sheet.panel, paddingTop: space.s16, paddingHorizontal: space.gut },
  head: { marginBottom: space.s12 },
  headRow: { flexDirection: 'row', alignItems: 'center', columnGap: space.s16 },
  headText: { flex: 1, minWidth: 0 },
  kicker: { ...type('label'), color: color.fog, marginBottom: space.s4 },
  title: { ...type('h3'), color: color.paper },
  scroll: { flexGrow: 0, flexShrink: 1 },
  body: { flexShrink: 1 },
  actions: { paddingTop: space.s16 },
}));

export const sheetUiStyles = s;
