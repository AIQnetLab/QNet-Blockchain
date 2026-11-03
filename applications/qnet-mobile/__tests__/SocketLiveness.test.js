/**
 * The address socket on both platforms: React Native's WebSocket is pinged every 15 s and fails when a ping got no pong
 * by the next, so a socket gone silent (a VPN turned off) ends and the screen opens a new one; on Android one whose
 * opening gets no answer ends within 20 s as well. Android's client is AppNetwork's (AppNetworkTest.kt runs it over a
 * connection that goes silent and over an opening nobody answers); iOS's is React Native's module as the app's patch
 * changes it, which this repository's checks do not compile: these pins hold it.
 */
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

describe('the address socket gone silent ends on both platforms', () => {
  it('Android: React Native\'s WebSocket client is AppNetwork\'s, with its 15 s ping and a 20 s bound on its opening', () => {
    expect(read('android/app/src/main/java/com/qnetmobile/MainApplication.kt'))
      .toContain('WebSocketModule.setCustomClientBuilder { AppNetwork.socketBuilder(it) }');
    const network = read('android/app/src/main/java/com/qnetmobile/AppNetwork.kt');
    expect(network).toContain('const val PING_MS = 15_000L');
    expect(network).toMatch(/fun clientBuilder\(base: OkHttpClient\.Builder, pingMs: Long = PING_MS\): OkHttpClient\.Builder =\s*base\.connectionPool\(pool\)\.pingInterval\(pingMs, TimeUnit\.MILLISECONDS\)/);
    // A path gone silent before the socket opened (no ping runs yet) ends at the bound (AppNetworkTest.kt runs it).
    expect(network).toContain('const val SOCKET_OPEN_MS = 20_000L');
    expect(network).toMatch(/fun socketBuilder\(base: OkHttpClient\.Builder, openMs: Long = SOCKET_OPEN_MS, pingMs: Long = PING_MS\): OkHttpClient\.Builder =\s*clientBuilder\(base, pingMs\)\.callTimeout\(openMs, TimeUnit\.MILLISECONDS\)/);
  });

  it('iOS: the module pings every open socket every 15 s, fails one with no pong by the next, and stops with no socket', () => {
    const patch = read('patches/react-native+0.81.4.patch');
    const ws = patch.slice(patch.indexOf('diff --git a/node_modules/react-native/React/CoreModules/RCTWebSocketModule.mm'));
    expect(ws.startsWith('diff --git')).toBe(true);
    const added = ws.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).join('\n');
    expect(added).toContain('static const NSTimeInterval RCTQNetPingInterval = 15;');
    // One timer on the main run loop, started by the first socket that opens, gone with the last socket or the module.
    expect(added).toMatch(/_pingTimer = \[NSTimer timerWithTimeInterval:RCTQNetPingInterval\s*repeats:YES/);
    expect(added).toContain('[[NSRunLoop mainRunLoop] addTimer:_pingTimer forMode:NSRunLoopCommonModes];');
    expect(ws).toMatch(/- \(void\)webSocketDidOpen:\(SRWebSocket \*\)webSocket\n \{\n\+ {2}\[self qnetStartPinging\];/);
    expect(ws).toMatch(/\[super invalidate\];\n \n\+ {2}\[_pingTimer invalidate\];\n\+ {2}_pingTimer = nil;/);
    expect(added).toMatch(/if \(_sockets\.count == 0\) \{\s*\[_pingTimer invalidate\];\s*_pingTimer = nil;/);
    // An open socket still waiting for the last ping's pong fails as one that failed by itself; any other is pinged.
    expect(added).toMatch(/if \(socket\.readyState != SR_OPEN\) \{\s*continue;/);
    expect(added).toMatch(/if \(\[_awaitingPong containsObject:socketID\]\) \{\s*\[_awaitingPong removeObject:socketID\];\s*socket\.delegate = nil;\s*\[socket close\];/);
    expect(added).toMatch(/\[self webSocket:socket didFailWithError:silent\];/);
    expect(added).toMatch(/\[_awaitingPong addObject:socketID\];\s*\[socket sendPing:nil error:nil\];/);
    expect(added).toMatch(/- \(void\)webSocket:\(SRWebSocket \*\)webSocket didReceivePong:\(NSData \*\)pongData\n\{\n {2}\[_awaitingPong removeObject:webSocket\.reactTag\];/);
    // The same interval as Android's.
    expect(Number(/RCTQNetPingInterval = (\d+);/.exec(added)[1]) * 1000)
      .toBe(Number(/const val PING_MS = ([\d_]+)L/.exec(read('android/app/src/main/java/com/qnetmobile/AppNetwork.kt'))[1].replace(/_/g, '')));
  });
});
