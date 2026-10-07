/**
 * The QR scan of a Send screen (the scan icon inside the recipient field). The camera is asked for QR codes, and what
 * a code carries is taken only when `read` accepts it: on the QNet Send screen (the default) a QNet address and nothing
 * else (utils/scanAddress), on the Solana one a Solana address or a payment request for a token the wallet holds
 * (utils/solanaRequest). What is taken goes to the form through `onAddress`, and the user still reviews and confirms
 * the send as always. Anything else is ignored with a short note (the key `read` names) while the camera keeps
 * scanning, and nothing read is ever opened. The camera library loads, and the camera permission is asked for, only
 * once this sheet is open, i.e. after the scan icon was tapped. A refusal shows one line and a way to the app's
 * settings; coming back from them with the camera allowed starts the scan.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  AppState, Linking, PermissionsAndroid, Platform, StyleSheet, Text, TouchableOpacity, TurboModuleRegistry, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Path, Rect } from 'react-native-svg';
import { qnetAddressFromScan } from '../utils/scanAddress';

const NOTE_MS = 2500;

// The scan icon of the recipient field: four corner brackets round a QR code's three finder squares and a data
// corner. Same 24 box, stroke and caps as the tab bar icons (components/BottomBar).
export const SCAN_CORNERS = 'M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3';
export const SCAN_SQUARES = [
  { x: 7, y: 7, size: 4 }, { x: 13, y: 7, size: 4 }, { x: 7, y: 13, size: 4 },
  { x: 13, y: 13, size: 1.8 }, { x: 15.2, y: 15.2, size: 1.8 },
];

export function ScanIcon({ color, size = 24 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d={SCAN_CORNERS} stroke={color} strokeWidth={1.8} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      {SCAN_SQUARES.map((q) => (
        <Rect key={`${q.x},${q.y}`} x={q.x} y={q.y} width={q.size} height={q.size} rx={q.size > 2 ? 1 : 0.4} fill={color} />
      ))}
    </Svg>
  );
}

// Loaded on first use, so nothing of the camera library runs before the scan icon is tapped; null when it cannot load.
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
// alike return at once after a refusal). iOS without the module leaves it to the camera view, which asks itself.
async function cameraAllowed(ask) {
  if (Platform.OS === 'android') {
    if (!ask) return PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.CAMERA);
    return (await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA)) === PermissionsAndroid.RESULTS.GRANTED;
  }
  const mod = cameraModule();
  if (!mod) return true;
  return (await (ask ? mod.requestDeviceCameraAuthorization() : mod.checkDeviceCameraAuthorizationStatus())) === true;
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
      <Text style={s.title}>{title || t('scan_title')}</Text>
      <View style={s.frame}>
        {Camera ? (
          <Camera
            ref={cameraRef}
            style={s.camera}
            scanBarcode
            allowedBarcodeTypes={['qr']}
            onReadCode={onReadCode}
            showFrame
            frameColor="#00d4ff"
            laserColor="#00d4ff"
            scanThrottleDelay={800}
            testID="scan-camera"
          />
        ) : null}
        {off ? (
          <View style={s.offBox}>
            <Text style={s.off}>{t('scan_camera_off')}</Text>
            {phase === 'denied' ? (
              <TouchableOpacity
                style={s.button}
                onPress={() => { Linking.openSettings().catch(() => {}); }}
                accessibilityRole="button"
                testID="scan-settings"
              >
                <Text style={s.buttonText}>{t('scan_open_settings')}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}
      </View>
      <Text style={s.note} accessibilityLiveRegion="polite" testID="scan-note">{note}</Text>
      <TouchableOpacity style={[s.button, s.close]} onPress={onClose} accessibilityRole="button" testID="scan-close">
        <Text style={s.buttonText}>{t('common_close')}</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  // Over the Send screen and the tab bar, under the review, the password prompt and the alerts.
  overlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#11131f', zIndex: 8500, elevation: 18,
    paddingHorizontal: 16, alignItems: 'center',
  },
  title: { color: '#00d4ff', fontSize: 18, fontWeight: '600', textAlign: 'center', marginTop: 12, marginBottom: 12 },
  frame: {
    width: '100%', maxWidth: 420, aspectRatio: 1, borderRadius: 16, overflow: 'hidden', backgroundColor: '#000000',
    alignItems: 'center', justifyContent: 'center',
  },
  camera: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  offBox: { alignItems: 'center', padding: 20 },
  off: { color: '#cccccc', fontSize: 14, textAlign: 'center', marginBottom: 16 },
  note: { color: '#ffaa00', fontSize: 14, textAlign: 'center', minHeight: 22, marginTop: 12 },
  button: {
    minHeight: 44, minWidth: 160, borderRadius: 10, paddingVertical: 11, paddingHorizontal: 24,
    alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0, 212, 255, 0.1)', borderWidth: 1,
    borderColor: 'rgba(0, 212, 255, 0.3)',
  },
  close: { marginTop: 12 },
  buttonText: { color: '#00d4ff', fontSize: 15, fontWeight: '600' },
});
