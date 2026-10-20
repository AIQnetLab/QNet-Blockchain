/**
 * The QR scan of a Send screen (Scan inside the recipient field). The camera is asked for QR codes, and what
 * a code carries is taken only when `read` accepts it: on the QNet Send screen (the default) a QNet address and nothing
 * else (utils/scanAddress), on the Solana one a Solana address or a payment request for a token the wallet holds
 * (utils/solanaRequest). What is taken goes to the form through `onAddress`, and the user still reviews and confirms
 * the send as always. Anything else is ignored with a short note (the key `read` names) while the camera keeps
 * scanning, and nothing read is ever opened. The camera library loads, and the camera permission is asked for, only
 * once this sheet is open, i.e. after Scan was tapped. A refusal shows one line and a way to the app's
 * settings; coming back from them with the camera allowed starts the scan.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  AppState, Linking, PermissionsAndroid, Platform, Text, TurboModuleRegistry, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { qnetAddressFromScan } from '../utils/scanAddress';
import Action from './ui/Action';
import { color, layer, radius, space, themed } from '../theme';

const NOTE_MS = 2500;

// Loaded on first use, so nothing of the camera library runs before Scan is tapped; null when it cannot load.
let cameraComponent;
function loadCamera() {
  if (cameraComponent === undefined) {
    try {
      cameraComponent = require('react-native-camera-kit').Camera || null;
    } catch (_) {
      cameraComponent = null;
    }
  }
  return cameraComponent;
}

// The camera library's native module (iOS asks for and reads the camera permission through it); null without it.
function cameraModule() {
  try {
    return TurboModuleRegistry.get('RNCameraKitModule');
  } catch (_) {
    return null;
  }
}

// Whether the camera may be used: `ask` shows the system prompt when the user has not answered yet (Android and iOS
// alike return at once after a refusal). iOS without the module, or with a module that does not expose the method (a
// build whose bridge cannot reach it), leaves it to the camera view, which asks itself.
async function cameraAllowed(ask) {
  if (Platform.OS === 'android') {
    if (!ask) return PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.CAMERA);
    return (await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA)) === PermissionsAndroid.RESULTS.GRANTED;
  }
  const mod = cameraModule();
  const method = ask ? 'requestDeviceCameraAuthorization' : 'checkDeviceCameraAuthorizationStatus';
  if (!mod || typeof mod[method] !== 'function') return true;
  return (await mod[method]()) === true;
}

// The QNet Send screen's reading: a QNet address, else the note that it is not one.
export const readQnetScan = (text) => {
  const address = qnetAddressFromScan(text);
  return address ? { value: address } : { note: 'scan_not_qnet' };
};

export default function QrScanSheet({ t, onAddress, onClose, read = readQnetScan, title = null }) {
  // asking (the system prompt) · scanning · denied
  const [phase, setPhase] = useState('asking');
  const [note, setNote] = useState('');
  const taken = useRef(false);
  const noteTimer = useRef(null);
  // Passed as the camera's ref: with a ref React hands the library's component a props object of its own, which the
  // library writes defaults into.
  const cameraRef = useRef(null);

  useEffect(() => {
    let live = true;
    cameraAllowed(true)
      .then((ok) => { if (live) setPhase(ok ? 'scanning' : 'denied'); })
      .catch(() => { if (live) setPhase('denied'); });
    return () => {
      live = false;
      if (noteTimer.current) clearTimeout(noteTimer.current);
    };
  }, []);

  // Back from the settings with the camera allowed: scan without closing and reopening the sheet.
  useEffect(() => {
    if (phase !== 'denied') return undefined;
    let live = true;
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      cameraAllowed(false).then((ok) => { if (live && ok) setPhase('scanning'); }).catch(() => {});
    });
    return () => {
      live = false;
      sub.remove();
    };
  }, [phase]);

  const onReadCode = (e) => {
    if (taken.current) return;
    const got = read(e && e.nativeEvent ? e.nativeEvent.codeStringValue : null) || {};
    if (got.value !== undefined && got.value !== null) {
      taken.current = true;
      onAddress(got.value);
      return;
    }
    setNote(t(got.note || 'scan_not_qnet'));
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(''), NOTE_MS);
  };

  const Camera = phase === 'scanning' ? loadCamera() : null;
  const off = phase === 'denied' || (phase === 'scanning' && !Camera);
  return (
    <SafeAreaView style={s.overlay} edges={['top', 'bottom', 'left', 'right']} testID="scan-sheet">
      <View style={s.column}>
        <View style={s.head}>
          <Text style={s.title} accessibilityRole="header">{title || t('scan_title')}</Text>
          <Action kind="quiet" label={t('common_close')} onPress={onClose} align="end" testID="scan-close" />
        </View>
        <View style={s.frame}>
          {Camera ? (
            <Camera
              ref={cameraRef}
              style={s.camera}
              scanBarcode
              allowedBarcodeTypes={['qr']}
              onReadCode={onReadCode}
              showFrame
              frameColor={color.signal}
              laserColor={color.signal}
              scanThrottleDelay={800}
              testID="scan-camera"
            />
          ) : null}
          {off ? (
            <View style={s.offBox}>
              <Text style={s.off}>{t('scan_camera_off')}</Text>
              {phase === 'denied' ? (
                <Action kind="text" label={t('scan_open_settings')} onPress={() => { Linking.openSettings().catch(() => {}); }} testID="scan-settings" />
              ) : null}
            </View>
          ) : null}
        </View>
        <Text style={s.note} accessibilityLiveRegion="polite" testID="scan-note">{note}</Text>
      </View>
    </SafeAreaView>
  );
}

const s = themed((type) => ({
  // Over the Send screen and the tab bar, under the review, the password prompt and the alerts.
  overlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: color.ink, ...layer.scan,
    paddingHorizontal: space.gut,
  },
  column: { width: '100%', maxWidth: 420, alignSelf: 'center' },
  head: { flexDirection: 'row', alignItems: 'center', columnGap: space.s16, minHeight: 52, marginBottom: space.s12 },
  title: { ...type('h3'), color: color.paper, flex: 1 },
  // The camera's square at the column's start: black until the preview starts.
  frame: {
    width: '100%', aspectRatio: 1, borderRadius: radius.box, overflow: 'hidden', backgroundColor: color.camera,
    alignItems: 'flex-start', justifyContent: 'center',
  },
  camera: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  offBox: { alignItems: 'flex-start', padding: space.gut },
  off: { ...type('body'), color: color.text, marginBottom: space.s8 },
  // Its height kept while empty, so nothing moves when a note comes and goes.
  note: { ...type('body'), color: color.ember, minHeight: 22, marginTop: space.s12 },
}));
