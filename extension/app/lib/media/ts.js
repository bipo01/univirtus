// Demuxer mínimo de MPEG-TS para os segmentos HLS de vídeo do YouTube (H.264 sem áudio).
// Devolve cada quadro (access unit) já no formato do MP4 (NALs com prefixo de 4 bytes),
// com PTS/DTS em 90 kHz e o SPS/PPS para o cabeçalho avcC.

const PACKET = 188;

function readPts(b, o) {
  // 33 bits espalhados em 5 bytes; usa aritmética de ponto flutuante (cabe com folga em 2^53).
  return (b[o] & 0x0e) * 536870912 + b[o + 1] * 4194304 + ((b[o + 2] >> 1) & 0x7f) * 32768 + b[o + 3] * 128 + ((b[o + 4] >> 1) & 0x7f);
}

/** Divide um fluxo Annex B (00 00 01 / 00 00 00 01) em NAL units. */
export function splitAnnexB(data) {
  const nals = [];
  let i = 0;
  let start = -1;
  const n = data.length;
  while (i + 2 < n) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        while (end > start && data[end - 1] === 0) end -= 1; // zeros do próximo start code de 4 bytes
        if (end > start) nals.push(data.subarray(start, end));
      }
      i += 3;
      start = i;
    } else {
      i += 1;
    }
  }
  if (start >= 0 && start < n) nals.push(data.subarray(start, n));
  return nals;
}

export class TsVideoDemuxer {
  constructor() {
    this.pmtPid = -1;
    this.videoPid = -1;
    this.pes = null; // { chunks, length }
    this.sps = null;
    this.pps = null;
    this.frames = [];
  }

  /** Processa um segmento .ts inteiro e devolve os quadros completos encontrados nele. */
  push(seg) {
    if (seg[0] !== 0x47) throw new Error('Segmento de vídeo inválido');
    for (let p = 0; p + PACKET <= seg.length; p += PACKET) {
      if (seg[p] !== 0x47) throw new Error('Segmento de vídeo corrompido (sem byte de sincronia)');
      const pusi = (seg[p + 1] & 0x40) !== 0;
      const pid = ((seg[p + 1] & 0x1f) << 8) | seg[p + 2];
      const afc = (seg[p + 3] >> 4) & 0x3;
      let o = p + 4;
      if (afc === 2) continue; // só adaptation field
      if (afc === 3) o += 1 + seg[o];
      if (o >= p + PACKET) continue;
      const payload = seg.subarray(o, p + PACKET);

      if (pid === 0) {
        if (pusi) this.parsePat(payload);
      } else if (pid === this.pmtPid) {
        if (pusi) this.parsePmt(payload);
      } else if (pid === this.videoPid) {
        if (pusi) {
          this.flush();
          this.pes = { chunks: [payload], length: payload.length };
        } else if (this.pes) {
          this.pes.chunks.push(payload);
          this.pes.length += payload.length;
        }
      }
    }
    // Cada segmento termina num quadro completo.
    this.flush();
    const out = this.frames;
    this.frames = [];
    return out;
  }

  parsePat(b) {
    const o = 1 + b[0]; // pointer field
    const sectionLength = ((b[o + 1] & 0x0f) << 8) | b[o + 2];
    for (let i = o + 8; i < o + 3 + sectionLength - 4; i += 4) {
      const program = (b[i] << 8) | b[i + 1];
      if (program !== 0) {
        this.pmtPid = ((b[i + 2] & 0x1f) << 8) | b[i + 3];
        return;
      }
    }
  }

  parsePmt(b) {
    const o = 1 + b[0];
    const sectionLength = ((b[o + 1] & 0x0f) << 8) | b[o + 2];
    const programInfoLength = ((b[o + 10] & 0x0f) << 8) | b[o + 11];
    let i = o + 12 + programInfoLength;
    const end = o + 3 + sectionLength - 4;
    while (i < end) {
      const type = b[i];
      const pid = ((b[i + 1] & 0x1f) << 8) | b[i + 2];
      const infoLength = ((b[i + 3] & 0x0f) << 8) | b[i + 4];
      if (type === 0x1b && this.videoPid < 0) this.videoPid = pid;
      i += 5 + infoLength;
    }
    if (this.videoPid < 0) throw new Error('O segmento não tem vídeo H.264');
  }

  flush() {
    const pes = this.pes;
    this.pes = null;
    if (!pes || pes.length < 9) return;
    const data = new Uint8Array(pes.length);
    let o = 0;
    for (const c of pes.chunks) {
      data.set(c, o);
      o += c.length;
    }
    if (data[0] !== 0 || data[1] !== 0 || data[2] !== 1) return;
    const flags = data[7];
    const headerLength = data[8];
    let pts = null;
    let dts = null;
    if (flags & 0x80) pts = readPts(data, 9);
    if ((flags & 0xc0) === 0xc0) dts = readPts(data, 14);
    if (pts == null) return;
    if (dts == null) dts = pts;
    const es = data.subarray(9 + headerLength);

    const parts = [];
    let size = 0;
    let key = false;
    for (const nal of splitAnnexB(es)) {
      const type = nal[0] & 0x1f;
      if (type === 7) {
        if (!this.sps) this.sps = nal.slice();
        continue;
      }
      if (type === 8) {
        if (!this.pps) this.pps = nal.slice();
        continue;
      }
      if (type === 9) continue; // access unit delimiter
      if (type === 5) key = true;
      parts.push(nal);
      size += 4 + nal.length;
    }
    if (!parts.length) return;
    const sample = new Uint8Array(size);
    const view = new DataView(sample.buffer);
    let w = 0;
    for (const nal of parts) {
      view.setUint32(w, nal.length);
      sample.set(nal, w + 4);
      w += 4 + nal.length;
    }
    this.frames.push({ data: sample, pts, dts, key });
  }
}
