import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseAdts } from '../extension/app/lib/media/adts.js';
import { Mp4Muxer } from '../extension/app/lib/media/mp4.js';
import { splitAnnexB, TsVideoDemuxer } from '../extension/app/lib/media/ts.js';
import { downloadYouTube, parseMaster, parsePlaylist, pickVariant, youtubeVideoId } from '../extension/app/lib/youtube.js';
import { DirectoryTarget, DownloadJob, ZipTarget } from '../extension/app/lib/downloader.js';
import { memoryDir, nodeFileHandle } from './helpers.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/hls');
const read = (f) => new Uint8Array(fs.readFileSync(path.join(FIX, f)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-yt-'));
// ffmpeg é opcional: se existir (no PATH ou em $FFMPEG), também decodifica o MP4 gerado.
const FFMPEG = process.env.FFMPEG || (() => {
  try {
    return execFileSync('which', ['ffmpeg']).toString().trim();
  } catch {
    return null;
  }
})();

/** Lê os boxes de primeiro nível e alguns contadores do moov. */
function inspectMp4(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const top = [];
  for (let o = 0; o < buf.length; ) {
    let size = v.getUint32(o);
    const type = String.fromCharCode(...buf.subarray(o + 4, o + 8));
    if (size === 1) size = Number(v.getBigUint64(o + 8));
    top.push({ type, size, o });
    o += size;
  }
  const text = new TextDecoder('latin1').decode(buf.subarray(top.find((b) => b.type === 'moov').o));
  const count = (t) => text.split(t).length - 1;
  return { top: top.map((b) => b.type), total: top.reduce((s, b) => s + b.size, 0), traks: count('trak'), hasCtts: count('ctts') > 0, hasElst: count('elst') > 0 };
}

test('id do YouTube em todos os formatos de link', () => {
  for (const u of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10', 'https://youtu.be/dQw4w9WgXcQ?si=x', 'https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/embed/dQw4w9WgXcQ', 'https://www.youtube.com/shorts/dQw4w9WgXcQ', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', 'https://www.youtube.com/live/dQw4w9WgXcQ']) {
    assert.equal(youtubeVideoId(u), 'dQw4w9WgXcQ', u);
  }
  for (const u of ['https://www.youtube.com/playlist?list=PL1', 'https://youtu.be/abc', 'https://vimeo.com/123', 'nada']) assert.equal(youtubeVideoId(u), null, u);
});

test('lista mestre: escolhe H.264 até 1080p com áudio AAC-LC', () => {
  const master = `#EXTM3U
#EXT-X-MEDIA:URI="https://m/a233",TYPE=AUDIO,GROUP-ID="233",NAME="Default"
#EXT-X-MEDIA:URI="https://m/a234",TYPE=AUDIO,GROUP-ID="234",NAME="Default"
#EXT-X-STREAM-INF:BANDWIDTH=310801,CODECS="avc1.4D4015,mp4a.40.5",RESOLUTION=426x240,AUDIO="233"
https://m/v240
#EXT-X-STREAM-INF:BANDWIDTH=7417746,CODECS="avc1.64002A,mp4a.40.2",RESOLUTION=1920x1080,AUDIO="234"
https://m/v1080
#EXT-X-STREAM-INF:BANDWIDTH=9000000,CODECS="avc1.640033,mp4a.40.2",RESOLUTION=2560x1440,AUDIO="234"
https://m/v1440
#EXT-X-STREAM-INF:BANDWIDTH=5022446,CODECS="vp09.00.41.08,mp4a.40.2",RESOLUTION=1920x1080,AUDIO="234"
https://m/vp9
`;
  const v = pickVariant(parseMaster(master, 'https://m/master'));
  assert.equal(v.url, 'https://m/v1080');
  assert.equal(v.audioUrl, 'https://m/a234');
  assert.equal(pickVariant(parseMaster(master, 'https://m/master'), 360).url, 'https://m/v240');
  assert.deepEqual(parsePlaylist('#EXTM3U\n#EXTINF:4.0,\nseg1\n#EXTINF:2.5,\nhttps://x/seg2\n#EXT-X-ENDLIST', 'https://x/p/list'), [
    { url: 'https://x/p/seg1', duration: 4 },
    { url: 'https://x/seg2', duration: 2.5 },
  ]);
});

test('ADTS com tag ID3 no começo (como no YouTube) e Annex B', () => {
  const a0 = read('a0.aac');
  const plain = parseAdts(a0);
  const id3 = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 5, 1, 2, 3, 4, 5]);
  const withId3 = parseAdts(new Uint8Array([...id3, ...a0]));
  assert.equal(withId3.frames.length, plain.frames.length);
  assert.deepEqual(plain.config, { objectType: 2, freqIndex: 4, channels: 2, sampleRate: 44100 });
  assert.deepEqual(splitAnnexB(new Uint8Array([0, 0, 0, 1, 9, 0xf0, 0, 0, 1, 0x65, 1, 2, 0, 0, 1, 6, 7])).map((n) => Array.from(n)), [[9, 0xf0], [0x65, 1, 2], [6, 7]]);
});

test('remux TS (H.264 com quadros B) + ADTS → MP4 válido', async () => {
  const demux = new TsVideoDemuxer();
  const out = [];
  const sink = { write: async (pos, data) => out.push({ pos, data: data.slice() }) };
  const mux = new Mp4Muxer(sink, { width: 320, height: 180 });
  await mux.start();
  let videoFrames = 0;
  let audioFrames = 0;
  for (let i = 0; i < 3; i++) {
    if (fs.existsSync(path.join(FIX, `v${i}.ts`))) {
      const frames = demux.push(read(`v${i}.ts`));
      videoFrames += frames.length;
      await mux.addVideo(frames, { sps: demux.sps, pps: demux.pps });
    }
    const { config, frames } = parseAdts(read(`a${i}.aac`));
    audioFrames += frames.length;
    if (config) await mux.addAudio(frames, config);
  }
  const size = await mux.finish();
  assert.equal(videoFrames, 120, '4 s a 30 fps');
  assert.ok(audioFrames > 150);
  const buf = new Uint8Array(size);
  for (const w of out) buf.set(w.data, w.pos);
  const info = inspectMp4(buf);
  assert.deepEqual(info.top, ['ftyp', 'mdat', 'moov']);
  assert.equal(info.total, size, 'boxes cobrem o arquivo inteiro (mdat corrigido)');
  assert.equal(info.traks, 2);
  assert.ok(info.hasCtts, 'quadros B geram ctts');
  assert.ok(info.hasElst);
  if (FFMPEG) {
    const file = path.join(tmp, 'remux.mp4');
    fs.writeFileSync(file, buf);
    const err = execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    assert.equal(err, '', 'ffmpeg decodifica sem erros');
    const probe = execFileSync(FFMPEG, ['-hide_banner', '-i', file, '-map', '0:v', '-c', 'copy', '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    void probe;
  }
});

// ---- Integração com o motor de download (sem internet): CDN falso servindo as fixtures.
function fakeYouTube({ failSegment = null } = {}) {
  const files = { 'https://yt/v.m3u8': '#EXTM3U\n#EXTINF:2,\nhttps://yt/v0.ts\n#EXTINF:2,\nhttps://yt/v1.ts\n#EXT-X-ENDLIST', 'https://yt/a.m3u8': '#EXTM3U\n#EXTINF:2,\nhttps://yt/a0.aac\n#EXTINF:2,\nhttps://yt/a1.aac\n#EXTINF:0.1,\nhttps://yt/a2.aac\n#EXT-X-ENDLIST' };
  const fetchImpl = async (url) => {
    if (files[url]) return new Response(files[url]);
    const name = url.split('/').pop();
    if (name === failSegment) return new Response('x', { status: 404 });
    if (fs.existsSync(path.join(FIX, name))) return new Response(read(name));
    return new Response('x', { status: 404 });
  };
  const youtube = {
    resolve: async (id) => ({ id, title: 'T', seconds: 4, estimate: 100_000, variant: { url: 'https://yt/v.m3u8', audioUrl: 'https://yt/a.m3u8', width: 320, height: 180 } }),
    download: (info, opts) => downloadYouTube(info, { ...opts, fetchImpl }),
  };
  return { youtube, fetchImpl };
}

function nodeTempStore() {
  return {
    async create() {
      const file = path.join(tmp, `t-${Math.random().toString(36).slice(2)}.mp4`);
      const fd = fs.openSync(file, 'w');
      // Fechar duas vezes fecharia o descritor que outro código reaproveitou com o mesmo número.
      let open = true;
      const close = () => {
        if (open) fs.closeSync(fd);
        open = false;
      };
      return {
        sink: { write: async (pos, data) => void fs.writeSync(fd, data, 0, data.length, pos) },
        async finish() {
          close();
          return fs.openAsBlob(file);
        },
        async remove() {
          close();
          fs.rmSync(file, { force: true });
        },
      };
    },
  };
}

const ytEntry = { path: 'Curso/D/Aula 01 - X/YouTube - Palestra.mp4', url: 'https://youtu.be/dQw4w9WgXcQ', videoId: 'dQw4w9WgXcQ', size: null, kind: 'youtube', titulo: 'Palestra' };

test('ZIP: vídeo do YouTube montado à parte e gravado no fim do ZIP, junto com arquivos comuns', async () => {
  const { youtube, fetchImpl } = fakeYouTube();
  const file = path.join(tmp, 'yt.zip');
  const other = { path: 'Curso/D/Aula 01 - X/01 - Tema.mp4', url: 'https://yt/v0.ts', size: read('v0.ts').length, kind: 'video', titulo: 'Tema' };
  const job = new DownloadJob({ entries: [ytEntry, other], target: new ZipTarget(nodeFileHandle(file)), fetchImpl, youtube, tempStore: nodeTempStore(), backoff: () => 1 });
  const r = await job.start();
  assert.equal(r.counts.done, 2);
  const script = `
import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1]); print(json.dumps({"bad": z.testzip(), "files": {i.filename: i.file_size for i in z.infolist()}}))`;
  const z = JSON.parse(execFileSync('python3', ['-I', '-c', script, file]).toString());
  assert.equal(z.bad, null);
  assert.ok(z.files[ytEntry.path] > 50_000);
  assert.equal(fs.readdirSync(tmp).filter((f) => f.startsWith('t-')).length, 0, 'temporários apagados');
});

test('Pasta: segmento que some vira falha só deste vídeo, com mensagem clara', async () => {
  const { youtube, fetchImpl } = fakeYouTube({ failSegment: 'v1.ts' });
  const root = memoryDir();
  const r = await new DownloadJob({ entries: [ytEntry], target: new DirectoryTarget(root), fetchImpl, youtube, tempStore: nodeTempStore(), backoff: () => 1 }).start();
  assert.equal(r.counts.failed, 1);
  assert.match(r.failed[0].error, /404/);
  const aula = root.children.get('Aulas Uninter').children.get('Curso').children.get('D').children.get('Aula 01 - X');
  assert.equal(aula.children.has('YouTube - Palestra.mp4'), false);
});

test('falha de um segmento: os outros param e a mensagem de erro do vídeo não some (regressão)', async () => {
  let calls = 0;
  const { youtube, fetchImpl: base } = fakeYouTube();
  const fetchImpl = async (url, init) => {
    if (/\.(ts|aac)$/.test(url)) {
      calls += 1;
      if (url.endsWith('/v0.ts')) return new Response('x', { status: 404 });
      return new Response('x', { status: 503 });
    }
    return base(url, init);
  };
  const job = new DownloadJob({ entries: [ytEntry], target: new DirectoryTarget(memoryDir()), fetchImpl, youtube, tempStore: nodeTempStore(), backoff: () => 30 });
  const r = await job.start();
  assert.equal(r.counts.failed, 1);
  const callsAtEnd = calls;
  await new Promise((res) => setTimeout(res, 300));
  assert.match(job.items[0].error, /404/, 'a mensagem continua lá');
  assert.ok(calls - callsAtEnd <= 0, 'nenhum segmento novo depois da falha');
});

function elstOf(buf) {
  // Devolve, por trak, as entradas do elst: [[duração, media_time], ...]
  const out = [];
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const find = (type, from, to) => {
    for (let o = from; o < to; ) {
      let size = v.getUint32(o);
      if (size === 1) size = Number(v.getBigUint64(o + 8));
      const t = String.fromCharCode(...buf.subarray(o + 4, o + 8));
      if (t === type) return { o, size };
      o += size || 8;
    }
    return null;
  };
  const moov = find('moov', 0, buf.length);
  for (let o = moov.o + 8; o < moov.o + moov.size; ) {
    const size = v.getUint32(o);
    if (String.fromCharCode(...buf.subarray(o + 4, o + 8)) === 'trak') {
      const edts = find('edts', o + 8, o + size);
      if (!edts) out.push([]);
      else {
        const e = edts.o + 8;
        const n = v.getUint32(e + 12);
        out.push(Array.from({ length: n }, (_, i) => [Number(v.getBigUint64(e + 16 + i * 20)), Number(v.getBigInt64(e + 24 + i * 20))]));
      }
    }
    o += size;
  }
  return out;
}

test('sincronia: quem começa depois (pelo relógio de 90 kHz) ganha um atraso no edit list', async () => {
  const build = async (audioPts) => {
    const demux = new TsVideoDemuxer();
    const frames = demux.push(read('v0.ts')); // DTS começa em ~1,4 s (padrão do ffmpeg)
    const out = [];
    const mux = new Mp4Muxer({ write: async (pos, data) => out.push([pos, data.slice()]) }, { width: 320, height: 180 });
    await mux.start();
    await mux.addVideo(frames, { sps: demux.sps, pps: demux.pps });
    const a = parseAdts(read('a0.aac'));
    await mux.addAudio(a.frames, a.config, audioPts);
    const size = await mux.finish();
    const buf = new Uint8Array(size);
    for (const [pos, d] of out) buf.set(d, pos);
    return { buf, dts0: frames[0].dts };
  };
  const { buf: sameClock, dts0 } = await build(null);
  // Sem timestamp de áudio: os dois começam juntos, sem atraso.
  assert.deepEqual(elstOf(sameClock).map((e) => e.length), [1, 0]);
  // Áudio começou 1 s antes do vídeo: o vídeo ganha 1000 ms de atraso (entrada vazia, media_time -1).
  const [video] = elstOf((await build(dts0 - 90000)).buf);
  assert.deepEqual(video[0], [1000, -1]);
  assert.equal(video[1][1], 0);
  // Áudio começou 0,5 s depois: o atraso vai para o áudio.
  const [v2, a2] = elstOf((await build(dts0 + 45000)).buf);
  assert.equal(v2.length, 1);
  assert.deepEqual(a2[0], [500, -1]);
});

test('vídeo dublado: usa a faixa de áudio padrão (original) do grupo', () => {
  const m = parseMaster(`#EXTM3U
#EXT-X-MEDIA:URI="https://m/dub-es",TYPE=AUDIO,GROUP-ID="234",NAME="Español",DEFAULT=NO
#EXT-X-MEDIA:URI="https://m/orig",TYPE=AUDIO,GROUP-ID="234",NAME="Português (original)",DEFAULT=YES
#EXT-X-MEDIA:URI="https://m/dub-en",TYPE=AUDIO,GROUP-ID="234",NAME="English",DEFAULT=NO
#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="avc1.4D401E,mp4a.40.2",RESOLUTION=640x360,AUDIO="234"
https://m/v
`, 'https://m/');
  assert.equal(m.audio['234'], 'https://m/orig');
});

test('timestamp do áudio vem da tag ID3 PRIV (transportStreamTimestamp)', async () => {
  const { id3Timestamp } = await import('../extension/app/lib/media/adts.js');
  const owner = new TextEncoder().encode('com.apple.streaming.transportStreamTimestamp\0');
  const ts = 27_867_000; // 309,63 s × 90000
  const val = new Uint8Array(8);
  new DataView(val.buffer).setBigUint64(0, BigInt(ts));
  const frameBody = new Uint8Array([...owner, ...val]);
  const frame = new Uint8Array([...new TextEncoder().encode('PRIV'), 0, 0, 0, frameBody.length, 0, 0, ...frameBody]);
  const size = frame.length;
  const tag = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f, ...frame]);
  assert.equal(id3Timestamp(tag), ts);
  assert.equal(parseAdts(new Uint8Array([...tag, ...read('a0.aac')])).pts, ts);
});

test('classificação: indisponível/robô é temporário; privado e removido são definitivos', async () => {
  const { resolveYouTube } = await import('../extension/app/lib/youtube.js');
  const fake = (status, reason) => async (url) => (url.includes('/watch') ? new Response('"VISITOR_DATA":"abc"') : new Response(JSON.stringify({ playabilityStatus: { status, reason } })));
  const cases = [
    ['UNPLAYABLE', 'Este vídeo não está disponível', false],
    ['LOGIN_REQUIRED', 'Faça login para confirmar que você não é um robô', false],
    ['ERROR', 'Este vídeo é privado', true],
    ['ERROR', 'Este vídeo foi removido pelo usuário', true],
    ['LOGIN_REQUIRED', 'Confirme sua idade', true],
  ];
  for (const [status, reason, permanent] of cases) {
    await assert.rejects(resolveYouTube('dQw4w9WgXcQ', { fetchImpl: fake(status, reason) }), (e) => e.permanent === permanent, reason);
  }
});
