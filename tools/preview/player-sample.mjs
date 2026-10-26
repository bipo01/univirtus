// Monta uma pasta de aulas FICTÍCIA para testar a página "Assistir aulas.html" (player offline):
//   node tools/preview/player-sample.mjs [destino]
// Padrão: tools/preview/out/player-sample/Aulas Uninter. Abra o "Assistir aulas.html" de lá no Chrome.
// Vídeos de 4 s (remontados das fixtures do YouTube), PDFs com texto, um .doc (fixture) e um .docx
// (gerado pelo textutil do macOS, se existir). AVA_EXT_ID=<id> grava o id da extensão na página (redireciona).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAdts } from '../../extension/app/lib/media/adts.js';
import { Mp4Muxer } from '../../extension/app/lib/media/mp4.js';
import { TsVideoDemuxer } from '../../extension/app/lib/media/ts.js';
import { rebuildPlayerPage, INDEX_FILE } from '../../extension/app/lib/downloader.js';

if (process.env.AVA_EXT_ID) globalThis.chrome = { runtime: { id: process.env.AVA_EXT_ID } };
const here = path.dirname(fileURLToPath(import.meta.url));
const base = path.resolve(process.argv[2] || path.join(here, 'out/player-sample/Aulas Uninter'));
const FIX = path.join(here, '../../tests/fixtures/hls');

/** FileSystemDirectoryHandle mínimo em cima do disco (o mesmo subconjunto que a extensão usa). */
export function nodeDir(dir) {
  const name = path.basename(dir);
  return {
    kind: 'directory',
    name,
    async getDirectoryHandle(n, { create = false } = {}) {
      const p = path.join(dir, n);
      if (!fs.existsSync(p)) {
        if (!create) throw Object.assign(new Error('nf'), { name: 'NotFoundError' });
        fs.mkdirSync(p);
      }
      if (!fs.statSync(p).isDirectory()) throw Object.assign(new Error('tm'), { name: 'TypeMismatchError' });
      return nodeDir(p);
    },
    async getFileHandle(n, { create = false } = {}) {
      const p = path.join(dir, n);
      if (!fs.existsSync(p)) {
        if (!create) throw Object.assign(new Error('nf'), { name: 'NotFoundError' });
        fs.writeFileSync(p, '');
      }
      return nodeFile(p);
    },
    async removeEntry(n) {
      fs.rmSync(path.join(dir, n), { recursive: true });
    },
    async *entries() {
      for (const n of fs.readdirSync(dir)) {
        const p = path.join(dir, n);
        yield [n, fs.statSync(p).isDirectory() ? nodeDir(p) : nodeFile(p)];
      }
    },
  };
}
function nodeFile(p) {
  return {
    kind: 'file',
    name: path.basename(p),
    async getFile() {
      const buf = fs.readFileSync(p);
      return { size: buf.length, text: async () => buf.toString('utf8'), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) };
    },
    async createWritable() {
      const chunks = [];
      return {
        async write(d) {
          chunks.push(typeof d === 'string' ? Buffer.from(d) : Buffer.from(d));
        },
        async close() {
          fs.writeFileSync(p, Buffer.concat(chunks));
        },
        async abort() {},
      };
    },
  };
}

/** PDF simples com texto selecionável (Helvetica, WinAnsi). */
function makePdf(title, pages) {
  const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const objs = [];
  const add = (s) => objs.push(s) && objs.length;
  const catalog = add('');
  const pagesId = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const bold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids = [];
  pages.forEach((lines, i) => {
    let y = 760;
    let ops = `BT /F2 20 Tf 60 ${y} Td (${esc(i === 0 ? title : `${title} — página ${i + 1}`)}) Tj ET\n`;
    y -= 40;
    for (const l of lines) {
      ops += `BT /F1 12 Tf 60 ${y} Td (${esc(l)}) Tj ET\n`;
      y -= 20;
    }
    ops += `BT /F1 9 Tf 290 40 Td (${i + 1}) Tj ET\n`;
    const body = Buffer.from(ops, 'latin1');
    const content = add(`<< /Length ${body.length} >>\nstream\n${body.toString('latin1')}endstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R /F2 ${bold} 0 R >> >> /Contents ${content} 0 R >>`));
  });
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

async function makeMp4() {
  const read = (f) => new Uint8Array(fs.readFileSync(path.join(FIX, f)));
  const demux = new TsVideoDemuxer();
  const out = [];
  const mux = new Mp4Muxer({ write: async (pos, data) => out.push({ pos, data: data.slice() }) }, { width: 320, height: 180 });
  await mux.start();
  for (let i = 0; i < 3; i++) {
    if (fs.existsSync(path.join(FIX, `v${i}.ts`))) {
      const frames = demux.push(read(`v${i}.ts`));
      await mux.addVideo(frames, { sps: demux.sps, pps: demux.pps });
    }
    const { config, frames } = parseAdts(read(`a${i}.aac`));
    if (config) await mux.addAudio(frames, config);
  }
  const size = await mux.finish();
  const buf = Buffer.alloc(size);
  for (const w of out) buf.set(w.data, w.pos);
  return buf;
}

/** .docx de verdade pelo textutil (macOS); em outros sistemas, um arquivo inválido (a prévia mostra o erro). */
function makeDocx() {
  const html = `<html><head><meta charset="utf-8"></head><body><h1 style="text-align:center">Roteiro de estudos</h1><p><b>Objetivo:</b> ler os textos da aula e responder às questões.</p><ol><li>Leia o texto base.</li><li>Assista à aula completa.</li><li>Faça as anotações no leitor.</li></ol><table border="1"><tr><th>Semana</th><th>Atividade</th></tr><tr><td>1</td><td>Leitura</td></tr><tr><td>2</td><td>Fórum</td></tr></table></body></html>`;
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-docx-'));
    fs.writeFileSync(path.join(dir, 'r.html'), html);
    execFileSync('textutil', ['-convert', 'docx', path.join(dir, 'r.html'), '-output', path.join(dir, 'r.docx')]);
    return fs.readFileSync(path.join(dir, 'r.docx'));
  } catch {
    return Buffer.from('PK fictício');
  }
}

const LOREM = [
  'A filosofia da religião investiga os conceitos centrais das tradições religiosas,',
  'como Deus, fé, revelação, milagre e sentido da vida, com as ferramentas da razão.',
  'Ela não pressupõe a verdade de nenhuma crença: examina argumentos a favor e contra.',
  'Entre os temas clássicos estão o argumento ontológico, o cosmológico e o teleológico,',
  'o problema do mal, a relação entre fé e razão e a linguagem religiosa.',
  'Wittgenstein propôs a filosofia como uma espécie de "cura" para confusões conceituais.',
  'Ao ler, destaque os trechos que parecerem centrais e anote suas dúvidas na margem.',
];

const mp4 = await makeMp4();
fs.rmSync(base, { recursive: true, force: true });
const put = (rel, data) => {
  const p = path.join(base, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
};
const C = 'Bacharelado em Filosofia';
const D1 = `${C}/Filosofia da Religião`;
const D2 = `${C}/Produção Textual`;
put(`${D1}/Aula 01 - Introdução/00 - Aula completa.mp4`, mp4);
put(`${D1}/Aula 01 - Introdução/01 - Conversa Inicial.mp4`, mp4);
put(`${D1}/Aula 01 - Introdução/02 - Tema 1 – O que é filosofia.mp4`, mp4);
put(`${D1}/Aula 01 - Introdução/03 - Tema 2 – O que é religião.mp4`, mp4);
put(`${D1}/Aula 01 - Introdução/Áudio/01 - Conversa Inicial.m4a`, mp4);
put(`${D1}/Aula 01 - Introdução/Materiais/Slides da aula 1.pdf`, makePdf('Slides da aula 1', Array.from({ length: 7 }, () => LOREM)));
put(`${D1}/Aula 01 - Introdução/Materiais/Ficha de frequência.doc`, fs.readFileSync(path.join(here, '../../tests/fixtures/doc/ficha.doc')));
put(`${D1}/Aula 01 - Introdução/Materiais/Roteiro de estudos.docx`, makeDocx());
put(`${D1}/Aula 01 - Introdução/Materiais/Mapa conceitual.pptx`, Buffer.from('PK fictício'));
put(`${D1}/Aula 02 - Argumentos clássicos/00 - Aula completa.mp4`, mp4);
put(`${D1}/Aula 02 - Argumentos clássicos/Materiais/Texto base.pdf`, makePdf('Texto base', Array.from({ length: 12 }, () => LOREM)));
put(`${D1}/Material complementar/Plano de ensino - FILOSOFIA DA RELIGIAO.pdf`, makePdf('Plano de ensino', [LOREM, LOREM]));
put(`${D2}/Aula 01 - A argumentação/00 - Aula completa.mp4`, mp4);
put(`${D2}/Aula 01 - A argumentação/Materiais/A estrutura do texto.pdf`, makePdf('A estrutura do texto', [LOREM, LOREM, LOREM]));
put(`${D2}/Aula 02 - Coesão/00 - Aula completa.mp4`, mp4);
// Página no formato antigo, com um link: a atualização tem de mantê-lo.
const old = [{ n: C, d: [{ n: 'Filosofia da Religião', g: [{ n: 'Aula 01 - Introdução', i: [{ t: 'Conversa Inicial', k: 'video', h: `${D1}/Aula 01 - Introdução/01 - Conversa Inicial.mp4`.split('/').map(encodeURIComponent).join('/') }], l: [{ t: 'Leitura extra (site)', h: 'https://example.com/' }] }] }] }];
put(INDEX_FILE, `<script>const DATA=${JSON.stringify(old)};const LBL={};</script>`);

const r = await rebuildPlayerPage(nodeDir(base));
console.log(`${r.files} arquivos · pasta ${r.folderId} · ${path.join(base, INDEX_FILE)}`);
