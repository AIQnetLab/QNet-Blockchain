// The five genesis nodes the wallets pin, over HTTPS: the price, a node's status and its history are read
// from these, and a client acts on a node feature only when two of them list it.
export const GENESIS_NODES: readonly string[] = [1, 2, 3, 4, 5].map((n) => `https://node${n}.aiqnet.io`);
