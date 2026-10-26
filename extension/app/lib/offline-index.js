// Gera "Assistir aulas.html": uma página offline, sem internet, que lista tudo o que foi
// baixado e toca os vídeos/áudios direto da pasta (abre com duplo clique no navegador).
//
// O player (interface, leitor de PDF com destaques e notas, progresso) fica em app/player/ e é
// embutido na página. O pdf.js vai para "%storage%/app/" e só carrega ao abrir um PDF. O progresso,
// os destaques e as notas que o aluno faz ficam em "%storage%/dados.json", na própria pasta.

export const STORAGE_DIR = '%storage%';
export const DATA_FILE = `${STORAGE_DIR}/dados.json`;

export const relHref = (path) => path.split('/').map(encodeURIComponent).join('/');

const KIND_ORDER = { completo: 0, video: 1, youtube: 2, libras: 3, audio: 4, material: 5 };
const byKind = (a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9);

const STORAGE_README = [
  'Esta pasta guarda o seu progresso, os destaques e as notas da página "Assistir aulas.html".',
  '',
  '- dados.json: aulas concluídas, onde você parou, destaques e notas (não apague).',
  '- Minhas anotações.md: cópia das suas notas e destaques para ler em qualquer editor.',
  '- app/: leitores de PDF e Word usados pela página (funcionam sem internet).',
  '',
  'Se mover a pasta das aulas para outro lugar ou outro computador, leve esta pasta junto.',
  '',
].join('\r\n');

/** Dados que vão embutidos na página: só o que existe de fato na pasta/ZIP. */
export function playerData(index, { isOk = () => true, geradoEm = new Date(), ext = null, folderId = null } = {}) {
  const cursos = index
    .map((curso) => ({
      n: curso.nome,
      d: curso.disciplinas
        .map((disc) => ({
          n: disc.nome,
          g: disc.grupos
            .map((g) => ({
              n: g.nome,
              ...(g.dir ? { dir: g.dir } : {}),
              i: g.itens
                .filter(isOk)
                .sort(byKind)
                .map((e) => ({ t: e.titulo, k: e.kind, p: e.path, ...(e.url && e.kind === 'youtube' ? { u: e.url } : {}) })),
              l: (g.links || []).map((l) => ({ t: l.titulo, h: l.url })),
            }))
            .filter((g) => g.i.length || g.l.length),
        }))
        .filter((d) => d.g.length),
    }))
    .filter((c) => c.d.length);
  // ext + folderId: com a extensão instalada, a página abre por ela (que já tem acesso à pasta).
  return { v: 2, geradoEm: geradoEm.toISOString(), storage: STORAGE_DIR, ...(folderId ? { folderId } : {}), ...(ext ? { ext } : {}), cursos };
}

/**
 * @param index   plan.index (ou scanTree)
 * @param isOk    (entry) => boolean — só lista o que realmente está na pasta/ZIP
 * @param assets  loadPlayerAssets()
 */
export function buildOfflineIndex(index, { isOk = () => true, geradoEm = new Date(), assets, ext = null, folderId = null } = {}) {
  if (!assets?.js || !assets?.css || !assets?.merge || !assets?.doc) throw new Error('buildOfflineIndex: faltam os arquivos do player (loadPlayerAssets)');
  // Todo "<" vira o escape unicode: o JSON nunca fecha o <script> antes da hora.
  const json = JSON.stringify(playerData(index, { isOk, geradoEm, ext, folderId })).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Minhas aulas</title>
<script>try{var t=localStorage.getItem('ava-theme');if(t==='dark'||t==='light')document.documentElement.dataset.theme=t}catch(e){}</script>
<style>
${assets.css}
</style>
</head>
<body>
<div id="app" aria-busy="true"></div>
<noscript><p style="padding:24px">Ative o JavaScript para ver as aulas.</p></noscript>
<script type="application/json" id="ava-data">${json}</script>
<script>
${assets.merge}
${assets.doc}
${assets.js}
</script>
</body>
</html>
`;
}

/** Lê os dados embutidos numa página gerada antes (formato novo ou o antigo), para não perder links e URLs do YouTube. */
export function readPlayerData(html) {
  const out = { links: new Map(), urls: new Map(), folderId: null };
  let cursos = null;
  let legacy = false;
  const now = /<script type="application\/json" id="ava-data">([\s\S]*?)<\/script>/.exec(html);
  try {
    if (now) {
      const d = JSON.parse(now[1]);
      cursos = d.cursos;
      out.folderId = typeof d.folderId === 'string' ? d.folderId : null;
    }
    else {
      const old = /const DATA=(\[[\s\S]*?\]);const LBL=/.exec(html);
      if (old) {
        cursos = JSON.parse(old[1]);
        legacy = true;
      }
    }
  } catch {
    return out;
  }
  if (!Array.isArray(cursos)) return out;
  const decode = (h) => {
    try {
      return h.split('/').map(decodeURIComponent).join('/');
    } catch {
      return null;
    }
  };
  for (const c of cursos)
    for (const d of c.d || [])
      for (const g of d.g || []) {
        const paths = (g.i || []).map((it) => (legacy ? decode(it.h || '') : it.p)).filter(Boolean);
        (g.i || []).forEach((it) => {
          const p = legacy ? decode(it.h || '') : it.p;
          if (p && it.u) out.urls.set(p, it.u);
        });
        // A pasta da aula: a gravada, ou a do primeiro arquivo (sem a subpasta Materiais/Áudio/Libras).
        let dir = g.dir;
        if (!dir && paths.length) dir = paths[0].split('/').slice(0, 3).join('/');
        if (!dir) dir = `${c.n}/${d.n}/${g.n}`;
        if (g.l?.length) out.links.set(dir, g.l.map((l) => ({ titulo: l.t, url: l.h })));
      }
  return out;
}

const PLAYER_SOURCES = {
  css: '../player/player.css',
  merge: '../player/merge.js',
  doc: '../player/doc-reader.js',
  js: '../player/player.js',
};
// Bibliotecas copiadas para %storage%/app/ com o mesmo caminho de extension/vendor/ (o player usa os dois).
export const VENDOR_FILES = ['pdfjs/pdf.min.js', 'pdfjs/pdf.worker.min.js', 'docx/jszip.min.js', 'docx/docx-preview.min.js'];

let assetsPromise = null;

/** Carrega o player e o pdf.js (na extensão via fetch; nos testes, do disco). */
export function loadPlayerAssets() {
  assetsPromise ??= (async () => {
    const read = async (rel) => {
      const url = new URL(rel, import.meta.url);
      if (url.protocol === 'file:') {
        const fs = await import('node:fs/promises');
        return new Uint8Array(await fs.readFile(url));
      }
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Não consegui ler ${rel} (${r.status})`);
      return new Uint8Array(await r.arrayBuffer());
    };
    const [css, merge, doc, js, ...vendor] = await Promise.all([...Object.values(PLAYER_SOURCES), ...VENDOR_FILES.map((f) => `../../vendor/${f}`)].map(read));
    const dec = new TextDecoder();
    return {
      css: dec.decode(css),
      merge: dec.decode(merge),
      doc: dec.decode(doc),
      js: dec.decode(js),
      files: [
        ...VENDOR_FILES.map((f, i) => ({ path: `${STORAGE_DIR}/app/${f}`, bytes: vendor[i] })),
        { path: `${STORAGE_DIR}/LEIA-ME.txt`, bytes: new TextEncoder().encode(STORAGE_README) },
      ],
    };
  })().catch((err) => {
    assetsPromise = null;
    throw err;
  });
  return assetsPromise;
}
