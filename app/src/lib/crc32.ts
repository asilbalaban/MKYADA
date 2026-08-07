// CRC32 (IEEE 802.3), bit-for-bit the same polynomial/init/final-xor as
// CircuitPython's binascii.crc32 — the firmware's meta.json manifest stores
// exactly this over each macro file's bytes, so matching values here is what
// lets the app skip re-reading (and re-writing) unchanged files.

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32Bytes(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const enc = new TextEncoder();

/** CRC32 of a string's UTF-8 bytes — how every device file we write/read is
 * encoded, so this equals the firmware's crc of the file on flash. */
export function crc32Text(text: string): number {
  return crc32Bytes(enc.encode(text));
}

/** Byte length of a string as UTF-8 — the firmware manifest's `z`. */
export function utf8Length(text: string): number {
  return enc.encode(text).length;
}
