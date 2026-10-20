/* global http, MAESTRO_QNET_CONTROL, ACTION */
// Asks scripts/store-screenshots.js, which runs these flows, to act on the simulator: ACTION is "shot/<name>" (capture
// the screen) or "pasteboard/<password|phrase|clear>". Only the action's name is sent; the values stay in that process.
const response = http.post(MAESTRO_QNET_CONTROL + '/' + ACTION, { body: '' });
if (response.status !== 200) {
  throw new Error(ACTION + ': ' + response.body);
}
