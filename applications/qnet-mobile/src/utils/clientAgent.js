/**
 * QNet Wallet names its build to aiqnet.io and the genesis nodes, so what reaches them can be tied to it: User-Agent
 * "QNetWallet/<version> (<build>; <platform> <system version>)", nothing that tells one device from another. Every
 * request the app's JS makes goes through React Native's XMLHttpRequest, which its fetch is built on, so the header is
 * set there, once, for those hosts alone (index.js installs it before anything else runs).
 */
import { NativeModules, Platform } from 'react-native';
import { EXPLORER_API, GENESIS_NODES_HTTPS } from '../config/nodes';

const NAMED = new Set([EXPLORER_API, ...GENESIS_NODES_HTTPS]);

/** The User-Agent for `build` (the native QNetAppBuild constants) on `platform`, or null when the build gives none. */
export function clientAgent(build = NativeModules.QNetAppBuild, platform = Platform) {
  const version = build && typeof build.version === 'string' ? build.version : '';
  const number = build && (typeof build.build === 'string' || Number.isSafeInteger(build.build)) ? String(build.build) : '';
  if (!/^[0-9A-Za-z.-]{1,32}$/.test(version) || !/^[0-9A-Za-z.-]{1,32}$/.test(number)) return null;
  return `QNetWallet/${version} (${number}; ${platform.OS} ${platform.Version})`;
}

/** Whether `url` goes to aiqnet.io or a genesis node (https, the default port). */
export function namesItselfTo(url) {
  const m = /^https:\/\/([^/?#@\s]+)/i.exec(typeof url === 'string' ? url : '');
  return !!m && NAMED.has(`https://${m[1].toLowerCase()}`);
}

/** Sets the User-Agent on every request of `Xhr` (React Native's XMLHttpRequest) to those hosts; once. */
export function installClientAgent(Xhr = global.XMLHttpRequest, agent = clientAgent()) {
  if (!agent || typeof Xhr !== 'function' || Xhr.prototype.qnetAgent) return false;
  const { open, send } = Xhr.prototype;
  Xhr.prototype.open = function openNamed(method, url, ...rest) {
    this.qnetNamed = namesItselfTo(url);
    return open.call(this, method, url, ...rest);
  };
  Xhr.prototype.send = function sendNamed(body) {
    if (this.qnetNamed) this.setRequestHeader('User-Agent', agent);
    return send.call(this, body);
  };
  Xhr.prototype.qnetAgent = agent;
  return true;
}
