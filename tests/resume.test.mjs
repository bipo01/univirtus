import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DirectoryTarget, DownloadJob } from '../extension/app/lib/downloader.js';
import { entryForResume, isResumable, lockName, makeRecord, orphaned, progressOf } from '../extension/app/lib/resume.js';
import { fakeCdn, memoryDir, randomBytes } from './helpers.mjs';

const U = (n) => `https://vod.grupouninter.com.br/2021/SET/R-A01-P0${n}.mp4`;
const entry = (n, size) => ({ path: `Curso/Disc/Aula 01/0${n} - Tema ${n}.mp4`, url: U(n), size, kind: 'video', titulo: `Tema ${n}`, curso: 'Curso', disciplina: 'Disc', aula: 'Aula 01' });

test('registro guarda só o necessário e sobrevive à cópia estruturada do IndexedDB', () => {
  const handle = { kind: 'directory', name: 'Downloads' };
  const e = { ...entry(1, 100), status: 'done', progress: 100, file: { stream() {} }, zipEntry: {}, temp: null };
  const rec = makeRecord({ id: 'a', format: 'dir', handle, entries: [e, entry(2, null)], index: [{ nome: 'Curso', disciplinas: [] }], missing: [entry(3, null)], now: 5 });
  assert.deepEqual(Object.keys(rec.entries[0]).sort(), ['aula', 'curso', 'disciplina', 'kind', 'path', 'size', 'titulo', 'url']);
  assert.equal(rec.files, 2);
  assert.equal(rec.bytes, 100);
  assert.equal(rec.startedAt, 5);
  assert.equal(rec.handle, handle);
  assert.deepEqual(structuredClone({ ...rec, handle: null }).entries, rec.entries); // sem funções nem objetos que não clonam
  assert.equal(entryForResume({ ...entry(4, 1), videoId: 'abc', kind: 'youtube' }).videoId, 'abc');
});

test('isResumable recusa registros incompletos ou de outra versão', () => {
  const ok = makeRecord({ id: 'a', format: 'zip', handle: {}, entries: [entry(1, 1)] });
  assert.equal(isResumable(ok), true);
  assert.equal(isResumable({ ...ok, v: 99 }), false);
  assert.equal(isResumable({ ...ok, entries: [] }), false);
  assert.equal(isResumable({ ...ok, handle: null }), false);
  assert.equal(isResumable({ ...ok, format: 'pasta' }), false);
  assert.equal(isResumable(null), false);
});

test('orphaned ignora downloads ainda vivos em outra aba e devolve o mais recente primeiro', () => {
  const r = (id, startedAt) => makeRecord({ id, format: 'dir', handle: {}, entries: [entry(1, 1)], now: startedAt });
  const list = orphaned([r('velho', 1), r('vivo', 3), r('novo', 2)], [lockName('vivo'), 'outra-trava']);
  assert.deepEqual(list.map((x) => x.id), ['novo', 'velho']);
});

test('progressOf conta prontos (baixados e já existentes) e falhas', () => {
  const p = progressOf(
    [
      { status: 'done', size: 10 },
      { status: 'skipped', size: null, progress: 7 },
      { status: 'active', size: 50, progress: 20 },
      { status: 'failed', size: 5 },
      { status: 'pending', size: 5 },
    ],
    9,
  );
  assert.deepEqual(p, { finished: 2, failed: 1, bytes: 17, at: 9 });
});

test('Pasta: página que morre no meio do download continua de onde parou com a lista guardada', async () => {
  const bodies = new Map([1, 2, 3, 4].map((n) => [U(n), randomBytes(300_000 + n * 1000, n)]));
  const entries = [1, 2, 3, 4].map((n) => entry(n, bodies.get(U(n)).length));
  const root = memoryDir();

  // 1ª página: os temas 1 e 2 terminam; 3 e 4 travam no meio (a aba é fechada / a extensão atualizada).
  const cdn = fakeCdn(bodies);
  const hang = async (url, opts) => {
    if (url !== U(3) && url !== U(4)) return cdn.fetchImpl(url, opts);
    const half = bodies.get(url).subarray(0, 100_000);
    let sent = false;
    const stream = new ReadableStream({
      pull(c) {
        if (!sent) {
          sent = true;
          c.enqueue(half);
          return;
        }
        return new Promise(() => {}); // nunca termina
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-length': String(bodies.get(url).length) } });
  };
  const first = new DownloadJob({ entries, target: new DirectoryTarget(root), fetchImpl: hang, concurrency: 4 });
  first.start();
  for (let i = 0; i < 200 && progressOf(first.items).finished < 2; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(progressOf(first.items).finished, 2);
  const saved = structuredClone({ ...makeRecord({ id: 'x', format: 'dir', handle: null, entries }), handle: null });

  // 2ª página: mesma pasta, lista lida do registro. Só 3 e 4 são baixados de novo.
  const again = fakeCdn(bodies);
  const r = await new DownloadJob({ entries: saved.entries.map((e) => ({ ...e })), target: new DirectoryTarget(root), fetchImpl: again.fetchImpl }).start();
  assert.equal(r.counts.skipped, 2);
  assert.equal(r.counts.done, 2);
  assert.deepEqual(again.calls.map((c) => c.url).sort(), [U(3), U(4)]);
  const aula = root.children.get('Aulas Uninter').children.get('Curso').children.get('Disc').children.get('Aula 01');
  for (const n of [1, 2, 3, 4]) assert.deepEqual(aula.children.get(`0${n} - Tema ${n}.mp4`).data, bodies.get(U(n)), `tema ${n} íntegro`);
});
