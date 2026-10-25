import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioUrlFor, librasUrlFor, loadCatalog, parseRota, rotaSourceUrl, statusOf } from '../extension/app/lib/catalog.js';
import { buildPlan, DEFAULT_TYPES, leafKeys, materialFileName } from '../extension/app/lib/plan.js';
import { createUniquer, prettyCase, safeName } from '../extension/app/lib/naming.js';
import { buildOfflineIndex } from '../extension/app/lib/offline-index.js';

const NOW = Date.parse('2026-10-25T12:00:00Z');

// Fixture no mesmo formato das respostas reais do AVA (dados fictícios).
function fakeApi({ failRota = false, session = false, withClosed = false } = {}) {
  const calls = [];
  const rota = (n) => ({
    curso: 'FILOSOFIA - BACHARELADO',
    disciplina: 'FILOSOFIA DA RELIGIÃO',
    video_completo: `http://vod.grupouninter.com.br/2021/SET/X-A0${n}.mp4`,
    aula: {
      num_aula: String(n),
      midia: {
        1: { titulo: 'Conversa Inicial', url: `http://vod.grupouninter.com.br/2021/SET/X-A0${n}-P01.mp4` },
        2: { titulo: 'Tema 1 – O que é filosofia?', url: `http://vod.grupouninter.com.br/2021/SET/X-A0${n}-P02.mp4` },
        3: { titulo: 'Finalizando', url: `http://vod.grupouninter.com.br/2021/SET/X-A0${n}-P03.mp4` },
      },
    },
  });
  const item = (tipo, etiquetas, nome = null) => ({ nomeAtividade: nome, itemAprendizagem: { classificacaoTipo: tipo }, itemAprendizagemEtiquetas: etiquetas });
  const api = async (path, opts = {}) => {
    calls.push(path);
    if (session) throw Object.assign(new Error('401'), { status: 401, session: true });
    if (path.startsWith('sistema/Curso/0/EscolaUsuario/true/?emCurso=true'))
      return { cursos: [{ idCurso: 10, idUsuarioCurso: 99, nome: 'BACHARELADO EM FILOSOFIA', nomeCursoNivel: 'GRADUAÇÃO', nomeTipoSituacao: 'ATIVO' }] };
    if (path.startsWith('sistema/Curso/0/EscolaUsuario/true/?emCurso=false')) return { cursos: withClosed ? [{ idCurso: 30, idUsuarioCurso: 98, nome: 'PROGRAMA CHAVE', nomeTipoSituacao: 'CONCLUINTE' }] : [] };
    if (path.startsWith('ava/SalaVirtual/30/CursoUsuarioPermissao')) return { salaVirtuais: [{ id: 3, cId: 'qqq', nome: 'Programa Chave', dataInicio: '2026-08-01T00:00:00', dataFim: '2026-12-01T00:00:00', idSalaVirtualOfertaAtual: 650 }] };
    if (path.startsWith('ava/SalaVirtual/10/CursoUsuarioPermissao'))
      return {
        salaVirtuais: [
          { id: 1, cId: 'abc%2Fdef%3D%3D', nome: 'Filosofia da Religião', codigoOferta: 917190, dataInicio: '2026-08-31T00:00:00', dataFim: '2026-11-08T00:00:00', idSalaVirtualOfertaAtual: 500, idSalaVirtualOfertaAproveitamento: 700 },
          { id: 2, cId: 'zzz', nome: 'Produção Textual', dataInicio: '2026-06-22T00:00:00', dataFim: '2026-08-30T00:00:00', idSalaVirtualOfertaAtual: 600 },
        ],
      };
    if (path === 'sistema/UsuarioSalaVirtualOferta/1/Atual') return { usuarioSalaVirtualOferta: { idSalaVirtualOferta: 500, idSalaVirtualOfertaAproveitamento: 700, idSalaVirtualOfertaPai: null } };
    if (path === 'sistema/UsuarioSalaVirtualOferta/2/Atual') return { usuarioSalaVirtualOferta: { idSalaVirtualOferta: 600, idSalaVirtualOfertaAproveitamento: null } };
    if (path.startsWith('ava/SalaVirtualEstrutura/0/TipoOfertaCriptografado/1?')) {
      const q = new URLSearchParams(path.split('?')[1]);
      if (q.get('id') === 'abc/def==')
        return {
          salaVirtualEstruturas: [
            { id: 12, ordem: 2, nome: 'Aspectos antigos', nomeSalaVirtualEstruturaRotulo: 'Aula' },
            { id: 11, ordem: 1, nome: 'Introdução à Filosofia da Religião', nomeSalaVirtualEstruturaRotulo: 'Aula' },
          ],
        };
      return { salaVirtualEstruturas: [{ id: 21, ordem: 1, nome: 'A argumentação', nomeSalaVirtualEstruturaRotulo: 'Aula' }] };
    }
    if (path.startsWith('ava/SalaVirtualEstrutura/0/TipoOfertaCriptografado/2?')) {
      const q = new URLSearchParams(path.split('?')[1]);
      return q.get('id') === 'abc/def==' ? { salaVirtualEstruturas: [{ id: 19, nome: null, nomeSalaVirtualEstruturaRotulo: 'Material Complementar' }] } : { salaVirtualEstruturas: [] };
    }
    const m = /^ava\/SalaVirtualAtividade\/(\d+)\/EstruturaOferta\//.exec(path);
    if (m) {
      const id = Number(m[1]);
      if (id === 11 || id === 12)
        return {
          salaVirtualAtividades: [
            { ordem: 1, nomeAtividade: 'Rota', atividadeItemAprendizagens: [item('rota', [{ nomeTipoRecurso: 'link', valorEtiqueta: `https://conteudosdigitais.uninter.com/libraries/newrota/?c=/gradNova/2021/filosofia/rel/a${id - 10}&amp;hash=x` }])] },
          ],
        };
      if (id === 19)
        return {
          salaVirtualAtividades: [{ ordem: 1, nomeAtividade: 'Plano de ensino', atividadeItemAprendizagens: [item('arquivo', [{ nomeTipoRecurso: 'repositorio', valorEtiqueta: '777', urlRecurso: 'https://univirtus.uninter.com/ava/repositorio/SistemaRepositorioPublico?id=a' }])] }],
        };
      if (id === 21)
        return {
          salaVirtualAtividades: [
            { ordem: 2, nomeAtividade: 'Aula 1 - com legenda', atividadeItemAprendizagens: [item('video', [{ nomeTipoRecurso: 'link', valorEtiqueta: 'https://vod.grupouninter.com.br/2025/AGO/Y-A01.mp4' }])] },
            { ordem: 1, nomeAtividade: 'A estrutura do texto', atividadeItemAprendizagens: [item('arquivo', [{ nomeTipoRecurso: 'repositorio', valorEtiqueta: '888', urlRecurso: 'https://univirtus.uninter.com/ava/repositorio/SistemaRepositorioPublico?id=b' }])] },
            { ordem: 3, nomeAtividade: 'Vídeo extra', atividadeItemAprendizagens: [item('video', [{ nomeTipoRecurso: 'link', valorEtiqueta: 'https://youtu.be/dQw4w9WgXcQ' }])] },
            { ordem: 4, nomeAtividade: 'Fórum', atividadeItemAprendizagens: [item('linkInterno', [])] },
          ],
        };
    }
    if (path === 'repositorio/SistemaRepositorioRemoto/') {
      if (failRota) throw Object.assign(new Error('500'), { status: 500 });
      const c = /aulas\/\/gradNova\/2021\/filosofia\/rel\/a(\d)\/index\.json$/.exec(opts.form.url);
      assert.ok(c, `URL de rota inesperada: ${opts.form.url}`);
      return rota(Number(c[1]));
    }
    if (path === 'repositorio/SistemaRepositorio/777') return { sistemaRepositorio: { nome: 'FILOSOFIA DA RELIGIAO.pdf' } };
    if (path === 'repositorio/SistemaRepositorio/888') return { sistemaRepositorio: { nome: 'A estrutura do texto.pdf' } };
    throw Object.assign(new Error(`404 ${path}`), { status: 404 });
  };
  return { api, calls };
}

test('nomes seguros, únicos e bonitos', () => {
  assert.equal(safeName('Tema 1 – O que é filosofia?'), 'Tema 1 – O que é filosofia');
  assert.equal(safeName('a/b\\c:d*e"f<g>h|i. '), 'a b c d e f g h i');
  assert.equal(safeName('CON'), '_CON');
  assert.equal(safeName('   '), 'Sem título');
  assert.equal(prettyCase('BACHARELADO EM FILOSOFIA'), 'Bacharelado em Filosofia');
  assert.equal(prettyCase('PROJETO INTERDISCIPLINAR II'), 'Projeto Interdisciplinar II');
  assert.equal(prettyCase('Filosofia da Religião'), 'Filosofia da Religião');
  const u = createUniquer();
  assert.equal(u('A/x.mp4'), 'A/x.mp4');
  assert.equal(u('A/X.mp4'), 'A/X (2).mp4');
  assert.equal(u('A/x.mp4'), 'A/x (3).mp4');
});

test('URLs derivadas seguem as regras do AVA', () => {
  const v = 'https://vod.grupouninter.com.br/2021/SET/10202101662-A01-P01.mp4';
  assert.equal(audioUrlFor(v), 'https://aud.grupouninter.com.br/2021/SET/10202101662-A01-P01.mp3');
  assert.equal(librasUrlFor(v), 'https://vod.grupouninter.com.br/2021/SET/L10202101662-A01-P01.mp4');
  assert.equal(audioUrlFor('https://youtu.be/x'), null);
  assert.equal(
    rotaSourceUrl('https://conteudosdigitais.uninter.com/libraries/newrota/?c=/gradNova/2021/filosofia/filosofiaReligiao/a1&amp;hash=3u0Jf1'),
    'https://conteudosdigitais.uninter.com/materiais/aulas//gradNova/2021/filosofia/filosofiaReligiao/a1/index.json',
  );
  assert.equal(rotaSourceUrl('https://ava.grupouninter.com.br/rota/aula.php?x=1#y'), 'https://ava.grupouninter.com.br/rota/aula.php?x=1&action=getvideos&value=all');
  assert.deepEqual(parseRota('resultvideos\nhttp://vod.grupouninter.com.br/a.mp4\n').videos, [{ url: 'https://vod.grupouninter.com.br/a.mp4', titulo: null }]);
  assert.deepEqual(parseRota('<video src="https://vod.grupouninter.com.br/b.mp4"></video>').videos.map((x) => x.url), ['https://vod.grupouninter.com.br/b.mp4']);
  // Formato antigo: a aula inteira vem junto com as partes.
  const antigo = parseRota('resultvideos\nhttps://vod.grupouninter.com.br/2019/MAI/1-A02.mp4\nhttps://vod.grupouninter.com.br/2019/MAI/1-A02-P01.mp4\nhttps://vod.grupouninter.com.br/2019/MAI/1-A02-P02.mp4');
  assert.equal(antigo.completo, 'https://vod.grupouninter.com.br/2019/MAI/1-A02.mp4');
  assert.deepEqual(antigo.videos.map((v) => v.url.slice(-11)), ['1-A02-P01.mp4', '1-A02-P02.mp4'].map((x) => x.slice(-11)));
});

test('status pela data da oferta', () => {
  assert.equal(statusOf({ dataInicio: '2026-08-31', dataFim: '2026-11-08' }, NOW), 'andamento');
  assert.equal(statusOf({ dataInicio: '2026-06-22', dataFim: '2026-08-30' }, NOW), 'anterior');
  assert.equal(statusOf({ dataInicio: '2027-02-01', dataFim: '2027-04-01' }, NOW), 'futura');
  assert.equal(statusOf({ dataInicio: '2025-10-27', dataFim: '2032-12-31' }, NOW), 'extra');
});

test('catálogo completo: ordem das aulas, tópicos da rota, materiais, vídeos diretos e links', async () => {
  const { api } = fakeApi();
  const progress = [];
  const cat = await loadCatalog(api, { now: NOW, onProgress: (p) => progress.push(p.done) });
  assert.deepEqual(progress, [0, 1, 2]);
  assert.equal(cat.cursos.length, 1);
  const [rel, prod] = cat.cursos[0].disciplinas;
  assert.equal(rel.nome, 'Filosofia da Religião');
  assert.equal(rel.status, 'andamento');
  assert.equal(prod.status, 'anterior');
  assert.deepEqual(rel.aulas.map((a) => a.ordem), [1, 2]);
  assert.deepEqual(rel.aulas[0].videos.map((v) => v.titulo), ['Conversa Inicial', 'Tema 1 – O que é filosofia?', 'Finalizando']);
  assert.equal(rel.aulas[0].videos[0].url, 'https://vod.grupouninter.com.br/2021/SET/X-A01-P01.mp4');
  assert.deepEqual(rel.aulas[0].completos.map((c) => c.url), ['https://vod.grupouninter.com.br/2021/SET/X-A01.mp4']);
  assert.equal(rel.complementar.materiais[0].nomeArquivo, 'FILOSOFIA DA RELIGIAO.pdf');
  const aula = prod.aulas[0];
  assert.deepEqual(aula.videos.map((v) => v.titulo), ['Aula 1 - com legenda']);
  assert.deepEqual(aula.links, []);
  assert.deepEqual(aula.externos.map((x) => [x.videoId, x.titulo]), [['dQw4w9WgXcQ', 'Vídeo extra']]);
  assert.equal(aula.materiais[0].nomeArquivo, 'A estrutura do texto.pdf');
});

test('rota que falha vira aviso na aula, sem derrubar o resto', async () => {
  const { api } = fakeApi({ failRota: true });
  const cat = await loadCatalog(api, { now: NOW });
  const rel = cat.cursos[0].disciplinas[0];
  assert.equal(rel.aulas[0].videos.length, 0);
  assert.match(rel.aulas[0].avisos[0], /Não foi possível ler a rota/);
  assert.equal(rel.complementar.materiais.length, 1);
});

test('sessão expirada interrompe a leitura com erro de sessão', async () => {
  const { api } = fakeApi({ session: true });
  await assert.rejects(loadCatalog(api, { now: NOW }), (e) => e.session === true);
});

test('plano: pastas organizadas por curso/disciplina/aula, tipos e índice offline', async () => {
  const { api } = fakeApi();
  const cat = await loadCatalog(api, { now: NOW });
  const all = new Set(leafKeys(cat.cursos[0]));
  const rel = cat.cursos[0].disciplinas[0];
  const libras = new Map([['https://vod.grupouninter.com.br/2021/SET/LX-A01-P01.mp4', true]]);
  const plan = buildPlan(cat, { selected: all, types: { ...DEFAULT_TYPES, completo: true, audio: true, libras: true }, libras, sizes: new Map([[rel.aulas[0].videos[0].url, 1234]]) });
  const paths = plan.entries.map((e) => e.path);
  const base = 'Bacharelado em Filosofia/Filosofia da Religião/Aula 01 - Introdução à Filosofia da Religião';
  assert.ok(paths.includes(`${base}/00 - Aula completa.mp4`));
  assert.ok(paths.includes(`${base}/01 - Conversa Inicial.mp4`));
  assert.ok(paths.includes(`${base}/02 - Tema 1 – O que é filosofia.mp4`));
  assert.ok(paths.includes(`${base}/Áudio/01 - Conversa Inicial.mp3`));
  assert.ok(paths.includes(`${base}/Libras/01 - Conversa Inicial.mp4`));
  assert.ok(!paths.includes(`${base}/Libras/02 - Tema 1 – O que é filosofia.mp4`), 'Libras só onde existe');
  assert.ok(paths.includes('Bacharelado em Filosofia/Filosofia da Religião/Material complementar/Plano de ensino - FILOSOFIA DA RELIGIAO.pdf'));
  assert.ok(paths.includes('Bacharelado em Filosofia/Produção Textual/Aula 01 - A argumentação/Materiais/A estrutura do texto.pdf'));
  assert.equal(new Set(paths).size, paths.length, 'caminhos únicos');
  assert.equal(plan.entries.find((e) => e.url === rel.aulas[0].videos[0].url).size, 1234);

  // A aula completa é um item próprio: marcar um tema não traz a aula completa junto.
  const one = buildPlan(cat, { selected: new Set([rel.aulas[1].videos[2].key]), types: { ...DEFAULT_TYPES, completo: true } });
  assert.deepEqual(one.entries.map((e) => e.path.split('/').slice(-1)[0]), ['03 - Finalizando.mp4']);
  const so = buildPlan(cat, { selected: new Set([rel.aulas[1].completos[0].key]), types: { ...DEFAULT_TYPES, video: false, completo: true } });
  assert.deepEqual(so.entries.map((e) => e.path.split('/').slice(-1)[0]), ['00 - Aula completa.mp4']);

  const html = buildOfflineIndex(plan.index);
  assert.ok(html.includes('Conversa Inicial'));
  assert.ok(!html.includes('</script><'), 'JSON embutido sem quebrar o <script>');
});

test('nome de material: evita repetir o título quando o arquivo já tem o mesmo nome', () => {
  assert.equal(materialFileName({ titulo: 'A estrutura do texto', nomeArquivo: 'A estrutura do texto.pdf' }), 'A estrutura do texto.pdf');
  assert.equal(materialFileName({ titulo: 'Plano de ensino', nomeArquivo: 'FILOSOFIA.pdf' }), 'Plano de ensino - FILOSOFIA.pdf');
  assert.equal(materialFileName({ titulo: 'Sem nome', nomeArquivo: null }), 'Sem nome.pdf');
});

test('pastas estáveis: não dependem da seleção e cursos homônimos não se misturam', async () => {
  const { folderNames } = await import('../extension/app/lib/plan.js');
  const cat = {
    cursos: [
      { key: 'c:1', nome: 'FILOSOFIA', encerrado: false, disciplinas: [{ key: 'd:1', nome: 'Lógica', aulas: [{ key: 'a:1', ordem: 1, rotulo: 'Aula', nome: 'X', videos: [{ key: 'v1', url: 'https://vod.grupouninter.com.br/a.mp4', titulo: 'T' }], materiais: [], links: [], completos: [] }], complementar: null }] },
      { key: 'c:2', nome: 'FILOSOFIA', encerrado: true, disciplinas: [{ key: 'd:2', nome: 'Lógica', aulas: [{ key: 'a:2', ordem: 1, rotulo: 'Aula', nome: 'X', videos: [{ key: 'v2', url: 'https://vod.grupouninter.com.br/b.mp4', titulo: 'T' }], materiais: [], links: [], completos: [] }], complementar: null }] },
    ],
  };
  const dirs = folderNames(cat);
  assert.equal(dirs.get('c:1'), 'Filosofia');
  assert.equal(dirs.get('c:2'), 'Filosofia (encerrado)');
  const so2 = buildPlan(cat, { selected: new Set(['v2']) }).entries[0].path;
  const ambos = buildPlan(cat, { selected: new Set(['v1', 'v2']) }).entries.map((e) => e.path);
  assert.ok(ambos.includes(so2), 'mesmo caminho com ou sem o outro curso selecionado');
});

test('disciplina de curso encerrado nunca aparece como "em andamento"', async () => {
  const { api } = fakeApi({ withClosed: true });
  const cat = await loadCatalog(api, { now: NOW });
  const closed = cat.cursos.find((c) => c.encerrado);
  assert.equal(closed.disciplinas[0].status, 'anterior');
});

test('YouTube vira item selecionável e entra no plano como MP4 na pasta da aula', async () => {
  const { api } = fakeApi();
  const cat = await loadCatalog(api, { now: NOW });
  const aula = cat.cursos[0].disciplinas[1].aulas[0];
  const key = aula.externos[0].key;
  assert.ok(leafKeys(cat.cursos[0]).includes(key));
  const plan = buildPlan(cat, { selected: new Set([key]) });
  assert.deepEqual(
    plan.entries.map((e) => [e.path, e.kind, e.videoId, e.size]),
    [['Bacharelado em Filosofia/Produção Textual/Aula 01 - A argumentação/YouTube - Vídeo extra.mp4', 'youtube', 'dQw4w9WgXcQ', null]],
  );
  const off = buildPlan(cat, { selected: new Set([key]), types: { ...DEFAULT_TYPES, youtube: false } });
  assert.equal(off.entries.length, 0);
});

test('Windows: caminhos curtos o bastante (≤ 190) e nomes válidos, mesmo com títulos enormes', async () => {
  const longo = 'Projeto Interdisciplinar I - Tópicos Especiais em História da Filosofia Antiga, Medieval e Moderna';
  const aulaNome = 'ETAPA A - Projeto interdisciplinar I (Conheça os ODS) - História da Filosofia Antiga e o Pensamento Grego';
  const cat = {
    cursos: [
      {
        key: 'c:1',
        nome: 'BACHARELADO EM FILOSOFIA - LICENCIATURA E BACHARELADO COM ÊNFASE EM ENSINO',
        disciplinas: [
          {
            key: 'd:1',
            nome: longo,
            aulas: [
              {
                key: 'a:1', ordem: 1, rotulo: 'Aula', nome: aulaNome, links: [], externos: [],
                completos: [{ key: 'c0', url: 'https://vod.grupouninter.com.br/x-A01.mp4' }],
                videos: [{ key: 'v0', url: 'https://vod.grupouninter.com.br/x-A01-P01.mp4', titulo: 'Tema 1 – Uma introdução muito longa sobre a relação entre fé, razão e a história do pensamento ocidental' }],
                materiais: [{ key: 'm0', url: 'https://x/y', titulo: 'Template 1: Etapa A - postagem 1 - Produto Parcial projeto interdisciplinar I Filosofia', nomeArquivo: 'Template 1 Etapa A - postagem 1 - Produto Parcial projeto interdisciplinar I Filosofia.docx' }],
              },
            ],
            complementar: null,
          },
        ],
      },
    ],
  };
  const plan = buildPlan(cat, { selected: new Set(['c0', 'v0', 'm0']), types: { ...DEFAULT_TYPES, completo: true, audio: true } });
  assert.ok(plan.entries.length >= 4);
  for (const e of plan.entries) {
    assert.ok(e.path.length <= 190, `${e.path.length}: ${e.path}`);
    for (const part of e.path.split('/')) {
      assert.ok(!/[<>:"\\|?*\u0000-\u001f]/.test(part), part);
      assert.ok(!/[. ]$/.test(part), `termina com ponto/espaço: ${part}`);
    }
  }
  assert.ok(plan.entries.find((e) => e.kind === 'material').path.endsWith('.docx'), 'extensão preservada');
});

test('por tema OU aula completa; aula sem versão completa continua com os temas', async () => {
  const { api } = fakeApi();
  const cat = await loadCatalog(api, { now: NOW });
  const all = new Set(leafKeys(cat.cursos[0]));
  const nomes = (types) => buildPlan(cat, { selected: all, types: { ...DEFAULT_TYPES, materiais: false, youtube: false, ...types } }).entries.map((e) => `${e.disciplina}|${e.path.split('/').pop()}`);
  const temas = nomes({ video: true, completo: false });
  assert.ok(temas.includes('Filosofia da Religião|01 - Conversa Inicial.mp4'));
  assert.ok(!temas.some((n) => n.includes('Aula completa')));
  const completa = nomes({ video: false, completo: true });
  assert.ok(completa.includes('Filosofia da Religião|00 - Aula completa.mp4'));
  assert.ok(!completa.includes('Filosofia da Religião|01 - Conversa Inicial.mp4'), 'sem duplicar o conteúdo');
  // Produção Textual não tem aula completa: mantém o vídeo da aula.
  assert.ok(completa.includes('Produção Textual|01 - Aula 1 - com legenda.mp4'));
});
