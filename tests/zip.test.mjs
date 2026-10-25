import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';
import { crc32 } from '../extension/app/lib/crc32.js';
import { ZipWriter } from '../extension/app/lib/zip.js';
import { randomBytes } from './helpers.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-zip-'));

function fileSink(file) {
  const fd = fs.openSync(file, 'w');
  return {
    sink: { write: async (pos, data) => void fs.writeSync(fd, data, 0, data.length, pos) },
    close: () => fs.closeSync(fd),
  };
}

/** Lê o ZIP com o zipfile do Python (valida CRC de cada arquivo) e devolve {nome: tamanho}. */
function pyRead(file) {
  const script = `
import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
print(json.dumps({"bad": bad, "files": {i.filename: i.file_size for i in z.infolist()}}))
`;
  return JSON.parse(execFileSync('python3', ['-I', '-c', script, file]).toString());
}

test('crc32 bate com o zlib em vários tamanhos e de forma incremental', () => {
  for (const n of [0, 1, 7, 8, 9, 63, 64, 1000, 65537]) {
    const b = randomBytes(n, n + 3);
    assert.equal(crc32(b), zlib.crc32(b), `n=${n}`);
    const half = Math.floor(n / 2);
    assert.equal(crc32(b.subarray(half), crc32(b.subarray(0, half))), zlib.crc32(b));
  }
});

for (const forceZip64 of [false, true]) {
  test(`ZIP com escrita paralela fora de ordem, anexos e nomes UTF-8 (zip64=${forceZip64})`, async () => {
    const file = path.join(tmp, `t-${forceZip64}.zip`);
    const { sink, close } = fileSink(file);
    const zip = new ZipWriter(sink, { forceZip64 });
    const a = randomBytes(300_000, 1);
    const b = randomBytes(123_457, 2);
    const c = new Uint8Array(0);
    const ea = zip.reserve('Filosofia/Aula 01 - Introdução/01 - Conversa Inicial.mp4', a.length);
    const eb = zip.reserve('Filosofia/Aula 01 - Introdução/Áudio/01 - Tema 1 – O que é.mp3', b.length);
    const ec = zip.reserve('vazio.txt', 0);
    // Intercala pedaços das duas entradas, como fazem downloads paralelos.
    const parts = (buf) => [buf.subarray(0, 70_000), buf.subarray(70_000, 200_000), buf.subarray(200_000)];
    const pa = parts(a);
    const pb = parts(b);
    for (let i = 0; i < 3; i++) {
      await zip.write(eb, pb[i]);
      await zip.write(ea, pa[i]);
    }
    await zip.close(eb);
    await zip.close(ea);
    await zip.close(ec);
    // Anexo de tamanho desconhecido, com um recomeço no meio.
    const t = zip.beginAppend('Materiais/Plano de ensino.pdf');
    await zip.write(t, randomBytes(5000, 9));
    zip.rewind(t);
    const pdf = randomBytes(9999, 4);
    await zip.write(t, pdf.subarray(0, 5000));
    await zip.write(t, pdf.subarray(5000));
    await zip.endAppend(t);
    await zip.appendBytes('Assistir aulas.html', new TextEncoder().encode('<h1>oi</h1>'));
    await zip.finish();
    close();

    const r = pyRead(file);
    assert.equal(r.bad, null);
    assert.deepEqual(r.files, {
      'Filosofia/Aula 01 - Introdução/01 - Conversa Inicial.mp4': a.length,
      'Filosofia/Aula 01 - Introdução/Áudio/01 - Tema 1 – O que é.mp3': b.length,
      'vazio.txt': c.length,
      'Materiais/Plano de ensino.pdf': pdf.length,
      'Assistir aulas.html': 11,
    });
    // Ferramenta independente (Info-ZIP) também precisa aceitar.
    execFileSync('unzip', ['-tq', file]);
    const out = path.join(tmp, `x-${forceZip64}`);
    // Extrai como o Utilitário de Arquivo do macOS (ditto) ou, fora do macOS, com o Python.
    if (process.platform === 'darwin') execFileSync('ditto', ['-x', '-k', file, out]);
    else execFileSync('python3', ['-I', '-c', 'import sys,zipfile;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', file, out]);
    assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(out, 'Filosofia/Aula 01 - Introdução/Áudio/01 - Tema 1 – O que é.mp3'))), b);
    assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(out, 'Materiais/Plano de ensino.pdf'))), pdf);
  });
}

test('entrada que falhou é completada com zeros e o ZIP continua íntegro', async () => {
  const file = path.join(tmp, 'falha.zip');
  const { sink, close } = fileSink(file);
  const zip = new ZipWriter(sink);
  const ok = randomBytes(1000, 5);
  const e1 = zip.reserve('falhou.mp4', 50_000);
  const e2 = zip.reserve('ok.mp4', ok.length);
  await zip.write(e1, randomBytes(1234, 6));
  await zip.write(e2, ok);
  await zip.close(e2);
  await zip.close(e1);
  assert.equal(e1.incomplete, true);
  await zip.finish();
  close();
  const r = pyRead(file);
  assert.equal(r.bad, null);
  assert.equal(r.files['falhou.mp4'], 50_000);
});

test('ZIP64 real: deslocamentos acima de 4 GB (arquivo esparso)', { skip: process.env.SKIP_BIG === '1' }, async () => {
  const file = path.join(tmp, 'grande.zip');
  const fd = fs.openSync(file, 'w');
  let maxEnd = 0;
  const sink = {
    write: async (pos, data) => {
      fs.writeSync(fd, data, 0, data.length, pos);
      maxEnd = Math.max(maxEnd, pos + data.length);
    },
  };
  const zip = new ZipWriter(sink);
  // Primeira entrada de 4,5 GB só de zeros: o CRC de zeros é calculado sem escrever os dados
  // (o sistema de arquivos completa o "buraco" com zeros).
  const big = zip.reserve('grande.bin', 4.5 * 1024 ** 3);
  const { crc32Zeros } = await import('../extension/app/lib/crc32.js');
  big.crc = crc32Zeros(big.size);
  big.written = big.size;
  await zip.close(big);
  const small = randomBytes(777, 8);
  const e = zip.reserve('depois-de-4GB.txt', small.length);
  assert.ok(e.offset > 0xffffffff);
  await zip.write(e, small);
  await zip.close(e);
  await zip.finish();
  fs.closeSync(fd);
  const script = `
import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
i = z.getinfo('depois-de-4GB.txt')
print(json.dumps({"names": z.namelist(), "offset": i.header_offset, "data": list(z.read('depois-de-4GB.txt')[:5])}))
`;
  const r = JSON.parse(execFileSync('python3', ['-I', '-c', script, file]).toString());
  assert.deepEqual(r.names, ['grande.bin', 'depois-de-4GB.txt']);
  assert.ok(r.offset > 0xffffffff);
  assert.deepEqual(r.data, Array.from(small.subarray(0, 5)));
  fs.rmSync(file);
});
