// Leitor de AAC em ADTS, como vêm os segmentos HLS de áudio do YouTube
// (com uma tag ID3 "transportStreamTimestamp" no começo de cada segmento).

export const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** Tamanho da tag ID3v2 no início (0 se não houver). */
function id3Length(b, o = 0) {
  if (b.length < o + 10 || b[o] !== 0x49 || b[o + 1] !== 0x44 || b[o + 2] !== 0x33) return 0;
  const size = ((b[o + 6] & 0x7f) << 21) | ((b[o + 7] & 0x7f) << 14) | ((b[o + 8] & 0x7f) << 7) | (b[o + 9] & 0x7f);
  const footer = b[o + 5] & 0x10 ? 10 : 0;
  return 10 + size + footer;
}

const PRIV_TS = 'com.apple.streaming.transportStreamTimestamp';

/** PTS (90 kHz) que o HLS da Apple/YouTube grava na tag ID3 do segmento de áudio, ou null. */
export function id3Timestamp(seg) {
  const len = id3Length(seg, 0);
  if (!len) return null;
  const head = new TextDecoder('latin1').decode(seg.subarray(0, len));
  const i = head.indexOf(PRIV_TS);
  if (i < 0) return null;
  const o = i + PRIV_TS.length + 1; // nome + byte 0
  if (o + 8 > len) return null;
  return (seg[o + 3] & 1) * 2 ** 32 + seg[o + 4] * 2 ** 24 + seg[o + 5] * 2 ** 16 + seg[o + 6] * 2 ** 8 + seg[o + 7];
}

/** Devolve { config, frames: Uint8Array[], pts } — frames já sem o cabeçalho ADTS. */
export function parseAdts(seg) {
  const pts = id3Timestamp(seg);
  let o = 0;
  for (let skip = id3Length(seg, o); skip; skip = id3Length(seg, o)) o += skip;
  const frames = [];
  let config = null;
  while (o + 7 <= seg.length) {
    if (seg[o] !== 0xff || (seg[o + 1] & 0xf0) !== 0xf0) {
      // Pode haver outra tag ID3 ou lixo: procura a próxima sincronia.
      const skip = id3Length(seg, o);
      o += skip || 1;
      continue;
    }
    const protectionAbsent = seg[o + 1] & 0x01;
    const profile = (seg[o + 2] >> 6) & 0x03; // objectType - 1
    const freqIndex = (seg[o + 2] >> 2) & 0x0f;
    const channels = ((seg[o + 2] & 0x01) << 2) | ((seg[o + 3] >> 6) & 0x03);
    const frameLength = ((seg[o + 3] & 0x03) << 11) | (seg[o + 4] << 3) | ((seg[o + 5] >> 5) & 0x07);
    const header = protectionAbsent ? 7 : 9;
    if (frameLength < header || o + frameLength > seg.length) break;
    if (!config) config = { objectType: profile + 1, freqIndex, channels, sampleRate: SAMPLE_RATES[freqIndex] };
    frames.push(seg.subarray(o + header, o + frameLength));
    o += frameLength;
  }
  return { config, frames, pts };
}
