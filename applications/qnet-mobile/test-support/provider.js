/**
 * The in-app browser's request engine (browser/dappProvider) for tests, ended with each test: a page request a test
 * leaves waiting for its sheet holds a 600 s timer (APPROVAL_TIMEOUT_MS), which otherwise fires in the same worker
 * after the file ended, as an uncaught 4001, and keeps the worker from exiting. A request's promise still rejects for
 * the test that awaits it; one no test awaits rejects unheard.
 */
const { createDappProvider, CODES } = require('../src/browser/dappProvider');

const made = [];

afterEach(() => {
  made.splice(0).forEach((p) => p.cancelWhere(() => true, CODES.DISCONNECTED));
});

/** createDappProvider(deps), ended after the test (afterEach). */
function testProvider(deps) {
  const p = createDappProvider(deps);
  const { request } = p;
  p.request = (...args) => {
    const asked = request(...args);
    asked.catch(() => {});
    return asked;
  };
  made.push(p);
  return p;
}

module.exports = { testProvider };
