// Converte catálogo + seleção + tipos de conteúdo na lista de arquivos a baixar,
// já com o caminho final organizado:
//
//   <Curso>/<Disciplina>/Aula 01 - <Título>/
//       00 - Aula completa.mp4
//       01 - Conversa Inicial.mp4
//       02 - Tema 1 – ....mp4
//       Áudio/01 - Conversa Inicial.mp3
//       Libras/01 - Conversa Inicial.mp4
//       Materiais/<arquivo>.pdf
//   <Curso>/<Disciplina>/Material complementar/...

import { audioUrlFor, librasUrlFor } from './catalog.js';
import { createUniquer, fold, pad, prettyCase, safeFileName, safeName, splitExt } from './naming.js';

export const DEFAULT_TYPES = Object.freeze({
  video: true,
  completo: false,
  audio: false,
  libras: false,
  materiais: true,
});

export function aulaFolderName(aula) {
  if (!aula.ordem && !aula.nome) return safeName(aula.rotulo);
  const head = `${aula.rotulo} ${pad(aula.ordem || 0)}`;
  return safeName(aula.nome ? `${head} - ${aula.nome}` : head, 100);
}

function extFromUrl(url, fallback) {
  try {
    const m = /\.([a-z0-9]{2,5})$/i.exec(new URL(url).pathname);
    return m ? m[1].toLowerCase() : fallback;
  } catch {
    return fallback;
  }
}

export function materialFileName(m) {
  const titulo = m.titulo || 'Arquivo';
  if (!m.nomeArquivo) return safeFileName(titulo, 'pdf');
  const [base, ext] = splitExt(m.nomeArquivo);
  const b = fold(base).replace(/[^a-z0-9]+/g, ' ').trim();
  const t = fold(titulo).replace(/[^a-z0-9]+/g, ' ').trim();
  const name = !t || b.includes(t) || t === 'arquivo' ? base : `${titulo} - ${base}`;
  return safeFileName(name, ext || 'pdf');
}

/** Grupos de conteúdo de uma disciplina: as aulas e, se existir, o material complementar. */
export function gruposDe(disc) {
  return disc.complementar ? [...disc.aulas, disc.complementar] : disc.aulas;
}

/** Todas as chaves selecionáveis (folhas) de um nó do catálogo. */
export function leafKeys(node) {
  if (node.disciplinas) return node.disciplinas.flatMap(leafKeys);
  if (node.aulas) return gruposDe(node).flatMap(leafKeys);
  return [...node.videos.map((v) => v.key), ...node.materiais.map((m) => m.key)];
}

/**
 * Nomes de pasta calculados sobre o catálogo inteiro (não sobre a seleção), para que o mesmo
 * conteúdo caia sempre no mesmo caminho — o modo Pasta depende disso para pular o que já existe.
 */
export function folderNames(catalog) {
  const dirs = new Map();
  const cursos = createUniquer();
  const seen = new Set();
  for (const curso of catalog.cursos) {
    let base = safeName(prettyCase(curso.nome), 80);
    if (seen.has(base.toLowerCase()) && curso.encerrado) base = safeName(`${base} (encerrado)`, 90);
    seen.add(base.toLowerCase());
    const cursoDir = cursos(base);
    dirs.set(curso.key, cursoDir);
    const discs = createUniquer();
    for (const disc of curso.disciplinas) {
      const discDir = discs(`${cursoDir}/${safeName(disc.nome, 80)}`);
      dirs.set(disc.key, discDir);
      const grupos = createUniquer();
      for (const g of gruposDe(disc)) dirs.set(g.key, grupos(`${discDir}/${aulaFolderName(g)}`));
    }
  }
  return dirs;
}

/**
 * @param catalog   resultado de loadCatalog
 * @param selected  Set com as chaves das folhas escolhidas (vídeos e materiais)
 * @param types     { video, completo, audio, libras, materiais }
 * @param libras    Map url→boolean (true = existe vídeo em Libras)
 * @param sizes     Map url→bytes
 */
export function buildPlan(catalog, { selected, types = DEFAULT_TYPES, libras = new Map(), sizes = new Map() }) {
  const entries = [];
  const unique = createUniquer();
  const index = [];
  const multiCurso = catalog.cursos.filter((c) => c.disciplinas.some((d) => leafKeys(d).some((k) => selected.has(k)))).length > 1;

  const add = (path, url, kind, meta) => {
    const finalPath = unique(path);
    const entry = { path: finalPath, url, kind, size: sizes.has(url) ? sizes.get(url) : null, ...meta };
    entries.push(entry);
    return entry;
  };

  const dirs = folderNames(catalog);
  for (const curso of catalog.cursos) {
    const cursoDir = dirs.get(curso.key);
    const cursoIndex = { nome: prettyCase(curso.nome), disciplinas: [] };

    for (const disc of curso.disciplinas) {
      const discDir = dirs.get(disc.key);
      const discIndex = { nome: disc.nome, grupos: [] };

      for (const grupo of gruposDe(disc)) {
        const videos = grupo.videos.filter((v) => selected.has(v.key));
        const materiais = types.materiais ? grupo.materiais.filter((m) => selected.has(m.key)) : [];
        if (!videos.length && !materiais.length) continue;

        const grupoLabel = grupo.nome ? `${grupo.rotulo} ${grupo.ordem} – ${grupo.nome}` : grupo.rotulo;
        const dir = dirs.get(grupo.key);
        const meta = { curso: cursoIndex.nome, disciplina: disc.nome, aula: grupoLabel };
        const grupoIndex = { nome: grupoLabel, dir, itens: [], links: grupo.links };

        if (types.completo && videos.length) {
          const varias = grupo.completos.length > 1;
          grupo.completos.forEach((c, i) => {
            const titulo = varias ? `Aula completa - ${c.titulo || i + 1}` : 'Aula completa';
            grupoIndex.itens.push(add(`${dir}/${safeFileName(`00 - ${titulo}`, extFromUrl(c.url, 'mp4'))}`, c.url, 'completo', { ...meta, titulo }));
          });
        }

        grupo.videos.forEach((v, i) => {
          if (!selected.has(v.key)) return;
          const n = pad(i + 1);
          const base = `${n} - ${v.titulo}`;
          const vmeta = { ...meta, titulo: v.titulo };
          if (types.video) grupoIndex.itens.push(add(`${dir}/${safeFileName(base, extFromUrl(v.url, 'mp4'))}`, v.url, 'video', vmeta));
          const a = types.audio ? audioUrlFor(v.url) : null;
          if (a) grupoIndex.itens.push(add(`${dir}/Áudio/${safeFileName(base, 'mp3')}`, a, 'audio', vmeta));
          const l = types.libras ? librasUrlFor(v.url) : null;
          if (l && libras.get(l) === true) grupoIndex.itens.push(add(`${dir}/Libras/${safeFileName(base, 'mp4')}`, l, 'libras', vmeta));
        });

        // No material complementar os arquivos ficam direto na pasta; nas aulas, em "Materiais/".
        const matDir = grupo.ordem ? `${dir}/Materiais` : dir;
        for (const m of materiais) {
          if (!m.url) continue;
          grupoIndex.itens.push(add(`${matDir}/${materialFileName(m)}`, m.url, 'material', { ...meta, titulo: m.titulo }));
        }
        if (grupoIndex.itens.length) discIndex.grupos.push(grupoIndex);
      }
      if (discIndex.grupos.length) cursoIndex.disciplinas.push(discIndex);
    }
    if (cursoIndex.disciplinas.length) index.push(cursoIndex);
  }

  const totalBytes = entries.reduce((sum, e) => sum + (e.size || 0), 0);
  const unknownSizes = entries.filter((e) => e.size == null).length;
  return { entries, index, totalBytes, unknownSizes, multiCurso };
}

/** Resumo para a barra inferior: contagem por tipo e tamanho estimado. */
export function summarize(plan) {
  const byKind = {};
  for (const e of plan.entries) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  const disciplinas = new Set(plan.entries.map((e) => `${e.curso}/${e.disciplina}`)).size;
  const aulas = new Set(plan.entries.map((e) => `${e.curso}/${e.disciplina}/${e.aula}`)).size;
  return { files: plan.entries.length, byKind, disciplinas, aulas, totalBytes: plan.totalBytes, unknownSizes: plan.unknownSizes };
}
