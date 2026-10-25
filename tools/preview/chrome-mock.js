// Simula as APIs do Chrome e o AVA para ver a interface sem instalar a extensão.
// Dados 100% fictícios, no mesmo formato das respostas reais da API do AVA.
// Uso: node tools/preview/server.mjs  →  http://127.0.0.1:8765/app/preview.html

(() => {
  const params = new URLSearchParams(location.search);
  const LOGGED = params.get('logged') !== '0';
  const SLOW = Number(params.get('slow') || 0);

  const store = {};
  const listeners = [];
  const disciplinas = [
    ['Filosofia da Religião', 'andamento', 6, 8],
    ['Filosofia Latino-Americana e Brasileira', 'andamento', 6, 9],
    ['Teoria do Conhecimento', 'andamento', 6, 7],
    ['Projeto Interdisciplinar I - Tópicos Especiais em História da Filosofia', 'andamento', 3, 9],
    ['Atividades Extensionistas I - Global Meeting', 'andamento', 3, 0],
    ['Formação Cidadã Contemporânea', 'anterior', 6, 8],
    ['Introdução Geral à Filosofia', 'anterior', 6, 8],
    ['Produção Textual', 'anterior', 6, 2],
    ['Sala Bônus - Orientações', 'extra', 1, 0],
  ];
  const TEMAS = ['Conversa Inicial', 'Tema 1 – O que é filosofia?', 'Tema 2 – O que é religião?', 'Tema 3 – Por que estudar?', 'Tema 4 – Objeções', 'Tema 5 – Elementos comuns', 'Na Prática', 'Finalizando', 'Extra'];
  const dates = { andamento: ['2026-08-31T00:00:00', '2026-11-08T00:00:00'], anterior: ['2026-06-22T00:00:00', '2026-08-30T00:00:00'], extra: ['2025-10-27T00:00:00', '2032-12-31T00:00:00'] };

  function api(path, form) {
    if (path.startsWith('sistema/Curso/0/EscolaUsuario/true/?emCurso=true')) return { cursos: [{ idCurso: 1, idUsuarioCurso: 10, nome: 'BACHARELADO EM FILOSOFIA', nomeCursoNivel: 'GRADUAÇÃO' }] };
    if (path.startsWith('sistema/Curso/0/EscolaUsuario/true/?emCurso=false')) return { cursos: [{ idCurso: 2, idUsuarioCurso: 20, nome: 'CURSO LIVRE DE LÓGICA', nomeCursoNivel: 'LIVRE' }] };
    if (path.startsWith('ava/SalaVirtual/1/CursoUsuarioPermissao'))
      return { salaVirtuais: disciplinas.map(([nome, st], i) => ({ id: 100 + i, cId: `c${i}`, nome, dataInicio: dates[st][0], dataFim: dates[st][1], idSalaVirtualOfertaAtual: 900 + i })) };
    if (path.startsWith('ava/SalaVirtual/2/CursoUsuarioPermissao')) return { salaVirtuais: [{ id: 199, cId: 'c99', nome: 'Lógica Básica', dataInicio: dates.anterior[0], dataFim: dates.anterior[1], idSalaVirtualOfertaAtual: 999 }] };
    let m = /^sistema\/UsuarioSalaVirtualOferta\/(\d+)\/Atual/.exec(path);
    if (m) return { usuarioSalaVirtualOferta: { idSalaVirtualOferta: 800 + Number(m[1]) } };
    m = /TipoOfertaCriptografado\/(\d)\/?\?(.*)$/.exec(path);
    if (m) {
      const q = new URLSearchParams(m[2]);
      const i = q.get('id') === 'c99' ? 99 : Number(q.get('id').slice(1));
      if (m[1] === '2') return { salaVirtualEstruturas: i < 3 ? [{ id: i * 1000 + 99, nomeSalaVirtualEstruturaRotulo: 'Material Complementar' }] : [] };
      const n = i === 99 ? 2 : disciplinas[i][2];
      const nomes = ['Introdução', 'Aspectos antigos', 'Pensamento oriental', 'Religiões monoteístas', 'Cristianismo', 'Crítica às religiões'];
      return { salaVirtualEstruturas: Array.from({ length: n }, (_, k) => ({ id: i * 1000 + k + 1, ordem: k + 1, nome: i === 3 ? `ETAPA ${'ABC'[k]} - Projeto interdisciplinar` : nomes[k], nomeSalaVirtualEstruturaRotulo: 'Aula' })) };
    }
    m = /^ava\/SalaVirtualAtividade\/(\d+)\/EstruturaOferta/.exec(path);
    if (m) {
      const id = Number(m[1]);
      const i = Math.floor(id / 1000);
      const k = id % 1000;
      const item = (tipo, etqs, nome = null) => ({ nomeAtividade: nome, itemAprendizagem: { classificacaoTipo: tipo }, itemAprendizagemEtiquetas: etqs });
      const arq = (rid) => [{ nomeTipoRecurso: 'repositorio', valorEtiqueta: String(rid), urlRecurso: `https://univirtus.uninter.com/ava/repositorio/SistemaRepositorioPublico?id=${rid}` }];
      if (k === 99)
        return {
          salaVirtualAtividades: [
            { ordem: 1, nomeAtividade: 'Plano de ensino', atividadeItemAprendizagens: [item('arquivo', arq(id * 10 + 1))] },
            { ordem: 2, nomeAtividade: 'Documentos adicionais', atividadeItemAprendizagens: [item('arquivo', arq(id * 10 + 2))] },
          ],
        };
      const atv = [];
      if (i === 4) {
        atv.push({ ordem: 1, nomeAtividade: 'Palestra de abertura', atividadeItemAprendizagens: [item('video', [{ nomeTipoRecurso: 'link', valorEtiqueta: 'https://youtu.be/jNQXAC9IVRw' }])] });
        atv.push({ ordem: 2, nomeAtividade: 'Roteiro da atividade', atividadeItemAprendizagens: [item('arquivo', arq(id * 10 + 3))] });
      } else if (i === 7) {
        atv.push({ ordem: 1, nomeAtividade: `Aula ${k} - com legenda`, atividadeItemAprendizagens: [item('video', [{ nomeTipoRecurso: 'link', valorEtiqueta: `https://vod.grupouninter.com.br/2025/AGO/PT-A0${k}.mp4` }])] });
        atv.push({ ordem: 2, nomeAtividade: 'A estrutura do texto argumentativo', atividadeItemAprendizagens: [item('arquivo', arq(id * 10 + 4))] });
      } else if (i !== 8) {
        atv.push({ ordem: 1, nomeAtividade: 'Rota', atividadeItemAprendizagens: [item('rota', [{ nomeTipoRecurso: 'link', valorEtiqueta: `https://conteudosdigitais.uninter.com/libraries/newrota/?c=/grad/${i}/a${k}&amp;hash=x` }])] });
      }
      return { salaVirtualAtividades: atv };
    }
    if (path === 'repositorio/SistemaRepositorioRemoto/') {
      const mm = /grad\/(\d+)\/a(\d+)\/index\.json$/.exec(form.url);
      const i = Number(mm[1]);
      const k = Number(mm[2]);
      if (i === 6 && k === 3) throw Object.assign(new Error('500'), { status: 500 });
      const n = i === 99 ? 4 : disciplinas[i][3];
      const midia = {};
      for (let p = 1; p <= n; p++) midia[p] = { titulo: i === 3 ? null : TEMAS[p - 1], url: `http://vod.grupouninter.com.br/2021/SET/D${i}-A0${k}-P0${p}.mp4` };
      return { curso: 'FILOSOFIA', disciplina: 'X', video_completo: i === 1 ? '' : `http://vod.grupouninter.com.br/2021/SET/D${i}-A0${k}.mp4`, aula: { midia } };
    }
    m = /^repositorio\/SistemaRepositorio\/(\d+)/.exec(path);
    if (m) return { sistemaRepositorio: { nome: ['', 'PLANO DE ENSINO.pdf', 'Como acessar as aulas AO VIVO.png', 'Roteiro.pdf', 'A estrutura do texto argumentativo.pdf'][Number(m[1]) % 10] || 'Arquivo.pdf' } };
    throw Object.assign(new Error('404'), { status: 404 });
  }

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  window.chrome = {
    runtime: { id: 'preview', onMessage: { addListener: (fn) => listeners.push(fn) }, sendMessage: async () => {}, getURL: (p) => `/${p}` },
    storage: {
      local: {
        async get(key) {
          return { [key]: store[key] };
        },
        async set(obj) {
          Object.assign(store, JSON.parse(JSON.stringify(obj)));
        },
      },
    },
    tabs: {
      async query() {
        return [{ id: 7, windowId: 1, url: 'https://univirtus.uninter.com/ava/web/' }];
      },
      async get(id) {
        return { id, windowId: 1 };
      },
      async update() {},
      async create() {
        return { id: 8 };
      },
      async sendMessage(tabId, msg) {
        await delay(40 + Math.random() * 120 + SLOW);
        if (msg.type === 'ava:ping') return { ok: true, logged: LOGGED, nome: 'Aluno' };
        if (msg.type === 'ava:api') {
          try {
            return { ok: true, status: 200, data: api(msg.path, msg.form) };
          } catch (e) {
            return { ok: false, status: e.status || 500, error: e.message };
          }
        }
        return null;
      },
    },
    scripting: { async executeScript() {} },
    windows: { async update() {} },
    power: { requestKeepAwake() {}, releaseKeepAwake() {} },
    declarativeNetRequest: { async updateSessionRules() {} },
  };

  // Seletores de arquivo → OPFS (sistema de arquivos privado do navegador), para testar a gravação real
  // sem o diálogo do sistema operacional. /__export envia o resultado para o servidor conferir.
  const opfs = () => navigator.storage.getDirectory();
  window.showSaveFilePicker = async ({ suggestedName }) => (await opfs()).getFileHandle(suggestedName, { create: true });
  window.showDirectoryPicker = async () => (await opfs()).getDirectoryHandle('Downloads', { create: true });
  window.__exportOpfs = async (name) => {
    const file = await (await (await opfs()).getFileHandle(name)).getFile();
    const r = await realFetch(`/__export?name=${encodeURIComponent(name)}`, { method: 'POST', body: file });
    return r.text();
  };

  // Mídia: redireciona os CDNs para o servidor local, que gera bytes com HEAD/Range.
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const u = new URL(url, location.href);
    if (/(^|\.)(youtube\.com|googlevideo\.com)$/.test(u.hostname)) {
      return realFetch(`/__yt?u=${encodeURIComponent(u.href)}`, { method: init?.method || 'GET', headers: init?.headers, body: init?.body, signal: init?.signal });
    }
    if (/grupouninter\.com\.br$|univirtuscdn\.uninter\.com$/.test(u.hostname) || u.pathname.includes('SistemaRepositorioPublico')) {
      return realFetch(`/__media/${u.hostname}${u.pathname}${u.search ? `__${encodeURIComponent(u.search)}` : ''}`, init);
    }
    return realFetch(input, init);
  };
})();
