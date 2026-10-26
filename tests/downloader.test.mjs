import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DirectoryTarget, DownloadJob, INDEX_FILE, REPORT_FILE, ZipTarget, probeSize } from '../extension/app/lib/downloader.js';
import { fakeCdn, memoryDir, nodeFileHandle, randomBytes } from './helpers.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-dl-'));
const U = (n) => `https://vod.grupouninter.com.br/2021/SET/X-A01-P0${n}.mp4`;

function files(n, size = 200_000) {
  const m = new Map();
  for (let i = 1; i <= n; i++) m.set(U(i), randomBytes(size + i * 1000, i));
  return m;
}

const entriesFor = (m, sized = true) =>
  [...m.entries()].map(([url, body], i) => ({
    path: `Curso/Disciplina/Aula 01 - Teste/0${i + 1} - Tema ${i + 1}.mp4`,
    url,
    size: sized ? body.length : null,
    kind: 'video',
    titulo: `Tema ${i + 1}`,
  }));

function readZip(file) {
  const script = `
import json, sys, zipfile, hashlib
z = zipfile.ZipFile(sys.argv[1])
print(json.dumps({"bad": z.testzip(), "files": {i.filename: hashlib.sha1(z.read(i)).hexdigest() for i in z.infolist()}}))
`;
  return JSON.parse(execFileSync('python3', ['-I', '-c', script, file]).toString());
}

const sha1 = async (bytes) => Buffer.from(await crypto.subtle.digest('SHA-1', bytes)).toString('hex');

test('probeSize: HEAD, fallback com Range e 404', async () => {
  const m = files(1);
  const { fetchImpl } = fakeCdn(m);
  assert.deepEqual(await probeSize(U(1), { fetchImpl }), { size: m.get(U(1)).length });
  assert.deepEqual(await probeSize(U(9), { fetchImpl }), { missing: true });
  const noHead = async (url, opts) => (opts.method === 'HEAD' ? new Response(null, { status: 403 }) : fetchImpl(url, opts));
  assert.deepEqual(await probeSize(U(1), { fetchImpl: noHead }), { size: m.get(U(1)).length });
});

test('ZIP: downloads paralelos, queda de conexão no meio é retomada com Range', async () => {
  const m = files(5);
  const failOnce = new Map([[U(2), 100_000], [U(4), 70_000]]);
  const { fetchImpl, calls } = fakeCdn(m, { failOnce });
  const file = path.join(tmp, 'job.zip');
  const entries = entriesFor(m);
  const job = new DownloadJob({ entries, target: new ZipTarget(nodeFileHandle(file), { index: [] }), concurrency: 3, fetchImpl, backoff: () => 1, chunkSize: 50_000 });
  const result = await job.start();
  assert.equal(result.counts.done, 5);
  assert.equal(result.counts.failed, 0);
  const ranges = calls.filter((c) => c.range).map((c) => c.url);
  assert.deepEqual(ranges.sort(), [U(2), U(4)].sort(), 'retomou só os que caíram');
  const z = readZip(file);
  assert.equal(z.bad, null);
  for (const e of entries) assert.equal(z.files[e.path], await sha1(m.get(e.url)));
  assert.ok(INDEX_FILE in z.files);
  assert.ok('%storage%/app/pdf.min.js' in z.files && '%storage%/app/pdf.worker.min.js' in z.files, 'leitor de PDF dentro do ZIP');
  assert.ok(!(REPORT_FILE in z.files));
});

test('ZIP: arquivo inexistente vira relatório de erro e o restante fica íntegro', async () => {
  const m = files(2);
  const { fetchImpl } = fakeCdn(m);
  const entries = entriesFor(m);
  entries.push({ path: 'Curso/D/A/sumiu.mp4', url: U(7), size: 5000, kind: 'video', titulo: 'x' });
  const file = path.join(tmp, 'falha.zip');
  const job = new DownloadJob({ entries, target: new ZipTarget(nodeFileHandle(file)), fetchImpl, backoff: () => 1 });
  const r = await job.start();
  assert.equal(r.counts.failed, 1);
  assert.match(r.failed[0].error, /404/);
  const z = readZip(file);
  assert.equal(z.bad, null);
  assert.ok(REPORT_FILE in z.files);
});

test('ZIP: tamanho desconhecido é gravado no fim, em sequência', async () => {
  const m = files(3);
  const { fetchImpl } = fakeCdn(m);
  const entries = entriesFor(m);
  entries[1].size = null;
  const file = path.join(tmp, 'semtamanho.zip');
  const r = await new DownloadJob({ entries, target: new ZipTarget(nodeFileHandle(file)), fetchImpl, backoff: () => 1 }).start();
  assert.equal(r.counts.done, 3);
  const z = readZip(file);
  assert.equal(z.bad, null);
  for (const e of entries) assert.equal(z.files[e.path], await sha1(m.get(e.url)));
});

test('pausar aborta as conexões e continuar retoma de onde parou', async () => {
  const m = files(3, 2_000_000);
  const { fetchImpl, calls } = fakeCdn(m, { chunkDelay: 2 });
  const file = path.join(tmp, 'pausa.zip');
  const entries = entriesFor(m);
  const job = new DownloadJob({ entries, target: new ZipTarget(nodeFileHandle(file)), concurrency: 3, fetchImpl, backoff: () => 1, chunkSize: 64 * 1024 });
  const running = job.start();
  await new Promise((r) => setTimeout(r, 30));
  job.pause();
  const before = job.snapshot().bytes;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(job.snapshot().bytes, before, 'nada avança pausado');
  job.resume();
  const r = await running;
  assert.equal(r.counts.done, 3);
  assert.ok(calls.some((c) => c.range), 'usou Range para continuar');
  const z = readZip(file);
  for (const e of entries) assert.equal(z.files[e.path], await sha1(m.get(e.url)));
});

test('cancelar descarta o ZIP', async () => {
  const m = files(2, 3_000_000);
  const { fetchImpl } = fakeCdn(m, { chunkDelay: 2 });
  const file = path.join(tmp, 'cancel.zip');
  const job = new DownloadJob({ entries: entriesFor(m), target: new ZipTarget(nodeFileHandle(file)), fetchImpl, chunkSize: 64 * 1024 });
  const running = job.start();
  await new Promise((r) => setTimeout(r, 20));
  job.cancel();
  await assert.rejects(running, (e) => e.cancelled === true);
  assert.equal(job.phase, 'cancelled');
  assert.equal(fs.existsSync(file), false);
});

test('servidor que ignora Range: recomeça o arquivo e o conteúdo final continua certo', async () => {
  const m = files(1, 500_000);
  const { fetchImpl } = fakeCdn(m, { failOnce: new Map([[U(1), 120_000]]), ignoreRange: true });
  const file = path.join(tmp, 'norange.zip');
  const entries = entriesFor(m);
  const r = await new DownloadJob({ entries, target: new ZipTarget(nodeFileHandle(file)), fetchImpl, backoff: () => 1, chunkSize: 30_000 }).start();
  assert.equal(r.counts.done, 1);
  assert.equal(readZip(file).files[entries[0].path], await sha1(m.get(U(1))));
});

test('Pasta: grava organizado, pula o que já existe e o índice lista tudo o que está no disco', async () => {
  const m = files(3);
  const { fetchImpl, calls } = fakeCdn(m);
  const root = memoryDir();
  const entries = entriesFor(m);
  const r1 = await new DownloadJob({ entries: entries.slice(0, 2), target: new DirectoryTarget(root), fetchImpl }).start();
  assert.equal(r1.counts.done, 2);

  const before = calls.length;
  const r2 = await new DownloadJob({ entries, target: new DirectoryTarget(root), fetchImpl }).start();
  assert.equal(r2.counts.skipped, 2);
  assert.equal(r2.counts.done, 1);
  assert.equal(calls.length - before, 1, 'só baixou o que faltava');

  const aula = root.children.get('Aulas Uninter').children.get('Curso').children.get('Disciplina').children.get('Aula 01 - Teste');
  assert.deepEqual([...aula.children.keys()].sort(), entries.map((e) => e.path.split('/').pop()).sort());
  assert.deepEqual(aula.children.get('03 - Tema 3.mp4').data, m.get(U(3)));
  const html = new TextDecoder().decode(root.children.get('Aulas Uninter').children.get(INDEX_FILE).data);
  for (let i = 1; i <= 3; i++) assert.ok(html.includes(`0${i} - Tema ${i}.mp4`), `índice tem o tema ${i}`);
  const storage = root.children.get('Aulas Uninter').children.get('%storage%');
  assert.ok(storage.children.get('app').children.get('pdf.min.js').data.length > 100_000, 'leitor de PDF vai junto');
  assert.ok(storage.children.get('app').children.has('pdf.worker.min.js'));
});

test('Pasta: falha definitiva não deixa arquivo vazio para trás', async () => {
  const root = memoryDir();
  const { fetchImpl } = fakeCdn(new Map());
  const r = await new DownloadJob({ entries: [{ path: 'C/D/A/x.mp4', url: U(1), size: 10, kind: 'video', titulo: 'x' }], target: new DirectoryTarget(root), fetchImpl }).start();
  assert.equal(r.counts.failed, 1);
  const a = root.children.get('Aulas Uninter').children.get('C').children.get('D').children.get('A');
  assert.equal(a.children.has('x.mp4'), false);
  assert.ok(root.children.get('Aulas Uninter').children.has(REPORT_FILE));
});

test('ZIP: anexo de tamanho desconhecido que falha no meio não deixa lixo depois do fim (regressão)', async () => {
  const m = files(2, 300_000);
  // O 2º arquivo não tem tamanho conhecido (vai para o fim) e a conexão cai sempre depois de ~150 KB.
  const big = randomBytes(2_000_000, 9);
  m.set(U(3), big);
  const { fetchImpl: base } = fakeCdn(m);
  const fetchImpl = async (url, opts) => {
    const res = await base(url, opts);
    if (url !== U(3) || opts.method === 'HEAD') return res;
    const reader = res.body.getReader();
    let n = 0;
    const body = new ReadableStream({
      async pull(c) {
        const { done, value } = await reader.read();
        if (done) return c.close();
        n += value.length;
        if (n > 150_000) return c.error(new TypeError('Failed to fetch'));
        c.enqueue(value);
      },
    });
    return new Response(body, { status: res.status, headers: res.headers });
  };
  const entries = entriesFor(m);
  entries[2].size = null;
  const file = path.join(tmp, 'anexo-falhou.zip');
  const r = await new DownloadJob({ entries, target: new ZipTarget(nodeFileHandle(file)), fetchImpl, retries: 1, backoff: () => 1, chunkSize: 50_000 }).start();
  assert.equal(r.counts.failed, 1);
  const z = readZip(file);
  assert.equal(z.bad, null);
  assert.ok(REPORT_FILE in z.files);
});

test('cancelar durante a espera de nova tentativa termina na hora e não completa com zeros', async () => {
  const m = files(1, 5_000_000);
  const { fetchImpl: base } = fakeCdn(m, { chunkDelay: 2 });
  let calls = 0;
  const fetchImpl = async (url, opts) => {
    calls += 1;
    if (calls === 1) throw new TypeError('Failed to fetch');
    return base(url, opts);
  };
  const file = path.join(tmp, 'cancel-backoff.zip');
  const writes = [];
  const handle = nodeFileHandle(file);
  const wrapped = { async createWritable() { const w = await handle.createWritable(); return { ...w, write: (x) => (writes.push(x.data?.length || 0), w.write(x)) }; } };
  const job = new DownloadJob({ entries: entriesFor(m), target: new ZipTarget(wrapped), fetchImpl, backoff: () => 60_000 });
  const running = job.start();
  await new Promise((r) => setTimeout(r, 50));
  const t0 = Date.now();
  job.cancel();
  await assert.rejects(running, (e) => e.cancelled === true);
  assert.ok(Date.now() - t0 < 1000, 'cancelou sem esperar o backoff');
  assert.equal(writes.reduce((a, b) => a + b, 0), 0, 'nada de zeros gravados');
});

test('arquivo que mudou de tamanho no servidor falha na hora, sem 6 downloads inteiros', async () => {
  const m = files(1);
  const { fetchImpl, calls } = fakeCdn(m);
  const entries = entriesFor(m);
  entries[0].size += 1000; // tamanho antigo, guardado em cache
  const r = await new DownloadJob({ entries, target: new DirectoryTarget(memoryDir()), fetchImpl, backoff: () => 1 }).start();
  assert.equal(r.counts.failed, 1);
  assert.match(r.failed[0].error, /mudou no servidor/);
  assert.equal(calls.filter((c) => c.method === 'GET').length, 1);
});

test('retomada que recebe 416 com o arquivo já completo conta como concluído', async () => {
  const body = randomBytes(10_000, 3);
  let n = 0;
  const fetchImpl = async (url, opts) => {
    n += 1;
    if (opts.headers?.Range) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${body.length}` } });
    // 1ª tentativa: entrega tudo e depois "cai" antes de sinalizar o fim.
    let sent = false;
    return new Response(new ReadableStream({ pull(c) { if (!sent) { sent = true; c.enqueue(body); } else c.error(new TypeError('Failed to fetch')); } }), { status: 200, headers: { 'content-length': String(body.length) } });
  };
  const root = memoryDir();
  const r = await new DownloadJob({ entries: [{ path: 'C/D/A/x.mp4', url: U(1), size: body.length, kind: 'video', titulo: 'x' }], target: new DirectoryTarget(root), fetchImpl, backoff: () => 1, chunkSize: 1000 }).start();
  assert.equal(r.counts.done, 1);
  assert.equal(n, 2);
});
