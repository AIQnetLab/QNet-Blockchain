/**
 * The device's model as every binding this device makes names it (light-node-messages section 4: `model`, an unsigned
 * display hint the node keeps with the binding and its public status shows next to the platform): a short marketing name
 * read on the device without any permission, so the owner sees which phone or tablet runs the node. Never a serial
 * number, IMEI, account or user name, or any other identifier:
 * - Android: the maker and the model the system reports, the maker written once and capitalized. Never the device name
 *   of the system settings: the user may have named the phone after themselves or with a phone number.
 * - iOS: the marketing name of the hardware identifier, from the table below, else "iPhone" or "iPad".
 * At most MODEL_MAX characters of ASCII letters, digits, spaces and `. , + ( ) / -`, the node's own rule
 * (light_binding::model_hint); null when nothing fits. Read once per launch.
 */
import { NativeModules, Platform } from 'react-native';

export const MODEL_MAX = 40;
const MODEL_RE = /^[A-Za-z0-9 .,+()/-]+$/;
// A read of the system's names never holds a binding up longer than this.
const READ_MS = 1000;

// Hardware identifiers (utsname machine) of the iPhone and iPad models this app runs on, by marketing name. Data only.
const IOS_MODELS = {
  'iPhone 6s': ['iPhone8,1'],
  'iPhone 6s Plus': ['iPhone8,2'],
  'iPhone SE (1st generation)': ['iPhone8,4'],
  'iPhone 7': ['iPhone9,1', 'iPhone9,3'],
  'iPhone 7 Plus': ['iPhone9,2', 'iPhone9,4'],
  'iPhone 8': ['iPhone10,1', 'iPhone10,4'],
  'iPhone 8 Plus': ['iPhone10,2', 'iPhone10,5'],
  'iPhone X': ['iPhone10,3', 'iPhone10,6'],
  'iPhone XS': ['iPhone11,2'],
  'iPhone XS Max': ['iPhone11,4', 'iPhone11,6'],
  'iPhone XR': ['iPhone11,8'],
  'iPhone 11': ['iPhone12,1'],
  'iPhone 11 Pro': ['iPhone12,3'],
  'iPhone 11 Pro Max': ['iPhone12,5'],
  'iPhone SE (2nd generation)': ['iPhone12,8'],
  'iPhone 12 mini': ['iPhone13,1'],
  'iPhone 12': ['iPhone13,2'],
  'iPhone 12 Pro': ['iPhone13,3'],
  'iPhone 12 Pro Max': ['iPhone13,4'],
  'iPhone 13 Pro': ['iPhone14,2'],
  'iPhone 13 Pro Max': ['iPhone14,3'],
  'iPhone 13 mini': ['iPhone14,4'],
  'iPhone 13': ['iPhone14,5'],
  'iPhone SE (3rd generation)': ['iPhone14,6'],
  'iPhone 14': ['iPhone14,7'],
  'iPhone 14 Plus': ['iPhone14,8'],
  'iPhone 14 Pro': ['iPhone15,2'],
  'iPhone 14 Pro Max': ['iPhone15,3'],
  'iPhone 15': ['iPhone15,4'],
  'iPhone 15 Plus': ['iPhone15,5'],
  'iPhone 15 Pro': ['iPhone16,1'],
  'iPhone 15 Pro Max': ['iPhone16,2'],
  'iPhone 16 Pro': ['iPhone17,1'],
  'iPhone 16 Pro Max': ['iPhone17,2'],
  'iPhone 16': ['iPhone17,3'],
  'iPhone 16 Plus': ['iPhone17,4'],
  'iPhone 16e': ['iPhone17,5'],
  'iPhone 17 Pro': ['iPhone18,1'],
  'iPhone 17 Pro Max': ['iPhone18,2'],
  'iPhone 17': ['iPhone18,3'],
  'iPhone Air': ['iPhone18,4'],
  'iPad (5th generation)': ['iPad6,11', 'iPad6,12'],
  'iPad (6th generation)': ['iPad7,5', 'iPad7,6'],
  'iPad (7th generation)': ['iPad7,11', 'iPad7,12'],
  'iPad (8th generation)': ['iPad11,6', 'iPad11,7'],
  'iPad (9th generation)': ['iPad12,1', 'iPad12,2'],
  'iPad (10th generation)': ['iPad13,18', 'iPad13,19'],
  'iPad (A16)': ['iPad15,7', 'iPad15,8'],
  'iPad Air 2': ['iPad5,3', 'iPad5,4'],
  'iPad Air (3rd generation)': ['iPad11,3', 'iPad11,4'],
  'iPad Air (4th generation)': ['iPad13,1', 'iPad13,2'],
  'iPad Air (5th generation)': ['iPad13,16', 'iPad13,17'],
  'iPad Air 11-inch (M2)': ['iPad14,8', 'iPad14,9'],
  'iPad Air 13-inch (M2)': ['iPad14,10', 'iPad14,11'],
  'iPad Air 11-inch (M3)': ['iPad15,3', 'iPad15,4'],
  'iPad Air 13-inch (M3)': ['iPad15,5', 'iPad15,6'],
  'iPad mini 4': ['iPad5,1', 'iPad5,2'],
  'iPad mini (5th generation)': ['iPad11,1', 'iPad11,2'],
  'iPad mini (6th generation)': ['iPad14,1', 'iPad14,2'],
  'iPad mini (A17 Pro)': ['iPad16,1', 'iPad16,2'],
  'iPad Pro 9.7-inch': ['iPad6,3', 'iPad6,4'],
  'iPad Pro 10.5-inch': ['iPad7,3', 'iPad7,4'],
  'iPad Pro 12.9-inch (1st generation)': ['iPad6,7', 'iPad6,8'],
  'iPad Pro 12.9-inch (2nd generation)': ['iPad7,1', 'iPad7,2'],
  'iPad Pro 11-inch (1st generation)': ['iPad8,1', 'iPad8,2', 'iPad8,3', 'iPad8,4'],
  'iPad Pro 12.9-inch (3rd generation)': ['iPad8,5', 'iPad8,6', 'iPad8,7', 'iPad8,8'],
  'iPad Pro 11-inch (2nd generation)': ['iPad8,9', 'iPad8,10'],
  'iPad Pro 12.9-inch (4th generation)': ['iPad8,11', 'iPad8,12'],
  'iPad Pro 11-inch (3rd generation)': ['iPad13,4', 'iPad13,5', 'iPad13,6', 'iPad13,7'],
  'iPad Pro 12.9-inch (5th generation)': ['iPad13,8', 'iPad13,9', 'iPad13,10', 'iPad13,11'],
  'iPad Pro 11-inch (4th generation)': ['iPad14,3', 'iPad14,4'],
  'iPad Pro 12.9-inch (6th generation)': ['iPad14,5', 'iPad14,6'],
  'iPad Pro 11-inch (M4)': ['iPad16,3', 'iPad16,4'],
  'iPad Pro 13-inch (M4)': ['iPad16,5', 'iPad16,6'],
};
export const IOS_MODEL_NAMES = new Map(Object.entries(IOS_MODELS).flatMap(([name, ids]) => ids.map((id) => [id, name])));

const spaced = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');

/** Whether `v` is a model as the node keeps it: 1 to MODEL_MAX allowed characters, trimmed. */
export function isModel(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= MODEL_MAX && v === v.trim() && MODEL_RE.test(v);
}

/**
 * A model from text the system gives: spaces collapsed and trimmed, null unless every character is allowed (a character
 * outside the set is never dropped to make it fit), cut to MODEL_MAX at a space where one is near the end.
 */
export function cleanModel(raw) {
  const s = spaced(raw);
  if (!s || !MODEL_RE.test(s)) return null;
  if (s.length <= MODEL_MAX) return s;
  const cut = s.slice(0, MODEL_MAX);
  const space = cut.lastIndexOf(' ');
  return (space >= MODEL_MAX / 2 ? cut.slice(0, space) : cut).trim();
}

// A maker as the system spells it, capitalized when it is all one case ("acme", "ACMECORP"); a short all-capitals
// maker and a mixed-case one stay as they are.
function makerName(raw) {
  return spaced(raw).replace(/_/g, ' ').split(' ').filter(Boolean).map((w) => {
    if (w === w.toLowerCase() || (w === w.toUpperCase() && w.length > 3)) return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    return w;
  }).join(' ');
}

/** Android: { manufacturer, model } → a model, or null. Any other field (a device name) is ignored. */
export function androidModel({ manufacturer = '', model = '' } = {}) {
  const maker = makerName(manufacturer);
  let rest = spaced(String(model || '').replace(/_/g, ' '));
  if (maker && rest.toLowerCase().startsWith(maker.toLowerCase())) rest = rest.slice(maker.length).trim();
  return cleanModel([maker, rest].filter(Boolean).join(' ')) || cleanModel(maker) || null;
}

/** iOS: { machine: the hardware identifier, idiom: 'phone' | 'pad' | ... } → a model, or null. */
export function iosModel({ machine = '', idiom = null } = {}) {
  const id = spaced(machine);
  const named = IOS_MODEL_NAMES.get(id);
  if (named) return named;
  if (/^iPad\d/.test(id)) return 'iPad';
  if (/^iPhone\d/.test(id)) return 'iPhone';
  if (idiom === 'pad') return 'iPad';
  if (idiom === 'phone') return 'iPhone';
  return null;
}

async function readModel() {
  const N = NativeModules.QNetSecurity;
  if (!N || typeof N.deviceModel !== 'function') return null;
  let timer = null;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), READ_MS); });
  try {
    const raw = await Promise.race([N.deviceModel(), late]);
    if (!raw || typeof raw !== 'object') return null;
    if (Platform.OS === 'android') return androidModel(raw);
    if (Platform.OS === 'ios') return iosModel(raw);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let read = null;
/** This device's model (see the module's comment), or null; never throws. */
export function deviceModel() {
  if (!read) read = readModel().catch(() => null);
  return read;
}

/**
 * `body` (a /light-node/bind body) naming this device's model, or no model when none is known. A model the body
 * already names is replaced: a record a test build kept may hold a device name, and the model is unsigned.
 */
export async function withDeviceModel(body) {
  const { model: _kept, ...rest } = body || {};
  const model = await deviceModel();
  return model ? { ...rest, model } : rest;
}
