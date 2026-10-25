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
  youtube: true,
});



// Windows (Explorador, ZIP) não aceita caminhos com mais de 260 caracteres. Orçamento do caminho
// relativo: Curso/Disciplina/Aula ≤ 110 + subpasta (Áudio, Materiais…) ≤ 10 + arquivo ≤ 64 ≈ 190,
// sobrando ~70 para a pasta escolhida (ex.: C:\Users\Nome\Downloads\Aulas Uninter\).
export const LIMITS = Object.freeze({ curso: 36, disciplina: 44, pastas: 110, arquivo: 64, relativo: 190 });
const FILE_MAX = LIMITS.arquivo;

export function aulaFolderName(aula, max = 100) {
  if (!aula.ordem && !aula.nome) return safeName(aula.rotulo, max);
  const head = `${aula.rotulo} ${pad(aula.ordem || 0)}`;
  return safeName(aula.nome ? `${head} - ${aula.nome}` : head, Math.max(head.length, max));
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
  if (!m.nomeArquivo) return safeFileName(titulo, 'pdf', FILE_MAX);
  const [base, ext] = splitExt(m.nomeArquivo);
  const b = fold(base).replace(/[^a-z0-9]+/g, ' ').trim();
  const t = fold(titulo).replace(/[^a-z0-9]+/g, ' ').trim();
  const name = !t || b.includes(t) || t === 'arquivo' ? base : `${titulo} - ${base}`;
  return safeFileName(name, ext || 'pdf', FILE_MAX);
}

/**
 * Vídeos da Uninter: "por tema" (um arquivo por assunto) OU "aula completa" (um arquivo por aula),
 * que são o mesmo conteúdo. Aula sem versão completa usa os temas, para não ficar sem vídeo.
 */
export const usaTemas = (grupo, types) => Boolean(types.video || (types.completo && !grupo.completos.length));
export const usaCompleta = (grupo, types) => Boolean(types.completo && grupo.completos.length);

/** Grupos de conteúdo de uma disciplina: as aulas e, se existir, o material complementar. */
export function gruposDe(disc) {
  return disc.complementar ? [...disc.aulas, disc.complementar] : disc.aulas;
}

/** Todas as chaves selecionáveis (folhas) de um nó do catálogo. */
export function leafKeys(node) {
  if (node.disciplinas) return node.disciplinas.flatMap(leafKeys);
  if (node.aulas) return gruposDe(node).flatMap(leafKeys);
  return [...(node.completos || []).map((c) => c.key), ...node.videos.map((v) => v.key), ...node.materiais.map((m) => m.key), ...(node.externos || []).map((x) => x.key)];
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
    let base = safeName(prettyCase(curso.nome), LIMITS.curso);
    if (seen.has(base.toLowerCase()) && curso.encerrado) base = `${safeName(base, LIMITS.curso - 12)} (encerrado)`;
    seen.add(base.toLowerCase());
    const cursoDir = cursos(base);
    dirs.set(curso.key, cursoDir);
    const discs = createUniquer();
    for (const disc of curso.disciplinas) {
      const discDir = discs(`${cursoDir}/${safeName(disc.nome, LIMITS.disciplina)}`);
      dirs.set(disc.key, discDir);
      const grupos = createUniquer();
      // A aula fica com o que sobra do orçamento (no mínimo 30 caracteres).
      const aulaMax = Math.max(30, LIMITS.pastas - discDir.length - 1);
      for (const g of gruposDe(disc)) dirs.set(g.key, grupos(`${discDir}/${aulaFolderName(g, aulaMax)}`));
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
        const videos = usaTemas(grupo, types) ? grupo.videos.filter((v) => selected.has(v.key)) : [];
        const materiais = types.materiais ? grupo.materiais.filter((m) => selected.has(m.key)) : [];
        const ext = types.youtube ? (grupo.externos || []).filter((x) => selected.has(x.key)) : [];
        const completos = usaCompleta(grupo, types) ? grupo.completos.filter((c) => selected.has(c.key)) : [];
        if (!videos.length && !materiais.length && !ext.length && !completos.length) continue;

        const grupoLabel = grupo.nome ? `${grupo.rotulo} ${grupo.ordem} – ${grupo.nome}` : grupo.rotulo;
        const dir = dirs.get(grupo.key);
        const meta = { curso: cursoIndex.nome, disciplina: disc.nome, aula: grupoLabel };
        const grupoIndex = { nome: grupoLabel, dir, itens: [], links: grupo.links };

        // Vídeo + (opcional) MP3 e Libras do mesmo vídeo.
        const media = (url, base, kind, vmeta) => {
          grupoIndex.itens.push(add(`${dir}/${safeFileName(base, extFromUrl(url, 'mp4'), FILE_MAX)}`, url, kind, vmeta));
          const a = types.audio ? audioUrlFor(url) : null;
          if (a) grupoIndex.itens.push(add(`${dir}/Áudio/${safeFileName(base, 'mp3', FILE_MAX)}`, a, 'audio', vmeta));
          const l = types.libras ? librasUrlFor(url) : null;
          if (l && libras.get(l) === true) grupoIndex.itens.push(add(`${dir}/Libras/${safeFileName(base, 'mp4', FILE_MAX)}`, l, 'libras', vmeta));
        };

        const varias = grupo.completos.length > 1;
        grupo.completos.forEach((c, i) => {
          if (!completos.includes(c)) return;
          const titulo = varias ? `Aula completa - ${c.titulo || i + 1}` : 'Aula completa';
          media(c.url, `00 - ${titulo}`, 'completo', { ...meta, titulo });
        });

        grupo.videos.forEach((v, i) => {
          if (!videos.includes(v)) return;
          media(v.url, `${pad(i + 1)} - ${v.titulo}`, 'video', { ...meta, titulo: v.titulo });
        });

        // No material complementar os arquivos ficam direto na pasta; nas aulas, em "Materiais/".
        const matDir = grupo.ordem ? `${dir}/Materiais` : dir;
        for (const m of materiais) {
          if (!m.url) continue;
          grupoIndex.itens.push(add(`${matDir}/${materialFileName(m)}`, m.url, 'material', { ...meta, titulo: m.titulo }));
        }
        // YouTube: a extensão baixa e remonta num MP4 (youtube.js); o tamanho só se sabe no fim.
        for (const x of ext) {
          grupoIndex.itens.push(add(`${dir}/${safeFileName(`YouTube - ${x.titulo}`, 'mp4', FILE_MAX)}`, x.url, 'youtube', { ...meta, titulo: x.titulo, videoId: x.videoId }));
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
  return { files: plan.entries.length, youtube: byKind.youtube || 0, byKind, disciplinas, aulas, totalBytes: plan.totalBytes, unknownSizes: plan.unknownSizes };
}
