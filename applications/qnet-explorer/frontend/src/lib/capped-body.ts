// A request's or a response's body read up to a cap, holding at most the cap plus one chunk in memory: a
// declared Content-Length over the cap is refused before anything is read, and the stream is cancelled as
// soon as more than `max` bytes have arrived. Used for the bodies this site accepts (src/server/request-guard.ts)
// and for the answers it reads from the nodes (src/lib/activation-price.ts).

export interface BodyMessage {
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}

// The body's bytes, or null past the cap (the stream is then cancelled).
export async function readCappedBytes(message: BodyMessage, max: number): Promise<Uint8Array | null> {
  const declared = message.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > max) {
    await message.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = message.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
