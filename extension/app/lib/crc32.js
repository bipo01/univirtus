// CRC-32 (IEEE) incremental, "slicing-by-8": rápido o bastante para não ser o gargalo do ZIP.

const T = (() => {
  const tables = Array.from({ length: 8 }, () => new Int32Array(256));
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tables[0][n] = c;
  }
  for (let n = 0; n < 256; n++) {
    let c = tables[0][n];
    for (let t = 1; t < 8; t++) {
      c = tables[0][c & 0xff] ^ (c >>> 8);
      tables[t][n] = c;
    }
  }
  return tables;
})();
const [T0, T1, T2, T3, T4, T5, T6, T7] = T;

/** Continua um CRC: crc32(b, crc32(a)) === crc32(a+b). Comece com 0. */
export function crc32(bytes, previous = 0) {
  let crc = ~previous;
  let i = 0;
  const len = bytes.length;
  const end8 = len - (len % 8);
  for (; i < end8; i += 8) {
    crc ^= bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24);
    crc =
      T7[crc & 0xff] ^
      T6[(crc >>> 8) & 0xff] ^
      T5[(crc >>> 16) & 0xff] ^
      T4[crc >>> 24] ^
      T3[bytes[i + 4]] ^
      T2[bytes[i + 5]] ^
      T1[bytes[i + 6]] ^
      T0[bytes[i + 7]];
  }
  for (; i < len; i++) crc = T0[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}

/** CRC de `count` bytes zero a partir de um CRC anterior (usado para completar arquivos que falharam). */
export function crc32Zeros(count, previous = 0) {
  const block = new Uint8Array(Math.min(count, 1 << 20));
  let crc = previous;
  let left = count;
  while (left > 0) {
    const n = Math.min(left, block.length);
    crc = crc32(n === block.length ? block : block.subarray(0, n), crc);
    left -= n;
  }
  return crc;
}
