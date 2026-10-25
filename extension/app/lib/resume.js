// Download interrompido (aba fechada, extensão atualizada, Chrome fechado ou travado): a lista de
// arquivos, o destino escolhido (o handle da pasta ou do ZIP) e o progresso ficam no IndexedDB da
// extensão, para a página oferecer "Continuar" quando abrir de novo.
//
// - Pasta: nada se perde. O que já está na pasta com o tamanho certo é pulado (DirectoryTarget).
// - ZIP: o Chrome só grava o arquivo quando ele é fechado no fim; antes disso tudo fica num
//   arquivo temporário que some com a página. Dá para recomeçar com a mesma lista, sem escolher de novo.
//
// Cada download em andamento segura a trava `ava-job-<id>` (Web Locks); um registro cuja trava
// está livre é de uma página que morreu no meio — e não de outra aba que ainda está baixando.

const DB_NAME = 'ava-downloader';
const DB_VERSION = 1;
const JOBS = 'jobs';
const PROGRESS = 'progress';
export const RECORD_VERSION = 1;
export const lockName = (id) => `ava-job-${id}`;

// Só o necessário para baixar de novo e montar o índice; o resto (status, File do YouTube…) fica de fora.
const ENTRY_FIELDS = ['path', 'url', 'size', 'kind', 'titulo', 'curso', 'disciplina', 'aula', 'videoId'];

export function entryForResume(e) {
  const out = {};
  for (const k of ENTRY_FIELDS) if (e[k] !== undefined) out[k] = e[k];
  return out;
}

export function makeRecord({ id, format, handle, entries, index = [], missing = [], now = Date.now() }) {
  return {
    v: RECORD_VERSION,
    id,
    format,
    handle,
    entries: entries.map(entryForResume),
    index,
    missing: missing.map(entryForResume),
    files: entries.length,
    bytes: entries.reduce((sum, e) => sum + (e.size || 0), 0),
    startedAt: now,
  };
}

export function isResumable(rec) {
  return Boolean(rec && rec.v === RECORD_VERSION && rec.id && (rec.format === 'zip' || rec.format === 'dir') && rec.handle && Array.isArray(rec.entries) && rec.entries.length);
}

/** Progresso que vale guardar: arquivos prontos (baixados ou já existentes), com erro, e bytes prontos. */
export function progressOf(items, now = Date.now()) {
  const p = { finished: 0, failed: 0, bytes: 0, at: now };
  for (const it of items) {
    if (it.status === 'done' || it.status === 'skipped') {
      p.finished += 1;
      p.bytes += it.size ?? it.progress ?? 0;
    } else if (it.status === 'failed') p.failed += 1;
  }
  return p;
}

/** Registros que ninguém está baixando agora, do mais recente para o mais antigo. */
export function orphaned(records, heldLocks) {
  const held = new Set(heldLocks);
  return records.filter((r) => isResumable(r) && !held.has(lockName(r.id))).sort((a, b) => b.startedAt - a.startedAt);
}

const done = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const finished = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transação cancelada'));
  });

/** Guarda e lê os downloads em andamento. `idb` e `locks` são injetáveis para testes. */
export function createResumeStore({ idb = globalThis.indexedDB, locks = globalThis.navigator?.locks } = {}) {
  let dbp = null;
  const db = () => {
    if (!idb) return Promise.reject(new Error('IndexedDB indisponível'));
    if (!dbp) {
      const req = idb.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(JOBS)) d.createObjectStore(JOBS, { keyPath: 'id' });
        if (!d.objectStoreNames.contains(PROGRESS)) d.createObjectStore(PROGRESS);
      };
      dbp = done(req);
      dbp.catch(() => (dbp = null));
    }
    return dbp;
  };

  return {
    async save(record) {
      const tx = (await db()).transaction([JOBS, PROGRESS], 'readwrite');
      tx.objectStore(JOBS).put(record);
      tx.objectStore(PROGRESS).put({ finished: 0, failed: 0, bytes: 0, at: record.startedAt }, record.id);
      await finished(tx);
    },

    // A lista de arquivos é grande e não muda; o progresso, pequeno, é gravado à parte várias vezes.
    async progress(id, p) {
      const tx = (await db()).transaction(PROGRESS, 'readwrite');
      tx.objectStore(PROGRESS).put(p, id);
      await finished(tx);
    },

    async remove(id) {
      const tx = (await db()).transaction([JOBS, PROGRESS], 'readwrite');
      tx.objectStore(JOBS).delete(id);
      tx.objectStore(PROGRESS).delete(id);
      await finished(tx);
    },

    /** O download interrompido mais recente (com o progresso em `.progress`), ou null. */
    async interrupted() {
      const tx = (await db()).transaction([JOBS, PROGRESS], 'readonly');
      const [records, progress, keys] = await Promise.all([done(tx.objectStore(JOBS).getAll()), done(tx.objectStore(PROGRESS).getAll()), done(tx.objectStore(PROGRESS).getAllKeys())]);
      const held = locks?.query ? ((await locks.query()).held || []).map((l) => l.name) : [];
      const [rec] = orphaned(records, held);
      if (!rec) return null;
      const i = keys.indexOf(rec.id);
      return { ...rec, progress: i >= 0 ? progress[i] : null };
    },

    /** Roda fn segurando a trava deste download (outras abas sabem que ele está vivo). */
    hold(id, fn) {
      return locks?.request ? locks.request(lockName(id), fn) : fn();
    },
  };
}
