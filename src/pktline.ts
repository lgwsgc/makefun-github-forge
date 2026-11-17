// Git pkt-line framing (protocol v0/v2 transport): every packet is a 4-hex
// length prefix (the length counts the prefix itself) followed by that many
// bytes of payload. `0000` is a flush packet, `0001` a delimiter packet.
// A payload must fit in one packet: at most 65516 payload bytes.

export type PktLine = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' };

export const FLUSH: Buffer = Buffer.from('0000', 'ascii');
export const DELIM: Buffer = Buffer.from('0001', 'ascii');

/** The most payload bytes one pkt-line may carry. */
const MAX_PAYLOAD = 65516;

/** Encode one data packet. Throws when the payload is too large for a packet. */
export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  if (payload.length > MAX_PAYLOAD) throw new Error(`pkt-line payload of ${payload.length} bytes exceeds ${MAX_PAYLOAD}`);
  const length = payload.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, payload]);
}

/** Encode a list of lines, flushes and delims into one buffer. */
export function pktLines(items: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(FLUSH);
    else if (item === 'delim') parts.push(DELIM);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/** Decode a whole buffer of pkt-lines. Throws on a malformed frame. */
export function decodePktLines(buffer: Buffer): PktLine[] {
  const packets: PktLine[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line length');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (header === '0000') {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (header === '0001') {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`bad pkt-line length ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length < 4) throw new Error(`pkt-line length ${length} is too small`);
    if (offset + length > buffer.length) throw new Error('truncated pkt-line payload');
    packets.push({ kind: 'data', payload: Buffer.from(buffer.subarray(offset + 4, offset + length)) });
    offset += length;
  }
  return packets;
}

/**
 * Split a payload into sideband packets: each packet's first payload byte is
 * the band (1 data, 2 progress, 3 error) and the rest is a chunk of the
 * payload, sized to fit one pkt-line.
 */
export function sidebandPackets(band: 1 | 2 | 3, payload: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const chunkSize = MAX_PAYLOAD - 1;
  if (payload.length === 0) return packets;
  for (let offset = 0; offset < payload.length; offset += chunkSize) {
    const chunk = payload.subarray(offset, Math.min(payload.length, offset + chunkSize));
    packets.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return packets;
}
