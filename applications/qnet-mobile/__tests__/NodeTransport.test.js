/**
 * The app reaches the network over HTTPS only: the Android network security config refuses cleartext and
 * iOS ATS has no exception. A node still names itself by address in a ping; the app answers at the node's
 * public name instead, and a URL a node hands it is used only in the one shape it accepts.
 */
import {
  GENESIS_NODES, GENESIS_NODES_HTTP, GENESIS_NODES_HTTPS, publicNodeUrl, usableNodeUrl, canonicalNodeUrl,
  isGenesisNodeUrl, genesisResponseUrl,
} from '../src/config/nodes';

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
    expect(publicNodeUrl('http://10.0.0.7:8001')).toBeNull(); // not a genesis, not https: never called
    expect(publicNodeUrl(undefined)).toBeNull();
  });

  it('accepts a node URL only as https on the default port under a DNS name', () => {
    expect(canonicalNodeUrl('https://Node.Example.org/')).toBe('https://node.example.org');
    expect(canonicalNodeUrl('https://node.example.org:443')).toBe('https://node.example.org');
    for (const bad of [
      'http://node.example.org', 'https://node.example.org:8443', 'https://154.38.160.39',
      'https://[2001:db8::1]', 'https://localhost', 'https://printer.local', 'https://user:pw@node.example.org',
      'https://node.example.org/api', 'https://node.example.org?x=1', 'https://node.example.org#a',
      'https://-bad.example.org', 'https://node.example.123', 'ftp://node.example.org', '', null,
    ]) {
      expect([bad, canonicalNodeUrl(bad)]).toEqual([bad, null]);
      expect(usableNodeUrl(bad)).toBe(false);
    }
    expect(usableNodeUrl('https://node1.aiqnet.io')).toBe(true);
    expect(usableNodeUrl('http://154.38.160.39:8001')).toBe(false);
  });

  it('knows the genesis names, and sends a ping answer nowhere else', () => {
    expect(isGenesisNodeUrl('https://node3.aiqnet.io/')).toBe(true);
    expect(isGenesisNodeUrl('https://node3.aiqnet.io.evil.example')).toBe(false);
    expect(genesisResponseUrl('http://161.97.86.81:8001')).toBe('https://node3.aiqnet.io');
    expect(genesisResponseUrl('https://node5.aiqnet.io')).toBe('https://node5.aiqnet.io');
    expect(genesisResponseUrl('https://operator.example.org')).toBeNull();
    expect(genesisResponseUrl('http://203.0.113.9:8001')).toBeNull();
  });
});
