/**
 * The app reaches the network over HTTPS only: iOS refuses cleartext to a public host and the Android
 * manifest carries no exception. A node still names itself by address in a ping; the app answers at the
 * node's public name instead.
 */
import { GENESIS_NODES, GENESIS_NODES_HTTP, GENESIS_NODES_HTTPS, publicNodeUrl, usableNodeUrl } from '../src/config/nodes';

describe('node transport', () => {
  it('uses the public HTTPS names, one per genesis address', () => {
    expect(GENESIS_NODES).toBe(GENESIS_NODES_HTTPS);
    expect(GENESIS_NODES_HTTPS).toHaveLength(GENESIS_NODES_HTTP.length);
    for (const u of GENESIS_NODES_HTTPS) expect(u).toMatch(/^https:\/\/node[1-5]\.aiqnet\.io$/);
  });

  it('answers a ping at the node’s public name when the ping names it by address', () => {
    expect(publicNodeUrl('http://62.171.157.44:8001')).toBe('https://node2.aiqnet.io');
    expect(publicNodeUrl('http://62.171.157.44:8001/')).toBe('https://node2.aiqnet.io');
    expect(publicNodeUrl('https://node2.aiqnet.io')).toBe('https://node2.aiqnet.io');
    expect(publicNodeUrl('http://10.0.0.7:8001')).toBe('http://10.0.0.7:8001'); // not a genesis: unchanged
    expect(publicNodeUrl(undefined)).toBeUndefined();
  });

  it('keeps only HTTPS nodes in the pool', () => {
    expect(usableNodeUrl('https://node1.aiqnet.io')).toBe(true);
    expect(usableNodeUrl('http://154.38.160.39:8001')).toBe(false);
    expect(usableNodeUrl('')).toBe(false);
  });
});
