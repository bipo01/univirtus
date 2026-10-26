// Motor de download: fila paralela, pausa/continuar, retomada com HTTP Range depois de falha
// de rede, novas tentativas com espera crescente, e dois destinos:
//   - ZipTarget: um único .zip gravado direto no disco (sem passar tudo pela memória);
//   - DirectoryTarget: pasta organizada; arquivos que já existem com o mesmo tamanho são pulados,
//     então rodar de novo só baixa o que falta.

import { buildOfflineIndex, loadPlayerAssets, readPlayerData, STORAGE_DIR } from './offline-index.js';
import { ZipWriter } from './zip.js';

export const INDEX_FILE = 'Assistir aulas.html';
export const REPORT_FILE = 'LEIA-ME - arquivos com erro.txt';
export const FOLDER_NAME = 'Aulas Uninter';

const encoder = new TextEncoder();
// Id da extensão (na página da extensão) e da pasta: a página gerada abre pela extensão, que guarda o acesso à pasta.
const extensionId = () => globalThis.chrome?.runtime?.id || null;
const newFolderId = () => globalThis.crypto?.randomUUID?.() || `f${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

export class HttpError extends Error {
  constructor(status) {
    super(status === 404 ? 'Arquivo não encontrado no servidor (404)' : `O servidor respondeu ${status}`);
    this.status = status;
    this.permanent = status === 404 || status === 410 || status === 403 || status === 401;
  }
}

export class SizeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SizeError';
  }
}

export class CancelledError extends Error {
  constructor() {
    super('Download cancelado');
    this.cancelled = true;
  }
}

const isAbort = (err) => err?.name === 'AbortError';

export function describeError(err) {
  if (!err) return 'Erro desconhecido';
  if (err.name === 'QuotaExceededError') return 'Sem espaço suficiente no disco';
  if (err.name === 'NotAllowedError') return 'Sem permissão para gravar na pasta escolhida';
  if (err.name === 'TypeError' && /fetch/i.test(err.message)) return 'Falha de conexão';
  return err.message || String(err);
}

/** Descobre o tamanho de um arquivo sem baixá-lo. { size } | { size: null } | { missing: true } */
export async function probeSize(url, { fetchImpl = fetch, signal } = {}) {
  try {
    const r = await fetchImpl(url, { method: 'HEAD', credentials: 'omit', cache: 'no-store', signal });
    if (r.status === 404 || r.status === 410) return { missing: true };
    if (r.ok) {
      const n = Number(r.headers.get('content-length'));
      if (Number.isFinite(n) && n > 0) return { size: n };
    }
  } catch (err) {
    if (signal?.aborted) throw err;
  }
  try {
    const r = await fetchImpl(url, { headers: { Range: 'bytes=0-0' }, credentials: 'omit', cache: 'no-store', signal });
    if (r.status === 404 || r.status === 410) return { missing: true };
    const total = /\/(\d+)\s*$/.exec(r.headers.get('content-range') || '');
    const n = Number(r.headers.get('content-length'));
    try {
      await r.body?.cancel();
    } catch {
      /* ignora */
    }
    if (total) return { size: Number(total[1]) };
    if (r.status === 200 && Number.isFinite(n) && n > 0) return { size: n };
  } catch (err) {
    if (signal?.aborted) throw err;
  }
  return { size: null };
}

/** Controla pausa e cancelamento: aborta as conexões ativas e segura as próximas. */
export class Gate {
  constructor() {
    this.paused = false;
    this.cancelled = false;
    this.waiters = [];
    this.cancelWaiters = new Set();
    this.controllers = new Set();
  }

  controller() {
    const c = new AbortController();
    this.controllers.add(c);
    if (this.paused || this.cancelled) c.abort();
    return c;
  }

  release(c) {
    this.controllers.delete(c);
  }

  wait() {
    if (!this.paused || this.cancelled) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Espera `ms`, mas termina na hora se o download for cancelado. */
  sleep(ms) {
    if (this.cancelled) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.cancelWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.cancelWaiters.add(done);
    });
  }

  pause() {
    if (this.cancelled) return;
    this.paused = true;
    for (const c of this.controllers) c.abort();
  }

  resume() {
    this.paused = false;
    const w = this.waiters.splice(0);
    w.forEach((fn) => fn());
  }

  cancel() {
    this.cancelled = true;
    for (const c of this.controllers) c.abort();
    for (const fn of [...this.cancelWaiters]) fn();
    this.resume();
  }
}

function concat(chunks, length) {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(length);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/**
 * Item: { path, url, size|null, ... } — recebe status: pending|active|done|skipped|failed|cancelled,
 * progress (bytes) e error (texto).
 */
export class DownloadJob {
  /**
   * @param youtube    { resolve(videoId), download(info, { sink, getSegment, onProgress }) } — para itens kind 'youtube'
   * @param tempStore  { create() → { sink, finish() → File, remove() } } — onde o MP4 do YouTube é montado antes de ir ao destino
   */
  constructor({ entries, target, concurrency = 4, fetchImpl = (...a) => fetch(...a), retries = 5, chunkSize = 4 << 20, backoff = (n) => Math.min(30000, 1000 * 2 ** (n - 1)), youtube = null, tempStore = null }) {
    this.youtube = youtube;
    this.tempStore = tempStore;
    this.items = entries.map((e) => ({ ...e, status: 'pending', progress: 0, error: null, attempt: 0 }));
    this.target = target;
    this.concurrency = concurrency;
    this.fetchImpl = fetchImpl;
    this.retries = retries;
    this.chunkSize = chunkSize;
    this.backoff = backoff;
    this.gate = new Gate();
    this.fatal = null;
    this.startedAt = null;
    this.finishedAt = null;
    this.phase = 'idle'; // idle | running | finishing | done | cancelled | error
  }

  pause() {
    this.gate.pause();
  }

  resume() {
    this.gate.resume();
  }

  cancel() {
    this.gate.cancel();
  }

  get paused() {
    return this.gate.paused;
  }

  async start() {
    this.startedAt = Date.now();
    this.phase = 'running';
    try {
      await this.target.begin(this.items);
      const parallel = this.items.filter((i) => !this.target.isSequential(i));
      const sequential = this.items.filter((i) => this.target.isSequential(i));
      let next = 0;
      const worker = async () => {
        while (next < parallel.length && !this.gate.cancelled) await this.runItem(parallel[next++]);
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(this.concurrency, parallel.length)) }, worker));
      for (const it of sequential) {
        if (this.gate.cancelled) break;
        if (it.status === 'failed' || it.status === 'skipped') continue;
        await this.runItem(it);
      }
      if (this.gate.cancelled) throw this.fatal || new CancelledError();
      this.phase = 'finishing';
      await this.target.finish(this.items);
      this.phase = 'done';
      return this.summary();
    } catch (err) {
      this.phase = this.fatal ? 'error' : err?.cancelled ? 'cancelled' : 'error';
      if (!this.fatal && !err?.cancelled) this.fatal = err;
      for (const it of this.items) if (it.status === 'pending' || it.status === 'active') it.status = 'cancelled';
      try {
        await this.target.cancel();
      } catch {
        /* nada a fazer */
      }
      throw this.fatal || err;
    } finally {
      for (const it of this.items) await this.releaseTemp(it);
      this.finishedAt = Date.now();
    }
  }

  async runItem(it) {
    await this.gate.wait();
    if (this.gate.cancelled) return;
    it.status = 'active';
    let writer = null;
    try {
      if (!it.prepared) {
        const prep = await this.target.prepare(it);
        it.prepared = true;
        if (prep?.skip) {
          it.status = 'skipped';
          it.progress = prep.size ?? it.size ?? 0;
          return;
        }
      }
      if (it.kind === 'youtube' && !it.file) await this.produceYouTube(it);
      writer = await this.target.open(it);
      if (it.file) await this.copyFile(it, writer);
      else await this.transfer(it, writer);
      await writer.close();
      it.status = 'done';
      it.progress = it.file ? it.file.size : writer.written;
      await this.releaseTemp(it);
    } catch (err) {
      await this.releaseTemp(it);
      if (writer) {
        try {
          // Cancelado: o destino inteiro será descartado, então não vale completar o arquivo.
          if (this.gate.cancelled && writer.discard) await writer.discard();
          else await writer.abort();
        } catch {
          /* o erro original é o que importa */
        }
      }
      if (this.gate.cancelled || err?.cancelled) {
        it.status = 'cancelled';
        return;
      }
      it.status = 'failed';
      it.error = describeError(err);
      if (err?.sizeChanged) it.sizeChanged = true;
      if (err?.disk) {
        // Disco cheio ou sem permissão: não adianta continuar os outros.
        this.fatal = err;
        this.gate.cancel();
      }
    }
  }

  /** Monta o MP4 do YouTube num arquivo temporário (it.file). */
  async produceYouTube(it) {
    if (!this.youtube || !this.tempStore) throw new Error('Download do YouTube indisponível');
    const info = await this.retrying(it, () => this.youtube.resolve(it.videoId));
    it.expected = info.estimate || null;
    // Quando o vídeo falha, os segmentos ainda em andamento param e não mexem mais no item.
    const run = { dead: false, controllers: new Set() };
    try {
      it.temp = await this.tempStore.create();
      await this.youtube.download(info, {
        sink: it.temp.sink,
        getSegment: (url) => this.fetchBytes(it, url, run),
        getText: async (url) => new TextDecoder().decode(await this.fetchBytes(it, url, run)),
        onProgress: (done, total) => {
          if (run.dead) return;
          it.progress = done;
          it.expected = total;
        },
      });
      it.file = await it.temp.finish();
    } catch (err) {
      if (err?.name === 'QuotaExceededError') err.disk = true; // sem espaço para montar o vídeo
      throw err;
    } finally {
      run.dead = true;
      for (const c of run.controllers) c.abort();
    }
    it.expected = it.file.size;
    it.progress = it.file.size;
  }

  async releaseTemp(it) {
    const temp = it.temp;
    it.temp = null;
    it.file = null;
    if (temp) await temp.remove().catch(() => {});
  }

  /** Repete fn com espera crescente; respeita pausa/cancelamento e erros definitivos. */
  async retrying(it, fn) {
    for (let attempt = 0; ; ) {
      await this.gate.wait();
      if (this.gate.cancelled) throw new CancelledError();
      try {
        return await fn();
      } catch (err) {
        if (this.gate.cancelled) throw new CancelledError();
        attempt += 1;
        if (err?.permanent || attempt > this.retries) throw err;
        it.error = `Tentando de novo (${attempt}/${this.retries})…`;
        await this.gate.sleep(this.backoff(attempt));
        it.error = null;
      }
    }
  }

  /** Baixa um pedaço pequeno inteiro (segmento HLS), com novas tentativas e pausa. */
  async fetchBytes(it, url, run = { dead: false, controllers: new Set() }) {
    const stale = () => Object.assign(new Error('Interrompido'), { permanent: true });
    for (let attempt = 0; ; ) {
      await this.gate.wait();
      if (this.gate.cancelled) throw new CancelledError();
      if (run.dead) throw stale();
      const ctrl = this.gate.controller();
      run.controllers.add(ctrl);
      try {
        const res = await this.fetchImpl(url, { signal: ctrl.signal, credentials: 'omit', cache: 'no-store' });
        if (!res.ok) throw new HttpError(res.status);
        return new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        if (this.gate.cancelled) throw new CancelledError();
        if (run.dead) throw stale();
        if (isAbort(err) && ctrl.signal.aborted) continue; // pausa
        attempt += 1;
        if (err?.permanent || attempt > this.retries) throw err;
        it.error = `Tentando de novo (${attempt}/${this.retries})…`;
        await this.gate.sleep(this.backoff(attempt));
        if (run.dead) throw stale();
        it.error = null;
      } finally {
        this.gate.release(ctrl);
        run.controllers.delete(ctrl);
      }
    }
  }

  /** Copia o arquivo temporário para o destino. */
  async copyFile(it, writer) {
    const reader = it.file.stream().getReader();
    let chunks = [];
    let buffered = 0;
    const flush = async () => {
      if (!buffered) return;
      const data = concat(chunks, buffered);
      chunks = [];
      buffered = 0;
      try {
        await writer.write(data);
      } catch (err) {
        if (typeof DOMException !== 'undefined' && err instanceof DOMException) err.disk = true;
        throw err;
      }
    };
    for (;;) {
      if (this.gate.cancelled) throw new CancelledError();
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      buffered += value.length;
      if (buffered >= this.chunkSize) await flush();
    }
    await flush();
  }

  async transfer(it, writer) {
    for (;;) {
      await this.gate.wait();
      if (this.gate.cancelled) throw new CancelledError();
      const ctrl = this.gate.controller();
      let chunks = [];
      let buffered = 0;
      const flush = async () => {
        if (!buffered) return;
        const data = concat(chunks, buffered);
        chunks = [];
        buffered = 0;
        try {
          await writer.write(data);
        } catch (err) {
          err.permanent = true;
          // Erros do sistema de arquivos (disco cheio, sem permissão) param tudo; os demais só este arquivo.
          if (typeof DOMException !== 'undefined' && err instanceof DOMException) err.disk = true;
          throw err;
        }
      };
      try {
        const from = writer.written;
        const res = await this.fetchImpl(it.url, {
          headers: from > 0 ? { Range: `bytes=${from}-` } : undefined,
          signal: ctrl.signal,
          credentials: 'omit',
          cache: 'no-store',
        });
        if (res.status === 416 && from > 0 && it.size != null && from === it.size) {
          // Pausa caiu depois do último byte gravado: o arquivo já está completo.
          it.progress = from;
          return;
        }
        if (!res.ok) throw new HttpError(res.status);
        const serverTotal = Number((/\/(\d+)\s*$/.exec(res.headers.get('content-range') || '') || [])[1]) || (res.status === 200 ? Number(res.headers.get('content-length')) || null : null);
        if (it.size != null && serverTotal && serverTotal !== it.size) {
          await res.body?.cancel();
          throw Object.assign(new SizeError('O arquivo mudou no servidor. Atualize a lista e tente de novo.'), { permanent: true, sizeChanged: true });
        }
        if (from > 0) {
          const start = /bytes\s+(\d+)-/.exec(res.headers.get('content-range') || '');
          if (res.status !== 206 || !start || Number(start[1]) !== from) {
            // O servidor não continuou de onde parou: recomeça este arquivo do zero.
            await writer.reset();
            if (res.status !== 200) {
              await res.body?.cancel();
              throw new SizeError('O servidor não aceitou continuar o download');
            }
          }
        }
        if (it.size == null) {
          const total = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
          const len = Number(res.headers.get('content-length'));
          it.expected = total ? Number(total[1]) : res.status === 200 && len > 0 ? len : null;
        }
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          buffered += value.length;
          it.progress = writer.written + buffered;
          if (it.size != null && it.progress > it.size) {
            await reader.cancel();
            throw new SizeError('O arquivo no servidor ficou maior do que o previsto');
          }
          if (buffered >= this.chunkSize) await flush();
        }
        await flush();
        if (it.size != null && writer.written !== it.size) throw new SizeError(`Download incompleto (${writer.written} de ${it.size} bytes)`);
        it.progress = writer.written;
        return;
      } catch (err) {
        it.progress = writer.written;
        if (this.gate.cancelled) throw err?.disk ? err : new CancelledError();
        if (isAbort(err) && ctrl.signal.aborted) continue; // pausa: volta a esperar no gate e continua de onde parou
        if (err?.permanent) throw err;
        if (err instanceof SizeError) await writer.reset();
        it.attempt += 1;
        if (it.attempt > this.retries) throw err;
        it.error = `Tentando de novo (${it.attempt}/${this.retries})…`;
        await this.gate.sleep(this.backoff(it.attempt));
        it.error = null;
      } finally {
        this.gate.release(ctrl);
      }
    }
  }

  snapshot() {
    const counts = { pending: 0, active: 0, done: 0, skipped: 0, failed: 0, cancelled: 0 };
    let bytes = 0;
    let skippedBytes = 0;
    let total = 0;
    const active = [];
    const failed = [];
    for (const it of this.items) {
      counts[it.status] += 1;
      const size = it.size ?? it.expected ?? null;
      total += size ?? 0;
      if (it.status === 'done' || it.status === 'skipped') bytes += size ?? it.progress;
      if (it.status === 'skipped') skippedBytes += size ?? it.progress;
      else if (it.status === 'active') {
        bytes += it.progress;
        active.push(it);
      } else if (it.status === 'failed') failed.push(it);
    }
    return { counts, bytes, transferred: bytes - skippedBytes, total, active, failed, paused: this.gate.paused, phase: this.phase, startedAt: this.startedAt, finishedAt: this.finishedAt };
  }

  summary() {
    return this.snapshot();
  }
}

function failureReport(items) {
  const failed = items.filter((i) => i.status === 'failed');
  if (!failed.length) return null;
  const lines = [
    'Alguns arquivos não puderam ser baixados.',
    'Abra a extensão de novo, selecione estes itens e tente outra vez.',
    '',
    ...failed.map((i) => `- ${i.path}\n  Motivo: ${i.error || 'erro desconhecido'}`),
    '',
  ];
  return encoder.encode(lines.join('\r\n'));
}

function indexBytes(index, items, assets, opts = {}) {
  const ok = new Set(items.filter((i) => i.status === 'done' || i.status === 'skipped').map((i) => i.path));
  return encoder.encode(buildOfflineIndex(index, { ...opts, isOk: (e) => ok.has(e.path), assets }));
}

async function writeAt(base, path, bytes) {
  const parts = path.split('/');
  let dir = base;
  for (const name of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(name, { create: true });
  const stream = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable({ keepExistingData: false });
  await stream.write(bytes);
  await stream.close();
}

/** Grava a página "Assistir aulas" e os arquivos de apoio (pdf.js em %storage%/app). Os dados do aluno em %storage% não são tocados. */
async function writePlayer(base, html, assets) {
  for (const f of assets.files) await writeAt(base, f.path, f.bytes);
  await writeAt(base, INDEX_FILE, html);
}

const SUBFOLDER_KIND = { Áudio: 'audio', Libras: 'libras', Materiais: 'material' };
const byName = (a, b) => a.name.localeCompare(b.name, 'pt-BR', { numeric: true });

async function listDir(handle) {
  const out = [];
  for await (const [name, h] of handle.entries()) {
    if (name.startsWith('.') || name.endsWith('.crswap') || name === STORAGE_DIR) continue;
    out.push({ name, handle: h, kind: h.kind });
  }
  return out.sort(byName);
}

const titleFromFile = (name) => name.replace(/\.[^.]+$/, '').replace(/^\d{2,3} - /, '');

/**
 * Monta o índice a partir dos arquivos que existem de fato: Curso/Disciplina/Aula/arquivos.
 * Links e URLs do YouTube não ficam no disco: vêm do índice atual ou da página gerada antes (`previous`).
 */
export async function scanTree(base, currentIndex = [], previous = null) {
  const links = new Map(previous?.links || []);
  const urls = new Map(previous?.urls || []);
  for (const c of currentIndex)
    for (const d of c.disciplinas)
      for (const g of d.grupos) {
        if (g.dir && g.links?.length) links.set(g.dir, g.links);
        for (const e of g.itens || []) if (e.kind === 'youtube' && e.url) urls.set(e.path, e.url);
      }

  const cursos = [];
  for (const c of (await listDir(base)).filter((x) => x.kind === 'directory')) {
    const curso = { nome: c.name, disciplinas: [] };
    for (const d of (await listDir(c.handle)).filter((x) => x.kind === 'directory')) {
      const disc = { nome: d.name, grupos: [] };
      for (const g of (await listDir(d.handle)).filter((x) => x.kind === 'directory')) {
        const dir = `${c.name}/${d.name}/${g.name}`;
        const grupo = { nome: g.name, dir, itens: [], links: links.get(dir) || [] };
        const extras = [];
        for (const f of await listDir(g.handle)) {
          if (f.kind === 'file') {
            const completo = /^00 - Aula completa\./.test(f.name);
            if (/^YouTube - /.test(f.name)) {
              const path = `${dir}/${f.name}`;
              grupo.itens.push({ path, titulo: titleFromFile(f.name).replace(/^YouTube - /, ''), kind: 'youtube', ...(urls.has(path) ? { url: urls.get(path) } : {}) });
              continue;
            }
            grupo.itens.push({ path: `${dir}/${f.name}`, titulo: completo ? 'Aula completa' : titleFromFile(f.name), kind: completo ? 'completo' : /\.(mp3|m4a)$/i.test(f.name) ? 'audio' : /\.(mp4|m4v|webm|mov)$/i.test(f.name) ? 'video' : 'material' });
          } else if (SUBFOLDER_KIND[f.name]) {
            for (const s of (await listDir(f.handle)).filter((x) => x.kind === 'file')) {
              extras.push({ path: `${dir}/${f.name}/${s.name}`, titulo: titleFromFile(s.name), kind: SUBFOLDER_KIND[f.name] });
            }
          }
        }
        grupo.itens.push(...extras);
        if (grupo.itens.length || grupo.links.length) disc.grupos.push(grupo);
      }
      if (disc.grupos.length) curso.disciplinas.push(disc);
    }
    if (curso.disciplinas.length) cursos.push(curso);
  }
  return cursos;
}

/** Grava tudo num único .zip escolhido pelo usuário (FileSystemFileHandle). */
export class ZipTarget {
  constructor(fileHandle, { index = [] } = {}) {
    this.fileHandle = fileHandle;
    this.index = index;
    this.stream = null;
    this.zip = null;
    this.queue = Promise.resolve();
  }

  write(position, data) {
    const p = this.queue.then(() => this.stream.write({ type: 'write', position, data }));
    this.queue = p.catch(() => {});
    return p;
  }

  async begin(items) {
    // O player vai junto no fim: se não carregar, melhor falhar antes de baixar tudo.
    this.assets = await loadPlayerAssets();
    this.stream = await this.fileHandle.createWritable({ keepExistingData: false });
    this.zip = new ZipWriter({ write: (pos, data) => this.write(pos, data) });
    for (const it of items) if (it.size != null) it.zipEntry = this.zip.reserve(it.path, it.size);
  }

  isSequential(it) {
    // O YouTube é montado à parte e chega com tamanho conhecido: entra em paralelo e reserva a vaga na hora.
    return it.size == null && it.kind !== 'youtube';
  }

  async prepare() {
    return null;
  }

  async open(it) {
    const zip = this.zip;
    if (!it.zipEntry && it.file) it.zipEntry = zip.reserve(it.path, it.file.size);
    const entry = it.zipEntry || zip.beginAppend(it.path);
    const appended = !it.zipEntry;
    return {
      get written() {
        return entry.written;
      },
      write: (bytes) => zip.write(entry, bytes),
      reset: async () => zip.rewind(entry),
      close: () => (appended ? zip.endAppend(entry) : zip.close(entry)),
      abort: async () => {
        if (appended) zip.abortAppend(entry);
        else await zip.close(entry); // completa com zeros para o ZIP continuar válido
      },
      discard: async () => {
        if (appended) zip.abortAppend(entry);
      },
    };
  }

  async finish(items) {
    const assets = this.assets || (await loadPlayerAssets());
    for (const f of assets.files) await this.zip.appendBytes(f.path, f.bytes);
    await this.zip.appendBytes(INDEX_FILE, indexBytes(this.index, items, assets));
    const report = failureReport(items);
    if (report) await this.zip.appendBytes(REPORT_FILE, report);
    const end = await this.zip.finish();
    await this.queue;
    // Um anexo que falhou pode ter deixado bytes depois do fim: corta o arquivo no tamanho certo.
    await this.stream.write({ type: 'truncate', size: end });
    await this.stream.close();
  }

  async cancel() {
    if (!this.stream) return;
    await this.queue;
    await this.stream.abort();
  }
}

/** Grava numa pasta escolhida pelo usuário (FileSystemDirectoryHandle), dentro de "Aulas Uninter/". */
export class DirectoryTarget {
  constructor(dirHandle, { index = [], folderName = FOLDER_NAME } = {}) {
    this.root = dirHandle;
    this.folderName = folderName;
    this.index = index;
    this.dirs = new Map();
    this.base = null;
  }

  async begin() {
    this.assets = await loadPlayerAssets();
    this.base = this.folderName ? await this.root.getDirectoryHandle(this.folderName, { create: true }) : this.root;
    this.dirs.set('', Promise.resolve(this.base));
  }

  dir(path) {
    if (this.dirs.has(path)) return this.dirs.get(path);
    const slash = path.lastIndexOf('/');
    const parent = slash < 0 ? '' : path.slice(0, slash);
    const name = path.slice(slash + 1);
    const p = this.dir(parent).then((h) => h.getDirectoryHandle(name, { create: true }));
    this.dirs.set(path, p);
    p.catch(() => this.dirs.delete(path));
    return p;
  }

  async locate(path) {
    const slash = path.lastIndexOf('/');
    const dir = await this.dir(slash < 0 ? '' : path.slice(0, slash));
    return { dir, name: path.slice(slash + 1) };
  }

  isSequential() {
    return false;
  }

  async prepare(it) {
    const { dir, name } = await this.locate(it.path);
    try {
      const file = await (await dir.getFileHandle(name)).getFile();
      it.existed = true;
      if ((it.size != null && file.size === it.size) || (it.size == null && file.size > 0)) return { skip: true, size: file.size };
    } catch (err) {
      if (err?.name !== 'NotFoundError' && err?.name !== 'TypeMismatchError') throw err;
      it.existed = false;
    }
    return null;
  }

  async open(it) {
    const { dir, name } = await this.locate(it.path);
    const handle = await dir.getFileHandle(name, { create: true });
    const stream = await handle.createWritable({ keepExistingData: false });
    let written = 0;
    return {
      get written() {
        return written;
      },
      async write(bytes) {
        await stream.write(bytes);
        written += bytes.length;
      },
      async reset() {
        await stream.truncate(0);
        written = 0;
      },
      async close() {
        await stream.close();
      },
      async abort() {
        await stream.abort();
        if (!it.existed) await dir.removeEntry(name).catch(() => {});
      },
    };
  }

  async writeFile(name, bytes) {
    const handle = await this.base.getFileHandle(name, { create: true });
    const stream = await handle.createWritable({ keepExistingData: false });
    await stream.write(bytes);
    await stream.close();
  }

  async finish(items) {
    // O índice reflete tudo o que está na pasta, inclusive o que foi baixado em outras vezes.
    // Links e URLs do YouTube de downloads anteriores vêm da página que já estava na pasta.
    let index;
    let previous = null;
    try {
      const old = await this.base.getFileHandle(INDEX_FILE).then((h) => h.getFile()).then((f) => f.text()).catch(() => null);
      previous = old ? readPlayerData(old) : null;
      index = await scanTree(this.base, this.index, previous);
    } catch {
      index = null;
    }
    this.folderId = previous?.folderId || newFolderId();
    const assets = this.assets || (await loadPlayerAssets());
    const opts = { assets, ext: extensionId(), folderId: this.folderId };
    await writePlayer(this.base, index ? encoder.encode(buildOfflineIndex(index, opts)) : indexBytes(this.index, items, assets, opts), assets);
    const report = failureReport(items);
    if (report) await this.writeFile(REPORT_FILE, report);
    else await this.base.removeEntry(REPORT_FILE).catch(() => {});
  }

  async cancel() {}
}

async function hasFile(dir, name) {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * Atualiza só a página "Assistir aulas" de uma pasta já baixada (sem baixar nada).
 * Aceita a própria pasta das aulas ou a pasta onde ela está ("Aulas Uninter" dentro).
 */
export async function rebuildPlayerPage(picked) {
  let base = picked;
  if (!(await hasFile(base, INDEX_FILE))) {
    const inner = await picked.getDirectoryHandle(FOLDER_NAME).catch(() => null);
    if (!inner || !(await hasFile(inner, INDEX_FILE))) {
      throw new Error(`Esta pasta não tem o arquivo “${INDEX_FILE}”. Escolha a pasta das aulas (por exemplo, “${FOLDER_NAME}”).`);
    }
    base = inner;
  }
  let previous = null;
  try {
    previous = readPlayerData(await (await (await base.getFileHandle(INDEX_FILE)).getFile()).text());
  } catch {
    previous = null;
  }
  const index = await scanTree(base, [], previous);
  if (!index.length) throw new Error('Não encontrei aulas baixadas nesta pasta.');
  const assets = await loadPlayerAssets();
  const folderId = previous?.folderId || newFolderId();
  await writePlayer(base, encoder.encode(buildOfflineIndex(index, { assets, ext: extensionId(), folderId })), assets);
  let files = 0;
  for (const c of index) for (const d of c.disciplinas) for (const g of d.grupos) files += g.itens.length;
  return { folder: base.name, files, folderId, handle: base };
}
