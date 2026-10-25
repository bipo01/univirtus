// Monta o catálogo (cursos → disciplinas → aulas → vídeos/materiais) a partir da API
// REST do AVA Univirtus. Toda chamada passa por `api(path, { form })`, que roda na aba
// do AVA (cookie de sessão + cabeçalho X-time) e devolve o JSON já interpretado.
//
// Fluxo verificado no AVA (out/2026):
//   sistema/Curso/0/EscolaUsuario/true/?emCurso=true|false           → cursos
//   ava/SalaVirtual/{idCurso}/CursoUsuarioPermissao/true/?...         → disciplinas (salas virtuais)
//   sistema/UsuarioSalaVirtualOferta/{idSala}/Atual                    → oferta atual do aluno
//   ava/SalaVirtualEstrutura/0/TipoOfertaCriptografado/{1|2}?...       → aulas (1) e material complementar (2)
//   ava/SalaVirtualAtividade/{idEstrutura}/EstruturaOferta/{idOferta}?buscarItemAprendizagem=true
//                                                                      → atividades + itens (rota, vídeo, arquivo, link)
//   POST repositorio/SistemaRepositorioRemoto/ url=<index.json da rota> → tópicos com URL do MP4
//   repositorio/SistemaRepositorio/{id}                                → nome original de um arquivo

import { pool } from './util.js';
import { youtubeVideoId } from './youtube.js';

const VOD_HOST = 'vod.grupouninter.com.br';
const AUD_HOST = 'aud.grupouninter.com.br';
const DAY = 864e5;

export const STATUS_LABEL = {
  andamento: 'Em andamento',
  anterior: 'Já cursadas',
  futura: 'Próximas',
  extra: 'Salas extras',
};

const qs = (params) => new URLSearchParams(params).toString();
const byOrdem = (a, b) => (Number(a?.ordem) || 0) - (Number(b?.ordem) || 0);

export function cleanTitle(value) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s || null;
}

/** Normaliza a URL de mídia; força HTTPS nos CDNs da Uninter (HTTP também responde, mas é mais lento). */
export function normalizeMediaUrl(value) {
  let s = String(value ?? '').trim();
  if (!s) return null;
  if (s.startsWith('//')) s = `https:${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.protocol === 'http:' && /(^|\.)grupouninter\.com\.br$|(^|\.)uninter\.com$/.test(u.hostname)) u.protocol = 'https:';
    return u.href;
  } catch {
    return null;
  }
}

export function isVod(url) {
  try {
    return new URL(url).hostname === VOD_HOST;
  } catch {
    return false;
  }
}

/** Mesma regra do AVA: o áudio fica em aud.grupouninter com o mesmo caminho em .mp3. */
export function audioUrlFor(url) {
  if (!isVod(url)) return null;
  const u = new URL(url);
  if (!/\.mp4$/i.test(u.pathname)) return null;
  u.hostname = AUD_HOST;
  u.pathname = u.pathname.replace(/\.mp4$/i, '.mp3');
  return u.href;
}

/** Mesma regra do AVA: o vídeo em Libras tem um "L" antes do nome do arquivo. Nem toda aula tem. */
export function librasUrlFor(url) {
  if (!isVod(url)) return null;
  const u = new URL(url);
  const parts = u.pathname.split('/');
  parts[parts.length - 1] = `L${parts[parts.length - 1]}`;
  u.pathname = parts.join('/');
  return u.href;
}

function isDirectVideo(url) {
  if (!url) return false;
  if (isVod(url)) return true;
  try {
    return /\.(mp4|m4v|webm|mov)$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** URL que o proxy do AVA usa para listar os vídeos de uma rota (replica downloadArquivosRota do AVA). */
export function rotaSourceUrl(link) {
  const clean = String(link ?? '').trim().replace(/&amp;/g, '&');
  if (!clean) return null;
  const [base] = clean.split('#');
  const novo = /\?c=([^&#]*)/.exec(base);
  if (novo) {
    let c = novo[1];
    try {
      c = decodeURIComponent(c);
    } catch {
      /* mantém como veio */
    }
    return `https://conteudosdigitais.uninter.com/materiais/aulas/${c}/index.json`;
  }
  if (base.includes('.php') || !base.includes('.html')) {
    return `${base}${base.includes('?') ? '&' : '?'}action=getvideos&value=all`;
  }
  return base;
}

/** Interpreta qualquer um dos formatos de rota que o AVA conhece. */
export function parseRota(data) {
  let obj = data;
  if (typeof data === 'string') {
    try {
      obj = JSON.parse(data);
    } catch {
      obj = null;
    }
  }
  const out = { videos: [], completo: null, disciplina: null, curso: null };
  const seen = new Set();
  const push = (url, titulo) => {
    const u = normalizeMediaUrl(url);
    if (!u || seen.has(u)) return;
    seen.add(u);
    out.videos.push({ url: u, titulo: cleanTitle(titulo) });
  };

  if (obj && typeof obj === 'object') {
    const midia = obj.aula?.midia;
    if (midia && typeof midia === 'object') {
      const list = Array.isArray(midia)
        ? midia
        : Object.keys(midia)
            .sort((a, b) => Number(a) - Number(b))
            .map((k) => midia[k]);
      for (const m of list) push(m?.url, m?.titulo);
    } else if (Array.isArray(obj.videos)) {
      for (const v of obj.videos) push(typeof v === 'string' ? v : v?.url, v?.titulo);
    }
    out.completo = normalizeMediaUrl(obj.video_completo);
    out.disciplina = cleanTitle(obj.disciplina);
    out.curso = cleanTitle(obj.curso);
    return separarAulaCompleta(out);
  }

  const text = typeof data === 'string' ? data : '';
  if (text.includes('resultvideos')) {
    text
      .split('\n')
      .slice(1)
      .forEach((line) => push(line.trim()));
  } else {
    const re = /<(?:video|source)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
    let m;
    while ((m = re.exec(text))) push(m[1]);
  }
  return separarAulaCompleta(out);
}

const PARTE = /-P\d+\.[a-z0-9]+$/i;
const AULA_INTEIRA = /-A\d+\.[a-z0-9]+$/i;

/** Rotas antigas listam "…-A02.mp4" (aula inteira) junto com "…-A02-P01.mp4" (partes): separa as duas coisas. */
function separarAulaCompleta(out) {
  if (out.completo || !out.videos.some((v) => PARTE.test(v.url))) return out;
  const inteiras = out.videos.filter((v) => !PARTE.test(v.url) && AULA_INTEIRA.test(v.url));
  if (inteiras.length === 1) {
    out.completo = inteiras[0].url;
    out.videos = out.videos.filter((v) => v !== inteiras[0]);
  }
  return out;
}

export function statusOf(sala, now = Date.now()) {
  const ini = Date.parse(sala.dataInicio);
  const fim = Date.parse(sala.dataFim);
  if (sala.ofertaFlexivel || (Number.isFinite(ini) && Number.isFinite(fim) && fim - ini > 400 * DAY)) return 'extra';
  if (sala.statusConcluido) return 'anterior';
  if (Number.isFinite(ini) && now < ini) return 'futura';
  if (Number.isFinite(fim) && now > fim + DAY) return 'anterior';
  return 'andamento';
}

function etiquetaLink(item) {
  const etqs = item?.itemAprendizagemEtiquetas || [];
  const hit = etqs.find((e) => e?.nomeTipoRecurso === 'link' && e.valorEtiqueta) || etqs.find((e) => /^\s*https?:\/\//i.test(e?.valorEtiqueta || ''));
  return hit ? String(hit.valorEtiqueta).trim() : null;
}

function etiquetaArquivo(item) {
  return (item?.itemAprendizagemEtiquetas || []).find((e) => e?.nomeTipoRecurso === 'repositorio' && e.valorEtiqueta) || null;
}

function errorText(err) {
  if (!err) return 'Erro desconhecido';
  if (err.status) return `O AVA respondeu ${err.status}`;
  return err.message || String(err);
}

/** Lê atividades/itens de uma estrutura e distribui em vídeos, materiais e links do "grupo". */
async function collectItems(api, atividades, grupo, keyPrefix) {
  const tasks = [];
  let vIndex = 0;
  for (const atv of [...atividades].sort(byOrdem)) {
    const nomeAtividade = cleanTitle(atv.nomeAtividade);
    for (const item of atv.atividadeItemAprendizagens || []) {
      const tipo = item?.itemAprendizagem?.classificacaoTipo || '';
      const link = etiquetaLink(item);
      const arquivo = etiquetaArquivo(item);
      const titulo = cleanTitle(item.nomeAtividade) || nomeAtividade;

      if (tipo === 'rota' && link) {
        // Reserva a posição para manter a ordem do roteiro mesmo resolvendo em paralelo.
        const slot = { rota: true, videos: [], completo: null, titulo };
        grupo.videos.push(slot);
        tasks.push(async () => {
          const source = rotaSourceUrl(link);
          try {
            const data = await api('repositorio/SistemaRepositorioRemoto/', { form: { url: source } });
            const parsed = parseRota(data);
            slot.videos = parsed.videos;
            slot.completo = parsed.completo;
            if (!parsed.videos.length && parsed.completo) {
              slot.videos = [{ url: parsed.completo, titulo: 'Aula completa' }];
              slot.completo = null;
            }
            if (!slot.videos.length) grupo.avisos.push(`A rota "${titulo || 'sem título'}" não tem vídeos para baixar.`);
          } catch (err) {
            if (err?.session) throw err;
            grupo.avisos.push(`Não foi possível ler a rota "${titulo || 'sem título'}" (${errorText(err)}).`);
          }
        });
      } else if (arquivo) {
        grupo.materiais.push({
          key: `${keyPrefix}:m:${arquivo.valorEtiqueta}:${grupo.materiais.length}`,
          repoId: String(arquivo.valorEtiqueta),
          url: arquivo.urlRecurso || null,
          titulo: titulo || 'Arquivo',
          nomeArquivo: null,
        });
      } else if (link) {
        const url = normalizeMediaUrl(link);
        if (url && isDirectVideo(url)) grupo.videos.push({ url, titulo: titulo || `Vídeo ${++vIndex}` });
        else if (url && youtubeVideoId(url)) grupo.externos.push({ url, videoId: youtubeVideoId(url), titulo: titulo || 'Vídeo do YouTube' });
        else if (url) grupo.links.push({ url, titulo: titulo || url });
      }
    }
  }
  await pool(tasks, 6, (t) => t());

  // Achata os slots de rota mantendo a ordem e remove vídeos repetidos. Vídeos sem título
  // (rotas antigas) recebem o nome da rota: "Filosofia Socrática – Parte 1".
  const flat = [];
  const completos = [];
  const seen = new Set();
  for (const v of grupo.videos) {
    const lista = v.rota ? v.videos : [v];
    lista.forEach((x, k) => {
      if (seen.has(x.url)) return;
      seen.add(x.url);
      const titulo = x.titulo || (v.rota && v.titulo ? (lista.length > 1 ? `${v.titulo} – Parte ${k + 1}` : v.titulo) : null);
      flat.push({ url: x.url, titulo });
    });
    if (v.rota && v.completo) completos.push({ url: v.completo, titulo: v.titulo });
  }
  grupo.videos = flat.map((v, i) => ({ ...v, key: `${keyPrefix}:v:${i}`, titulo: v.titulo || `Vídeo ${i + 1}` }));
  const vistos = new Set(seen);
  grupo.completos = completos.filter((c) => !vistos.has(c.url) && vistos.add(c.url));
  const ext = new Set();
  grupo.externos = grupo.externos.filter((x) => !ext.has(x.videoId) && ext.add(x.videoId)).map((x, i) => ({ ...x, key: `${keyPrefix}:y:${i}` }));
}

async function resolveNomesArquivos(api, materiais) {
  await pool(materiais, 6, async (m) => {
    try {
      const r = await api(`repositorio/SistemaRepositorio/${encodeURIComponent(m.repoId)}`);
      const repo = r?.sistemaRepositorio;
      if (repo?.nome) m.nomeArquivo = String(repo.nome).trim();
      if (!m.url && repo?.url) m.url = repo.url;
    } catch (err) {
      if (err?.session) throw err;
    }
  });
}

async function loadDisciplina(api, sala, now) {
  const disc = {
    key: `d:${sala.id}`,
    id: sala.id,
    nome: cleanTitle(sala.nome) || `Disciplina ${sala.id}`,
    codigo: sala.codigoOferta || null,
    status: statusOf(sala, now),
    dataInicio: sala.dataInicio || null,
    dataFim: sala.dataFim || null,
    aulas: [],
    complementar: null,
    error: null,
  };

  let oferta = null;
  try {
    oferta = (await api(`sistema/UsuarioSalaVirtualOferta/${sala.id}/Atual`))?.usuarioSalaVirtualOferta || null;
  } catch (err) {
    if (err?.session) throw err;
  }
  const idOferta = oferta?.idSalaVirtualOferta || sala.idSalaVirtualOfertaAtual;
  const aproveitamento = (oferta ? oferta.idSalaVirtualOfertaAproveitamento : sala.idSalaVirtualOfertaAproveitamento) ?? '';
  const pai = oferta?.idSalaVirtualOfertaPai ?? '';
  if (!idOferta || !sala.cId) {
    disc.error = 'Disciplina sem oferta disponível para você.';
    return disc;
  }

  let cId = sala.cId;
  try {
    cId = decodeURIComponent(sala.cId);
  } catch {
    /* já decodificado */
  }

  const estruturas = (tipo) =>
    api(
      `ava/SalaVirtualEstrutura/0/TipoOfertaCriptografado/${tipo}?${qs({
        id: cId,
        idSalaVirtualOferta: idOferta,
        idSalaVirtualOfertaAproveitamento: aproveitamento,
        idSalaVirtualOfertaPai: pai,
      })}`,
    ).then((r) => r?.salaVirtualEstruturas || []);

  const atividades = (estrutura) =>
    api(
      `ava/SalaVirtualAtividade/${estrutura.id}/EstruturaOferta/${idOferta}?${qs({
        idSalaVirtualOfertaPai: pai === '' ? 'null' : pai,
        idSalaVirtualOfertaAproveitamento: aproveitamento,
        buscarItemAprendizagem: true,
        ocultarAtividadeSemItem: true,
      })}`,
    ).then((r) => r?.salaVirtualAtividades || []);

  try {
    const [principais, complementares] = await Promise.all([
      estruturas(1),
      estruturas(2).catch((err) => {
        if (err?.session) throw err;
        return [];
      }),
    ]);

    disc.aulas = await pool([...principais].sort(byOrdem), 4, async (e, i) => {
      const aula = {
        key: `a:${e.id}`,
        id: e.id,
        ordem: Number(e.ordem) || i + 1,
        rotulo: cleanTitle(e.nomeSalaVirtualEstruturaRotulo) || 'Aula',
        nome: cleanTitle(e.nome),
        videos: [],
        materiais: [],
        links: [],
        completos: [],
        externos: [],
        avisos: [],
        error: null,
      };
      try {
        await collectItems(api, await atividades(e), aula, aula.key);
      } catch (err) {
        if (err?.session) throw err;
        aula.error = `Não foi possível ler esta aula (${errorText(err)}).`;
      }
      return aula;
    });

    if (complementares.length) {
      const extra = {
        key: `x:${disc.id}`,
        id: `x${disc.id}`,
        rotulo: 'Material complementar',
        nome: null,
        videos: [],
        materiais: [],
        links: [],
        completos: [],
        externos: [],
        avisos: [],
        error: null,
      };
      for (const e of complementares) {
        try {
          const parcial = { videos: [], materiais: [], links: [], completos: [], externos: [], avisos: [] };
          await collectItems(api, await atividades(e), parcial, `${extra.key}:${e.id}`);
          extra.videos.push(...parcial.videos);
          extra.materiais.push(...parcial.materiais);
          extra.links.push(...parcial.links);
          extra.completos.push(...parcial.completos);
          extra.externos.push(...parcial.externos);
          extra.avisos.push(...parcial.avisos);
        } catch (err) {
          if (err?.session) throw err;
          extra.error = `Parte do material complementar não pôde ser lida (${errorText(err)}).`;
        }
      }
      if (extra.videos.length || extra.materiais.length || extra.links.length || extra.externos.length) disc.complementar = extra;
    }

    const materiais = [...disc.aulas.flatMap((a) => a.materiais), ...(disc.complementar?.materiais || [])];
    await resolveNomesArquivos(api, materiais);
  } catch (err) {
    if (err?.session) throw err;
    disc.error = `Não foi possível ler esta disciplina (${errorText(err)}).`;
  }
  return disc;
}

/**
 * Lê tudo o que o aluno tem acesso. `onProgress({ done, total })` é chamado a cada disciplina.
 * Erros de sessão (401) interrompem a leitura; os demais ficam registrados na própria disciplina/aula.
 */
export async function loadCatalog(api, { onProgress = () => {}, now = Date.now() } = {}) {
  const ativos = await api('sistema/Curso/0/EscolaUsuario/true/?emCurso=true');
  let encerrados = null;
  try {
    encerrados = await api('sistema/Curso/0/EscolaUsuario/true/?emCurso=false');
  } catch (err) {
    if (err?.session) throw err;
  }

  const cursos = [];
  const seen = new Set();
  for (const [lista, encerrado] of [
    [ativos?.cursos, false],
    [encerrados?.cursos, true],
  ]) {
    for (const c of lista || []) {
      const id = c.idUsuarioCurso ?? c.id;
      if (id == null || seen.has(id)) continue;
      seen.add(id);
      cursos.push({
        key: `c:${id}`,
        idCurso: c.idCurso,
        idUsuarioCurso: c.idUsuarioCurso,
        nome: cleanTitle(c.nome) || 'Curso',
        nivel: cleanTitle(c.nomeCursoNivel),
        situacao: cleanTitle(c.nomeTipoSituacao),
        encerrado,
        disciplinas: [],
        error: null,
      });
    }
  }

  const pares = [];
  await Promise.all(
    cursos.map(async (curso) => {
      try {
        const r = await api(
          `ava/SalaVirtual/${curso.idCurso}/CursoUsuarioPermissao/true/?${qs({
            emCurso: !curso.encerrado,
            idUsuarioCurso: curso.idUsuarioCurso,
          })}`,
        );
        for (const sala of r?.salaVirtuais || []) pares.push({ curso, sala });
      } catch (err) {
        if (err?.session) throw err;
        curso.error = `Não foi possível listar as disciplinas (${errorText(err)}).`;
      }
    }),
  );

  let done = 0;
  onProgress({ done, total: pares.length });
  const disciplinas = await pool(pares, 4, async ({ curso, sala }) => {
    const disc = await loadDisciplina(api, sala, now);
    // Num curso encerrado nada está "em andamento", mesmo que as datas da sala digam o contrário.
    if (curso.encerrado && (disc.status === 'andamento' || disc.status === 'futura')) disc.status = 'anterior';
    done += 1;
    onProgress({ done, total: pares.length, disciplina: disc.nome });
    return disc;
  });
  pares.forEach(({ curso }, i) => curso.disciplinas.push(disciplinas[i]));

  const ordemStatus = { andamento: 0, futura: 1, anterior: 2, extra: 3 };
  for (const curso of cursos) {
    curso.disciplinas.sort(
      (a, b) => ordemStatus[a.status] - ordemStatus[b.status] || a.nome.localeCompare(b.nome, 'pt-BR'),
    );
  }
  return { cursos, carregadoEm: new Date(now).toISOString() };
}
