// Baixa vídeos do YouTube direto da extensão, sem programas extras.
//
// Como funciona (verificado em out/2026):
// 1. A página do vídeo traz o VISITOR_DATA; com ele, a API interna (youtubei/v1/player) responde
//    como para o app do Apple Vision ("VISIONOS"), que entrega listas HLS sem o desafio
//    JavaScript que trava os outros caminhos.
// 2. Da lista mestre escolhemos H.264 (toca em qualquer player) até 1080p, com áudio AAC.
// 3. Os segmentos (vídeo em MPEG-TS, áudio em ADTS) são baixados em paralelo, na ordem, e
//    remontados num MP4 comum, sem recodificar (rápido e sem perder qualidade).
//
// Na extensão, o cabeçalho Origin da chamada à API é ajustado por uma regra declarativeNetRequest
// (background.js): com o Origin "chrome-extension://" o YouTube responde 403.

import { parseAdts } from './media/adts.js';
import { Mp4Muxer } from './media/mp4.js';
import { TsVideoDemuxer } from './media/ts.js';

const CLIENT = {
  clientName: 'VISIONOS',
  clientVersion: '1.02',
  deviceMake: 'Apple',
  deviceModel: 'RealityDevice17,1',
  osName: 'visionOS',
  osVersion: '26.5.23O471',
  hl: 'pt',
  timeZone: 'UTC',
  utcOffsetMinutes: 0,
};
const CLIENT_ID = '101';

export class YouTubeError extends Error {
  constructor(message, { permanent = true } = {}) {
    super(message);
    this.name = 'YouTubeError';
    this.permanent = permanent;
  }
}

const ID = /^[A-Za-z0-9_-]{11}$/;

/** Extrai o id de 11 caracteres de qualquer formato de link do YouTube (watch, youtu.be, embed, shorts, live). */
export function youtubeVideoId(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.split('/')[1];
  else if (/(^|\.)youtube(-nocookie)?\.com$/.test(host)) {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const m = /^\/(embed|shorts|live|v)\/([^/?#]+)/.exec(u.pathname);
      if (m) id = m[2];
    }
  }
  return id && ID.test(id) ? id : null;
}

function attrs(line) {
  const out = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let m;
  while ((m = re.exec(line))) out[m[1]] = m[3] ?? m[2];
  return out;
}

export function parseMaster(text, base) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  const audio = {};
  const audioDefault = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = attrs(line);
      // Vídeos dublados trazem várias faixas no mesmo grupo: fica a padrão (o idioma original).
      if (a.TYPE === 'AUDIO' && a.URI) {
        const group = a['GROUP-ID'];
        const preferred = a.DEFAULT === 'YES' || /original/i.test(a.NAME || '');
        if (!audio[group] || (preferred && !audioDefault[group])) {
          audio[group] = new URL(a.URI, base).href;
          if (preferred) audioDefault[group] = true;
        }
      }
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = attrs(line);
      const uri = lines[i + 1];
      if (!uri || uri.startsWith('#')) continue;
      const [width, height] = (a.RESOLUTION || '0x0').split('x').map(Number);
      variants.push({ url: new URL(uri, base).href, bandwidth: Number(a.BANDWIDTH) || 0, codecs: a.CODECS || '', width, height, audio: a.AUDIO || null });
    }
  }
  return { variants, audio };
}

export function parsePlaylist(text, base) {
  const out = [];
  let duration = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('#EXTINF:')) duration = parseFloat(line.slice(8)) || 0;
    else if (line.startsWith('#EXT-X-KEY') && !/METHOD=NONE/.test(line)) throw new YouTubeError('Vídeo protegido, não dá para baixar');
    else if (line && !line.startsWith('#')) {
      out.push({ url: new URL(line, base).href, duration });
      duration = 0;
    }
  }
  return out;
}

/** Escolhe H.264 com a maior resolução até maxHeight, preferindo áudio AAC-LC (mp4a.40.2). */
export function pickVariant({ variants, audio }, maxHeight = 1080) {
  const ok = variants.filter((v) => /avc1/.test(v.codecs) && v.audio && audio[v.audio]);
  if (!ok.length) return null;
  const score = (v) => [v.height <= maxHeight ? 1 : 0, v.height <= maxHeight ? v.height : -v.height, /mp4a\.40\.2/.test(v.codecs) ? 1 : 0, v.bandwidth];
  ok.sort((a, b) => {
    const x = score(a);
    const y = score(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i];
    return 0;
  });
  const v = ok[0];
  return { ...v, audioUrl: audio[v.audio] };
}

async function text(fetchImpl, url, init) {
  const r = await fetchImpl(url, init);
  if (!r.ok) throw new YouTubeError(`O YouTube respondeu ${r.status}`, { permanent: r.status === 404 || r.status === 410 });
  return r.text();
}

/** Descobre título, duração e as listas HLS de um vídeo. */
export async function resolveYouTube(id, { fetchImpl = (...a) => fetch(...a), signal, maxHeight = 1080 } = {}) {
  const page = await text(fetchImpl, `https://www.youtube.com/watch?v=${id}&hl=pt-BR&has_verified=1`, { credentials: 'omit', signal });
  const visitor = (/"VISITOR_DATA":"([^"]+)"/.exec(page) || /"visitorData":"([^"]+)"/.exec(page) || [])[1];
  if (!visitor) throw new YouTubeError('O YouTube não respondeu como esperado. Tente de novo mais tarde.', { permanent: false });

  const res = await fetchImpl('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    credentials: 'omit',
    signal,
    headers: { 'Content-Type': 'application/json', 'X-Youtube-Client-Name': CLIENT_ID, 'X-Youtube-Client-Version': CLIENT.clientVersion, 'X-Goog-Visitor-Id': visitor },
    body: JSON.stringify({ context: { client: { ...CLIENT, visitorData: visitor } }, videoId: id, contentCheckOk: true, racyCheckOk: true }),
  });
  if (!res.ok) throw new YouTubeError(`O YouTube recusou o pedido (${res.status}). Tente de novo mais tarde.`, { permanent: false });
  const player = await res.json();
  const status = player.playabilityStatus?.status;
  if (status !== 'OK') {
    const reason = player.playabilityStatus?.reason || status || 'indisponível';
    // Só é definitivo quando o motivo diz isso (privado, removido, idade, direitos autorais). O YouTube às
    // vezes responde "Este vídeo não está disponível" ou "confirme que não é um robô" e no pedido seguinte
    // libera (visto em out/2026): esses casos ganham novas tentativas, cada uma com um VISITOR_DATA novo.
    const permanent = /privad|private|removid|removed|exclu[ií]d|deleted|idade|age-restricted|confirm your age|direitos autorais|copyright|encerrad|terminated/i.test(reason);
    throw new YouTubeError(`Vídeo do YouTube indisponível: ${reason}`, { permanent });
  }
  if (player.videoDetails?.isLive) throw new YouTubeError('É uma transmissão ao vivo, não dá para baixar');
  const hls = player.streamingData?.hlsManifestUrl;
  if (!hls) throw new YouTubeError('O YouTube não liberou este vídeo para download', { permanent: false });

  const master = parseMaster(await text(fetchImpl, hls, { credentials: 'omit', signal }), hls);
  const variant = pickVariant(master, maxHeight);
  if (!variant) throw new YouTubeError('O vídeo não tem uma versão compatível (H.264)');
  return {
    id,
    title: player.videoDetails?.title || id,
    seconds: Number(player.videoDetails?.lengthSeconds) || 0,
    variant,
    /** Estimativa de tamanho (BANDWIDTH já inclui o áudio). */
    estimate: Math.round(((variant.bandwidth || 0) * (Number(player.videoDetails?.lengthSeconds) || 0)) / 8),
  };
}

/**
 * Baixa e remonta o vídeo num MP4.
 * @param sink        { write(position, Uint8Array) } — onde o MP4 é gravado
 * @param getSegment  (url) => Promise<Uint8Array> — quem baixa cuida de novas tentativas/pausa
 * @param onProgress  (bytesBaixados, estimativaTotal) => void
 * @returns           { size, title }
 */
export async function downloadYouTube(info, { sink, getSegment, getText = null, onProgress = () => {}, concurrency = 6, fetchImpl = (...a) => fetch(...a), signal }) {
  const playlist = getText || ((url) => text(fetchImpl, url, { credentials: 'omit', signal }));
  const [vText, aText] = await Promise.all([playlist(info.variant.url), playlist(info.variant.audioUrl)]);
  const video = parsePlaylist(vText, info.variant.url);
  const audio = parsePlaylist(aText, info.variant.audioUrl);
  if (!video.length) throw new YouTubeError('A lista de vídeo veio vazia', { permanent: false });

  // Ordem de gravação: v0, a0, v1, a1, ... (intercalado, como um MP4 normal).
  const jobs = [];
  for (let i = 0; i < Math.max(video.length, audio.length); i++) {
    if (video[i]) jobs.push({ kind: 'v', url: video[i].url });
    if (audio[i]) jobs.push({ kind: 'a', url: audio[i].url });
  }

  const mux = new Mp4Muxer(sink, { width: info.variant.width, height: info.variant.height });
  const demux = new TsVideoDemuxer();
  await mux.start();

  let downloaded = 0;
  const estimate = Math.max(info.estimate || 0, 1);
  const pending = new Map(); // índice → Promise<Uint8Array>
  let next = 0;
  const launch = () => {
    while (next < jobs.length && pending.size < concurrency) {
      const i = next++;
      const p = getSegment(jobs[i].url).then((bytes) => {
        downloaded += bytes.length;
        onProgress(downloaded, Math.max(estimate, downloaded));
        return bytes;
      });
      p.catch(() => {}); // o erro é tratado quando chegar a vez deste segmento
      pending.set(i, p);
    }
  };

  launch();
  for (let i = 0; i < jobs.length; i++) {
    const bytes = await pending.get(i);
    pending.delete(i);
    launch();
    if (jobs[i].kind === 'v') {
      const frames = demux.push(bytes);
      await mux.addVideo(frames, { sps: demux.sps, pps: demux.pps });
    } else {
      const { config, frames, pts } = parseAdts(bytes);
      if (config) await mux.addAudio(frames, config, pts);
    }
  }
  const size = await mux.finish();
  onProgress(downloaded, downloaded);
  return { size, title: info.title };
}
