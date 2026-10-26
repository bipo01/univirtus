import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { INDEX_FILE, rebuildPlayerPage } from '../extension/app/lib/downloader.js';
import { buildOfflineIndex, loadPlayerAssets, playerData, readPlayerData } from '../extension/app/lib/offline-index.js';
import { memoryDir } from './helpers.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();

async function put(root, path, data) {
  const parts = path.split('/');
  let dir = root;
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
  const w = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
  await w.write(typeof data === 'string' ? enc.encode(data) : data);
  await w.close();
}
const read = (root, path) => path.split('/').reduce((d, p) => d.children.get(p), root);
// merge.js roda num contexto vm; o JSON traz o resultado para objetos deste contexto (deepEqual compara protótipos).
const merger = async () => {
  const m = vm.runInNewContext(`${(await loadPlayerAssets()).merge}\nAvaMerge`);
  return { mergeData: (a, b) => JSON.parse(JSON.stringify(m.mergeData(a, b))) };
};
const embedded = (html) => JSON.parse(/<script type="application\/json" id="ava-data">([\s\S]*?)<\/script>/.exec(html)[1]);

const AULA = 'Filosofia/Lógica/Aula 01 - Introdução';
const legacyPage = (links) => {
  const h = (p) => p.split('/').map(encodeURIComponent).join('/');
  const DATA = [
    {
      n: 'Filosofia',
      d: [
        {
          n: 'Lógica',
          g: [
            {
              n: 'Aula 01 – Introdução',
              i: [
                { t: 'Conversa', k: 'video', h: h(`${AULA}/01 - Conversa.mp4`) },
                { t: 'Aula prática', k: 'youtube', h: h(`${AULA}/YouTube - Aula prática.mp4`), u: 'https://www.youtube.com/watch?v=abc' },
              ],
              l: links,
            },
          ],
        },
      ],
    },
  ];
  return `<!doctype html><script>const DATA=${JSON.stringify(DATA).replace(/</g, '\\u003c')};const LBL={};</script>`;
};

test('player: o script embutido é JS válido e nunca fecha o <script> da página', async () => {
  const { js, css, merge, doc, files } = await loadPlayerAssets();
  assert.doesNotThrow(() => new vm.Script(`${merge}\n${doc}\n${js}`, { filename: 'player.js' }));
  assert.ok(!/<\/script/i.test(js + merge + doc) && !/<\/style/i.test(css));
  assert.deepEqual(files.map((f) => f.path).sort(), [
    '%storage%/LEIA-ME.txt',
    '%storage%/app/docx/docx-preview.min.js',
    '%storage%/app/docx/jszip.min.js',
    '%storage%/app/pdfjs/pdf.min.js',
    '%storage%/app/pdfjs/pdf.worker.min.js',
  ]);
});

test('player: dados embutidos com "</script>" no título não quebram a página', async () => {
  const index = [{ nome: 'C', disciplinas: [{ nome: 'D', grupos: [{ nome: 'A', dir: 'C/D/A', itens: [{ path: 'C/D/A/x.mp4', titulo: '</script><b>oi', kind: 'video' }], links: [] }] }] }];
  const html = buildOfflineIndex(index, { assets: await loadPlayerAssets() });
  assert.equal(embedded(html).cursos[0].d[0].g[0].i[0].t, '</script><b>oi');
  assert.equal(readPlayerData(html).links.size, 0);
});

test('Atualizar só a página: lê a pasta, mantém links/YouTube da página antiga e não toca nas anotações', async () => {
  const root = memoryDir();
  const base = await root.getDirectoryHandle('Aulas Uninter', { create: true });
  await put(base, `${AULA}/01 - Conversa.mp4`, new Uint8Array(10));
  await put(base, `${AULA}/00 - Aula completa.mp4`, new Uint8Array(10));
  await put(base, `${AULA}/YouTube - Aula prática.mp4`, new Uint8Array(10));
  await put(base, `${AULA}/Materiais/Slides.pdf`, new Uint8Array(10));
  await put(base, `${AULA}/Áudio/01 - Conversa.mp3`, new Uint8Array(10));
  await put(base, '%storage%/dados.json', '{"v":1,"items":{"x":{"done":true}}}');
  await put(base, INDEX_FILE, legacyPage([{ t: 'Artigo', h: 'https://example.com/a' }]));

  // Aceita a pasta de cima (onde "Aulas Uninter" está).
  const r = await rebuildPlayerPage(root);
  assert.equal(r.folder, 'Aulas Uninter');
  assert.equal(r.files, 5);
  assert.equal(r.handle, base, 'devolve a pasta para a extensão lembrar');
  assert.match(r.folderId, /^[\w-]{8,}$/);

  const html = dec.decode(read(base, INDEX_FILE).data);
  const data = embedded(html);
  assert.equal(data.cursos.length, 1, '%storage% não vira curso');
  const g = data.cursos[0].d[0].g[0];
  assert.deepEqual(g.l, [{ t: 'Artigo', h: 'https://example.com/a' }], 'link da página antiga mantido');
  assert.deepEqual(
    g.i.map((i) => [i.k, i.t]),
    [
      ['completo', 'Aula completa'],
      ['video', 'Conversa'],
      ['youtube', 'Aula prática'],
      ['audio', 'Conversa'],
      ['material', 'Slides'],
    ],
  );
  assert.equal(g.i.find((i) => i.k === 'youtube').u, 'https://www.youtube.com/watch?v=abc');
  assert.equal(dec.decode(read(base, '%storage%/dados.json').data), '{"v":1,"items":{"x":{"done":true}}}', 'dados do aluno intactos');
  assert.ok(read(base, '%storage%/app/pdfjs/pdf.min.js').data.length > 100_000);
  assert.equal(data.folderId, r.folderId);

  // Rodar de novo (agora sobre o formato novo) dá o mesmo resultado e mantém o id da pasta.
  const r2 = await rebuildPlayerPage(base);
  assert.equal(r2.folderId, r.folderId, 'mesmo id: a extensão continua reconhecendo a pasta');
  assert.deepEqual(embedded(dec.decode(read(base, INDEX_FILE).data)).cursos, data.cursos);
});

test('Atualizar só a página: recusa uma pasta que não é de aulas, sem gravar nada', async () => {
  const root = memoryDir('Downloads');
  await put(root, 'foto.jpg', new Uint8Array(3));
  await assert.rejects(rebuildPlayerPage(root), /não tem o arquivo/);
  assert.deepEqual([...root.children.keys()], ['foto.jpg']);
});

test('playerData: ordem dos itens e só o que existe', () => {
  const index = [
    {
      nome: 'C',
      disciplinas: [
        {
          nome: 'D',
          grupos: [
            {
              nome: 'A',
              itens: [
                { path: 'm.pdf', titulo: 'M', kind: 'material' },
                { path: 'v.mp4', titulo: 'V', kind: 'video' },
                { path: 'c.mp4', titulo: 'C', kind: 'completo' },
                { path: 'falhou.mp4', titulo: 'F', kind: 'video' },
              ],
              links: [],
            },
          ],
        },
      ],
    },
  ];
  const d = playerData(index, { isOk: (e) => e.path !== 'falhou.mp4' });
  assert.deepEqual(
    d.cursos[0].d[0].g[0].i.map((i) => i.p),
    ['c.mp4', 'v.mp4', 'm.pdf'],
  );
});

test('merge: "concluída" feita em outro lugar não some quando a posição é salva depois', async () => {
  const { mergeData } = await merger();
  const pc = { v: 1, items: { a: { done: true, doneAt: 10, dAt: 10, pos: 600, dur: 900, at: 10 } } };
  const outro = { v: 1, items: { a: { pos: 120, dur: 900, at: 50 } } }; // tocou depois, sem saber da marcação
  for (const m of [mergeData(pc, outro), mergeData(outro, pc)]) {
    assert.equal(m.items.a.done, true);
    assert.equal(m.items.a.pos, 120, 'posição mais nova');
  }
  // Desmarcar depois (dAt maior) vence.
  const desmarcou = { v: 1, items: { a: { done: false, dAt: 60, pos: 0, at: 60 } } };
  assert.equal(mergeData(pc, desmarcou).items.a.done, false);
  // "Desfazer" que volta a um registro sem done: o campo some de verdade.
  const desfez = { v: 1, items: { a: { pos: 600, at: 70, dAt: 70 } } };
  assert.ok(!('done' in mergeData(pc, desfez).items.a));
});

test('merge: aba antiga não apaga notas novas e lápides não ressuscitam', async () => {
  const { mergeData } = await merger();
  const antiga = { v: 1, items: {}, hl: { f: [{ id: 'h1', text: 'a', at: 1 }] }, notes: {} };
  const nova = { v: 1, items: {}, hl: { f: [{ id: 'h1', del: true, at: 5 }, { id: 'h2', text: 'b', at: 6 }] }, notes: { v: [{ id: 'n1', t: 3, text: 'x', at: 7 }] } };
  const m = mergeData(antiga, nova);
  assert.deepEqual(m.hl.f.map((x) => [x.id, Boolean(x.del)]).sort(), [['h1', true], ['h2', false]]);
  assert.equal(m.notes.v[0].text, 'x');
  assert.deepEqual(mergeData(nova, antiga).hl, m.hl, 'ordem dos argumentos não muda o resultado');
});

test('merge: mantém campos de versões futuras e o "last" mais recente', async () => {
  const { mergeData } = await merger();
  const m = mergeData({ v: 1, items: {}, hl: {}, notes: {}, last: { path: 'a', at: 1 } }, { v: 2, extra: { x: 1 }, items: {}, hl: {}, notes: {}, last: { path: 'b', at: 2 } });
  assert.equal(m.v, 2);
  assert.deepEqual(m.extra, { x: 1 });
  assert.equal(m.last.path, 'b');
});

test('leitor de .doc: texto com acentos, negrito, alinhamento e tabela', async () => {
  const { doc } = await loadPlayerAssets();
  const AvaDoc = vm.runInNewContext(`${doc}\nAvaDoc`, { TextDecoder });
  const { blocks } = JSON.parse(JSON.stringify(AvaDoc.parse(new Uint8Array(fs.readFileSync(new URL('./fixtures/doc/ficha.doc', import.meta.url))))));
  const text = (p) => p.runs.map((r) => r.text).join('');
  assert.equal(blocks[0].type, 'p');
  assert.equal(text(blocks[0]), 'FICHA DE FREQUÊNCIA');
  assert.equal(blocks[0].align, 'center');
  assert.ok(blocks[0].runs.every((r) => r.b), 'título em negrito');
  assert.equal(text(blocks[1]), 'Nome do aluno: Fulano de Tal — ação e reflexão.');
  assert.ok(blocks[1].runs.some((r) => r.i && r.text === 'Fulano de Tal'));
  const table = blocks.find((b) => b.type === 'table');
  assert.deepEqual(table.rows.map((row) => row.map((cell) => cell.map(text).join('/'))), [
    ['Data', 'Atividade', 'Horas'],
    ['01/03', 'Entrevista', '4'],
    ['02/03', '', '2'],
  ]);
  assert.throws(() => AvaDoc.parse(new Uint8Array(600)), /não é um \.doc/);
});

test('player: append/replaceChildren nunca recebem algo opcional (viraria o texto "null" na tela)', async () => {
  // Regressão: "13:22null" na dica da barra do vídeo e "null" solto abaixo do título da aula.
  const { js } = await loadPlayerAssets();
  const bad = [];
  const re = /\.(append|replaceChildren|prepend|replaceWith|before|after)\(/g;
  for (let m; (m = re.exec(js)); ) {
    // Lê os argumentos de primeiro nível da chamada (respeitando parênteses, colchetes e strings).
    let i = m.index + m[0].length;
    let depth = 0;
    let q = null;
    let arg = '';
    const args = [];
    for (; i < js.length; i++) {
      const c = js[i];
      if (q) {
        arg += c;
        if (c === '\\') arg += js[++i];
        else if (c === q) q = null;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') q = c;
      else if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) {
        if (depth === 0) break;
        depth--;
      } else if (c === ',' && depth === 0) {
        args.push(arg);
        arg = '';
        continue;
      }
      arg += c;
    }
    args.push(arg);
    const line = js.slice(0, m.index).split('\n').length;
    for (const a of args.map((x) => x.trim()).filter(Boolean)) {
      const top = a.replace(/\([^()]*\)/g, '()'); // ignora o que está dentro de chamadas aninhadas
      if (/:\s*(null|false|undefined)$/.test(a) || /&&/.test(top.replace(/\(.*\)/gs, ''))) bad.push(`player.js:${line} ${m[1]}(… ${a.slice(0, 60)} …)`);
    }
  }
  assert.deepEqual(bad, [], 'use add()/fill() para filhos opcionais');
});
