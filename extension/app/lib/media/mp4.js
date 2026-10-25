// Gera um MP4 "comum" (progressivo) com uma faixa H.264 e uma AAC, sem recodificar nada.
// Layout: ftyp | mdat (tamanho de 64 bits, corrigido no fim) | moov.
// Os dados vão direto para o disco em blocos ("chunks"); na memória ficam só as tabelas.
// O sink precisa de write(position, Uint8Array): os bytes do mdat são escritos em sequência e
// o cabeçalho do mdat é reescrito no final com o tamanho certo.

const enc = new TextEncoder();
const VIDEO_TIMESCALE = 90000;
const MOVIE_TIMESCALE = 1000;

function box(type, ...parts) {
  const payload = parts.filter(Boolean);
  const size = 8 + payload.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  v.setUint32(0, size);
  out.set(enc.encode(type), 4);
  let o = 8;
  for (const p of payload) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function fullBox(type, version, flags, ...parts) {
  const head = new Uint8Array([version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]);
  return box(type, head, ...parts);
}

function u32(...values) {
  return u32a(values);
}

/** Igual a u32, mas recebe um array (tabelas com centenas de milhares de itens não cabem em "...") */
function u32a(values) {
  const out = new Uint8Array(values.length * 4);
  const v = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) v.setUint32(i * 4, values[i] >>> 0);
  return out;
}

const flatPairs = (pairs) => {
  const out = new Array(pairs.length * 2);
  for (let i = 0; i < pairs.length; i++) {
    out[i * 2] = pairs[i][0];
    out[i * 2 + 1] = pairs[i][1];
  }
  return out;
};

function u64(value) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value));
  return out;
}

function u16(...values) {
  const out = new Uint8Array(values.length * 2);
  const v = new DataView(out.buffer);
  values.forEach((x, i) => v.setUint16(i * 2, x));
  return out;
}

const MATRIX = u32(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000);

/** Tabela compacta: [[count, value], ...] juntando valores repetidos seguidos. */
function runs(values) {
  const out = [];
  for (const v of values) {
    const last = out[out.length - 1];
    if (last && last[1] === v) last[0] += 1;
    else out.push([1, v]);
  }
  return out;
}

function stsc(chunks) {
  const entries = [];
  chunks.forEach((c, i) => {
    const last = entries[entries.length - 1];
    if (!last || last[1] !== c.count) entries.push([i + 1, c.count, 1]);
  });
  return fullBox('stsc', 0, 0, u32(entries.length), u32a(entries.flat()));
}

function stsz(sizes) {
  return fullBox('stsz', 0, 0, u32(0, sizes.length), u32a(sizes));
}

function co64(chunks) {
  const out = new Uint8Array(chunks.length * 8);
  const v = new DataView(out.buffer);
  chunks.forEach((c, i) => v.setBigUint64(i * 8, BigInt(c.offset)));
  return fullBox('co64', 0, 0, u32(chunks.length), out);
}

function dinf() {
  return box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
}

function hdlr(type, name) {
  return fullBox('hdlr', 0, 0, u32(0), enc.encode(type), u32(0, 0, 0), enc.encode(`${name}\0`));
}

function mdhd(timescale, duration) {
  return fullBox('mdhd', 1, 0, u64(0), u64(0), u32(timescale), u64(duration), u16(0x55c4, 0)); // idioma "und"
}

function tkhd(id, duration, { width = 0, height = 0, audio = false }) {
  return fullBox('tkhd', 1, 3, u64(0), u64(0), u32(id, 0), u64(duration), u32(0, 0), u16(0, 0, audio ? 0x0100 : 0, 0), MATRIX, u32(width << 16, height << 16));
}

function avcC(sps, pps) {
  // Perfis High (100, 110, 122, 144) pedem 4 bytes extras (ISO 14496-15): YouTube usa 4:2:0, 8 bits.
  const high = [100, 110, 122, 144].includes(sps[1]) ? new Uint8Array([0xfc | 1, 0xf8, 0xf8, 0]) : null;
  return box('avcC', new Uint8Array([1, sps[1], sps[2], sps[3], 0xff, 0xe1]), u16(sps.length), sps, new Uint8Array([1]), u16(pps.length), pps, high);
}

/** Edit list: atraso inicial (faixa vazia) seguido da mídia inteira a partir do tempo 0. */
function elst(delayMovie, durationMovie) {
  const entries = delayMovie > 0 ? [[delayMovie, -1], [durationMovie, 0]] : [[durationMovie, 0]];
  const body = entries.flatMap(([dur, mediaTime]) => {
    const e = new Uint8Array(20);
    const v = new DataView(e.buffer);
    v.setBigUint64(0, BigInt(dur));
    v.setBigInt64(8, BigInt(mediaTime));
    v.setUint16(16, 1);
    return [e];
  });
  return box('edts', fullBox('elst', 1, 0, u32(entries.length), ...body));
}

function esds(cfg, bitrate) {
  const asc = new Uint8Array([(cfg.objectType << 3) | (cfg.freqIndex >> 1), ((cfg.freqIndex & 1) << 7) | (cfg.channels << 3)]);
  const dsi = new Uint8Array([0x05, asc.length, ...asc]);
  const dcd = new Uint8Array([0x04, 13 + dsi.length, 0x40, 0x15, 0, 0, 0, ...u32(bitrate, bitrate), ...dsi]);
  const sl = new Uint8Array([0x06, 1, 2]);
  const es = new Uint8Array([0x03, 3 + dcd.length + sl.length, 0, 1, 0, ...dcd, ...sl]);
  return fullBox('esds', 0, 0, es);
}

export class Mp4Muxer {
  /**
   * @param sink { write(position, Uint8Array): Promise }
   * @param video { width, height }
   */
  constructor(sink, { width, height }) {
    this.sink = sink;
    this.width = width;
    this.height = height;
    this.pos = 0;
    this.mdatStart = 0;
    this.video = { samples: [], chunks: [] }; // samples: { size, dts, pts, key }
    this.audio = { sizes: [], chunks: [], config: null, start: null };
    this.sps = null;
    this.pps = null;
  }

  async start() {
    const ftyp = box('ftyp', enc.encode('isom'), u32(0x200), enc.encode('isomiso2avc1mp41'));
    await this.sink.write(0, ftyp);
    this.mdatStart = ftyp.length;
    // mdat com tamanho de 64 bits (size = 1 + largesize), preenchido no finish().
    await this.sink.write(this.mdatStart, new Uint8Array(16));
    this.pos = this.mdatStart + 16;
  }

  async writeChunk(parts) {
    const size = parts.reduce((s, p) => s + p.length, 0);
    const buf = new Uint8Array(size);
    let o = 0;
    for (const p of parts) {
      buf.set(p, o);
      o += p.length;
    }
    const offset = this.pos;
    await this.sink.write(offset, buf);
    this.pos += size;
    return offset;
  }

  /** frames: [{ data, pts, dts, key }] de TsVideoDemuxer */
  async addVideo(frames, { sps, pps }) {
    if (!frames.length) return;
    if (!this.sps && sps) this.sps = sps;
    if (!this.pps && pps) this.pps = pps;
    const offset = await this.writeChunk(frames.map((f) => f.data));
    this.video.chunks.push({ offset, count: frames.length });
    for (const f of frames) this.video.samples.push({ size: f.data.length, dts: f.dts, pts: f.pts, key: f.key });
  }

  /** frames: Uint8Array[] de parseAdts; pts (90 kHz) do início do segmento, se o HLS informar */
  async addAudio(frames, config, pts = null) {
    if (!frames.length) return;
    if (!this.audio.config) this.audio.config = config;
    if (this.audio.start == null && !this.audio.sizes.length) this.audio.start = pts;
    const offset = await this.writeChunk(frames);
    this.audio.chunks.push({ offset, count: frames.length });
    for (const f of frames) this.audio.sizes.push(f.length);
  }

  /** Grava o moov e corrige o tamanho do mdat. Devolve o tamanho final do arquivo. */
  async finish() {
    const vs = this.video.samples;
    if (!vs.length || !this.sps || !this.pps) throw new Error('O vídeo veio sem imagem');
    const mdatSize = this.pos - this.mdatStart;
    const head = new Uint8Array(16);
    const hv = new DataView(head.buffer);
    hv.setUint32(0, 1);
    head.set(enc.encode('mdat'), 4);
    hv.setBigUint64(8, BigInt(mdatSize));
    await this.sink.write(this.mdatStart, head);

    // --- Vídeo: durações pelas diferenças de DTS; ctts = PTS - DTS.
    const dts0 = vs[0].dts;
    const durations = vs.map((s, i) => (i + 1 < vs.length ? Math.max(1, vs[i + 1].dts - s.dts) : null));
    const typical = durations.length > 1 ? durations[durations.length - 2] : 3000;
    durations[durations.length - 1] = typical;
    const videoDuration = durations.reduce((a, b) => a + b, 0);
    const offsets = vs.map((s) => Math.max(0, Math.round(s.pts - s.dts)));
    const hasCtts = offsets.some((x) => x !== 0);
    // Sincronia: vídeo (DTS) e áudio (timestamp ID3) usam o mesmo relógio de 90 kHz. O que começar
    // depois ganha um atraso inicial; sem timestamp de áudio, os dois começam juntos.
    const audioStart = this.audio.start ?? dts0;
    const base = Math.min(dts0, audioStart);
    const toMovie = (t90k) => Math.round((t90k / VIDEO_TIMESCALE) * MOVIE_TIMESCALE);
    const videoDelay = toMovie(dts0 - base);
    const audioDelay = toMovie(audioStart - base);
    const sttsRuns = runs(durations);
    const cttsRuns = runs(offsets);
    const keys = vs.map((s, i) => (s.key ? i + 1 : 0)).filter(Boolean);
    const videoMovieDuration = Math.round((videoDuration / VIDEO_TIMESCALE) * MOVIE_TIMESCALE);

    const videoStbl = box(
      'stbl',
      fullBox(
        'stsd',
        0,
        0,
        u32(1),
        box(
          'avc1',
          new Uint8Array(6),
          u16(1),
          new Uint8Array(16),
          u16(this.width, this.height),
          u32(0x00480000, 0x00480000, 0),
          u16(1),
          new Uint8Array(32),
          u16(0x18, 0xffff),
          avcC(this.sps, this.pps),
        ),
      ),
      fullBox('stts', 0, 0, u32(sttsRuns.length), u32a(flatPairs(sttsRuns))),
      hasCtts ? fullBox('ctts', 0, 0, u32(cttsRuns.length), u32a(flatPairs(cttsRuns))) : null,
      keys.length && keys.length < vs.length ? fullBox('stss', 0, 0, u32(keys.length), u32a(keys)) : null,
      stsc(this.video.chunks),
      stsz(vs.map((s) => s.size)),
      co64(this.video.chunks),
    );
    const videoTrak = box(
      'trak',
      tkhd(1, videoMovieDuration + videoDelay, { width: this.width, height: this.height }),
      elst(videoDelay, videoMovieDuration),
      box('mdia', mdhd(VIDEO_TIMESCALE, videoDuration), hdlr('vide', 'VideoHandler'), box('minf', fullBox('vmhd', 0, 1, u16(0, 0, 0, 0)), dinf(), videoStbl)),
    );

    // --- Áudio: 1024 amostras por quadro AAC.
    let audioTrak = null;
    let audioMovieDuration = 0;
    const cfg = this.audio.config;
    if (cfg && this.audio.sizes.length) {
      const count = this.audio.sizes.length;
      const audioDuration = count * 1024;
      audioMovieDuration = Math.round((audioDuration / cfg.sampleRate) * MOVIE_TIMESCALE);
      const bytes = this.audio.sizes.reduce((a, b) => a + b, 0);
      const bitrate = Math.round((bytes * 8) / (audioDuration / cfg.sampleRate));
      const audioStbl = box(
        'stbl',
        fullBox('stsd', 0, 0, u32(1), box('mp4a', new Uint8Array(6), u16(1), u32(0, 0), u16(cfg.channels, 16, 0, 0), u32(cfg.sampleRate << 16), esds(cfg, bitrate))),
        fullBox('stts', 0, 0, u32(1), u32(count, 1024)),
        stsc(this.audio.chunks),
        stsz(this.audio.sizes),
        co64(this.audio.chunks),
      );
      audioTrak = box(
        'trak',
        tkhd(2, audioMovieDuration + audioDelay, { audio: true }),
        audioDelay > 0 ? elst(audioDelay, audioMovieDuration) : null,
        box('mdia', mdhd(cfg.sampleRate, audioDuration), hdlr('soun', 'SoundHandler'), box('minf', fullBox('smhd', 0, 0, u16(0, 0)), dinf(), audioStbl)),
      );
    }

    const movieDuration = Math.max(videoMovieDuration + videoDelay, audioMovieDuration + audioDelay);
    const mvhd = fullBox('mvhd', 1, 0, u64(0), u64(0), u32(MOVIE_TIMESCALE), u64(movieDuration), u32(0x00010000), u16(0x0100, 0), u32(0, 0), MATRIX, new Uint8Array(24), u32(audioTrak ? 3 : 2));
    const moov = box('moov', mvhd, videoTrak, audioTrak);
    await this.sink.write(this.pos, moov);
    this.pos += moov.length;
    return this.pos;
  }
}
