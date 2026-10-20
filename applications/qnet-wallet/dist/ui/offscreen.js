// The offscreen document of background/clipboard.js: on the worker's request it empties the clipboard and answers
// whether it did. A document without the focus cannot use the asynchronous clipboard, so the copy command writes an
// empty text (the clipboardWrite permission lets it run without a click); the command needs a selection in some
// browsers, so a second try selects a node of its own first. It reads nothing and takes requests only from the worker.
import { OFFSCREEN } from '../background/config.js';

const WORKER_URL = chrome.runtime.getURL('background/sw.js');

// One copy command whose copy event puts an empty text on the clipboard; whether that event ran and the command did.
function copyEmpty() {
  let written = false;
  const fill = (event) => {
    event.clipboardData.setData('text/plain', '');
    event.preventDefault();
    written = true;
  };
  document.addEventListener('copy', fill);
  try {
    return document.execCommand('copy') === true && written;
  } catch {
    return false;
  } finally {
    document.removeEventListener('copy', fill);
  }
}

function writeEmpty() {
  if (copyEmpty()) return true;
  const node = document.createElement('span');
  node.textContent = ' ';
  document.body.append(node);
  const selection = document.getSelection();
  try {
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
    return copyEmpty();
  } finally {
    selection.removeAllRanges();
    node.remove();
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender?.id !== chrome.runtime.id || sender.tab || sender.url !== WORKER_URL) return;
  if (message?.target !== OFFSCREEN.TARGET || message.type !== 'clear') return;
  sendResponse({ cleared: writeEmpty() });
});
