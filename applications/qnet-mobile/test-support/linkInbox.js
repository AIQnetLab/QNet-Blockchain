/* eslint-env jest */
/**
 * The native link inbox (android LinkInbox.kt, ios LinkInbox.swift) under Jest: `arrive(url)` is the system handing the
 * app a link, which waits in the inbox, and Linking's event fires for a screen that listens (`event: false`: a link that
 * came with no event, as to an activity made anew or before React Native was up). The app's JS reads and releases it
 * through NativeModules.QNetLinkInbox, as on a phone.
 */
const { Linking, NativeModules } = require('react-native');

function fakeLinkInbox() {
  let next = 1;
  const links = [];
  let listeners = [];
  const module = {
    pending: jest.fn(async () => links.map((e) => ({ ...e }))),
    done: jest.fn((id) => {
      const i = links.findIndex((e) => e.id === id);
      if (i >= 0) links.splice(i, 1);
    }),
  };
  NativeModules.QNetLinkInbox = module;
  jest.spyOn(Linking, 'addEventListener').mockImplementation((type, fn) => {
    if (type !== 'url') return { remove: () => {} };
    listeners.push(fn);
    return { remove: () => { listeners = listeners.filter((l) => l !== fn); } };
  });
  const arrive = (url, { event = true } = {}) => {
    if (!links.some((e) => e.url === url)) links.push({ id: next++, url });
    if (event) listeners.slice().forEach((fn) => fn({ url }));
  };
  return {
    module,
    arrive,
    // A link arriving while a rendered screen is up, and what the screen does about it (six turns of the event loop).
    async deliver(url) {
      const { act } = require('react-test-renderer');
      await act(async () => { arrive(url); });
      for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((r) => { setTimeout(r, 0); }); });
    },
    // Linking's event alone, with no new link (the platform repeating itself).
    cue: () => listeners.slice().forEach((fn) => fn({ url: links.length ? links[0].url : 'https://link.aiqnet.io/l' })),
    // The links still waiting, oldest first.
    waiting: () => links.map((e) => e.url),
    listening: () => listeners.length,
    // Takes the inbox away, so a link left waiting reaches no later test's screen.
    remove: () => { if (NativeModules.QNetLinkInbox === module) delete NativeModules.QNetLinkInbox; },
  };
}

module.exports = { fakeLinkInbox };
