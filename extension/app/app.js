import { audioUrlFor, librasUrlFor, loadCatalog, STATUS_LABEL } from './lib/catalog.js';
import { describeError, DirectoryTarget, DownloadJob, FOLDER_NAME, INDEX_FILE, probeSize, ZipTarget } from './lib/downloader.js';
import { icon } from './lib/icons.js';
import { fold, prettyCase, safeName } from './lib/naming.js';
import { buildPlan, DEFAULT_TYPES, gruposDe, summarize } from './lib/plan.js';
import { formatBytes, formatDuration, plural, pool, sleep } from './lib/util.js';

const AVA_HOME = 'https://univirtus.uninter.com/ava/web/#/ava';
const AVA_MATCH = 'https://univirtus.uninter.com/*';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const view = $('#view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

for (const el of $$('[data-icon]')) el.outerHTML = icon(el.dataset.icon, 16);

let toastTimer;
function toast(msg, ms = 4200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function confirmDialog({ title, body, ok = 'Confirmar', cancel = 'Voltar', danger = false }) {
  return new Promise((resolve) => {
    const d = h(`<dialog class="popover"><form method="dialog">
      <h2>${esc(title)}</h2><p class="hint" style="font-size:14px;color:var(--text-2)">${esc(body)}</p>
      <div class="dialog-actions"><button class="btn" value="no">${esc(cancel)}</button><button class="btn ${danger ? 'danger' : 'primary'}" value="yes">${esc(ok)}</button></div>
    </form></dialog>`);
    document.body.append(d);
    d.addEventListener('close', () => {
      resolve(d.returnValue === 'yes');
      d.remove();
    });
    d.showModal();
  });
}

// ---------------------------------------------------------------- Preferências
const prefs = { types: { ...DEFAULT_TYPES }, format: 'zip', concurrency: 4, status: 'todas' };

async function loadPrefs() {
  const { prefs: saved } = await chrome.storage.local.get('prefs');
  if (saved) Object.assign(prefs, saved, { types: { ...DEFAULT_TYPES, ...(saved.types || {}) } });
}
const savePrefs = () => chrome.storage.local.set({ prefs });

// ---------------------------------------------------------------- Tamanhos (HEAD), com cache
const UNKNOWN = -2;
const MISSING = -1;

const sizes = {
  map: new Map(),
  inflight: new Map(),
  saveTimer: null,
  async load() {
    const { sizes: saved } = await chrome.storage.local.get('sizes');
    for (const [u, v] of Object.entries(saved || {})) if (typeof v === 'number' && v >= 0) this.map.set(u, v);
  },
  persist() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const obj = {};
      for (const [u, v] of this.map) if (v >= 0) obj[u] = v;
      chrome.storage.local.set({ sizes: obj });
    }, 1500);
  },
  sizeOf(url) {
    const v = this.map.get(url);
    return typeof v === 'number' && v >= 0 ? v : null;
  },
  missing(url) {
    return this.map.get(url) === MISSING;
  },
  known(url) {
    return this.map.has(url);
  },
  probe(url) {
    if (this.map.has(url)) return Promise.resolve(this.map.get(url));
    if (this.inflight.has(url)) return this.inflight.get(url);
    const p = probeSize(url)
      .then((r) => {
        const v = r.missing ? MISSING : r.size ?? UNKNOWN;
        this.map.set(url, v);
        this.persist();
        return v;
      })
      .finally(() => this.inflight.delete(url));
    this.inflight.set(url, p);
    return p;
  },
  async ensure(urls, onProgress) {
    const todo = [...new Set(urls.filter(Boolean))].filter((u) => !this.map.has(u));
    let done = 0;
    onProgress?.(0, todo.length);
    await pool(todo, 12, async (u) => {
      await this.probe(u);
      done += 1;
      onProgress?.(done, todo.length);
    });
  },
  // Adaptadores para buildPlan
  asPlanSizes() {
    return { has: (u) => this.sizeOf(u) != null, get: (u) => this.sizeOf(u) };
  },
  asLibras() {
    return { get: (u) => this.sizeOf(u) != null };
  },
};

// ---------------------------------------------------------------- Conexão com o AVA
let avaTabId = Number(new URLSearchParams(location.search).get('tab')) || null;

async function ping(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'ava:ping' });
  } catch {
    return null;
  }
}

async function ensureContentScript(tabId) {
  const r = await ping(tabId);
  if (r) return r;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] });
  } catch {
    return null;
  }
  return ping(tabId);
}

async function findAva() {
  const ids = [];
  if (avaTabId) ids.push(avaTabId);
  for (const t of await chrome.tabs.query({ url: AVA_MATCH })) if (!ids.includes(t.id)) ids.push(t.id);
  let anyTab = null;
  for (const id of ids) {
    const r = await ensureContentScript(id);
    if (r?.logged && (!state.deadSession || r.session !== state.deadSession)) {
      avaTabId = id;
      state.session = r.session;
      return { tabId: id, logged: true, nome: r.nome };
    }
    if (r) anyTab = id;
  }
  return { tabId: anyTab, logged: false };
}

const sessionError = (msg = 'Sua sessão no AVA terminou.') => Object.assign(new Error(msg), { session: true, status: 401 });

// Limita chamadas simultâneas ao AVA para não sobrecarregar o servidor.
let inFlight = 0;
const queue = [];
async function slot() {
  if (inFlight < 10) {
    inFlight += 1;
    return;
  }
  await new Promise((r) => queue.push(r));
  inFlight += 1;
}
function release() {
  inFlight -= 1;
  queue.shift()?.();
}

async function api(path, opts = {}) {
  await slot();
  try {
    for (let attempt = 0; ; attempt++) {
      let r = null;
      try {
        r = await chrome.tabs.sendMessage(avaTabId, { type: 'ava:api', path, form: opts.form });
      } catch {
        r = null;
      }
      if (!r) {
        const found = await findAva();
        if (found.logged && attempt < 2) continue;
        throw sessionError('A aba do AVA foi fechada ou saiu da conta.');
      }
      if (r.status === 401) throw sessionError();
      if (r.ok) return r.data;
      if ((r.status >= 500 || r.status === 0) && attempt < 2) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      throw Object.assign(new Error(r.error || `HTTP ${r.status}`), { status: r.status });
    }
  } finally {
    release();
  }
}

async function openAva() {
  if (avaTabId) {
    try {
      const tab = await chrome.tabs.get(avaTabId);
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return;
    } catch {
      avaTabId = null;
    }
  }
  const [existing] = await chrome.tabs.query({ url: AVA_MATCH });
  if (existing) {
    avaTabId = existing.id;
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    const t = await chrome.tabs.create({ url: AVA_HOME });
    avaTabId = t.id;
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'app:ava-tab' && msg.tabId) {
    avaTabId = msg.tabId;
    if (state.phase === 'login') connect();
  }
});

// ---------------------------------------------------------------- Estado
const state = {
  phase: 'connecting', // connecting | login | loading | select | download | error
  user: null,
  catalog: null,
  roots: [],
  nodes: new Map(),
  selected: new Set(),
  expanded: new Set(),
  search: '',
  job: null,
  session: null,
  deadSession: null,
};

function setWho() {
  const who = $('#who');
  who.hidden = !state.user;
  if (state.user) who.innerHTML = `<span class="dot"></span>Conectado como ${esc(state.user)}`;
  $('#btn-refresh').hidden = state.phase !== 'select';
}

// ---------------------------------------------------------------- Telas simples
function renderState({ art = 'download', tone = '', title, text, body = '', actions = '' }) {
  view.innerHTML = `<section class="state">
    <div class="art ${tone}">${icon(art, 34)}</div>
    <h1>${title}</h1>
    <p>${text}</p>
    ${body}
    ${actions ? `<div class="actions">${actions}</div>` : ''}
  </section>`;
  setWho();
}

function renderConnecting() {
  renderState({ art: 'link', title: 'Conectando ao AVA…', text: 'Procurando uma aba do AVA Univirtus aberta neste navegador.', body: '<div class="waiting"><span class="spinner"></span>Só um instante</div>' });
}

let loginTimer = null;
function renderLogin(expired = false) {
  state.phase = 'login';
  state.user = null;
  renderState({
    art: 'login',
    title: expired ? 'Sua sessão no AVA terminou' : 'Entre no AVA para continuar',
    text: 'A extensão usa a sua própria conta do AVA para ver as suas disciplinas. Nada é enviado para outro lugar.',
    body: `<ol class="steps"><li>Abra o AVA e entre com seu RU e senha.</li><li>Volte para esta aba. Eu continuo sozinho assim que você entrar.</li></ol>
      <div class="waiting"><span class="spinner"></span>Aguardando o login…</div>`,
    actions: `<button class="btn primary lg" id="go-ava">${icon('login', 18)}Abrir o AVA</button>`,
  });
  $('#go-ava').onclick = openAva;
  clearInterval(loginTimer);
  loginTimer = setInterval(async () => {
    if (state.phase !== 'login') return clearInterval(loginTimer);
    const found = await findAva();
    if (found.logged) {
      clearInterval(loginTimer);
      connect();
    }
  }, 2000);
}

function renderLoading() {
  renderState({
    art: 'book',
    title: 'Lendo suas disciplinas',
    text: 'Buscando cursos, aulas, vídeos e materiais direto da API do AVA.',
    body: '<div class="bar" id="load-bar"><i></i></div><div class="muted" id="load-text">Começando…</div>',
  });
}

function renderError(err) {
  state.phase = 'error';
  renderState({
    art: 'alert',
    tone: 'warn',
    title: 'Algo deu errado',
    text: esc(describeError(err)),
    actions: `<button class="btn primary" id="retry">${icon('refresh', 16)}Tentar de novo</button>`,
  });
  $('#retry').onclick = connect;
}

// ---------------------------------------------------------------- Fluxo principal
async function connect() {
  state.phase = 'connecting';
  renderConnecting();
  const found = await findAva();
  if (!found.logged) return renderLogin(false);
  state.user = found.nome;
  await loadAll();
}

async function loadAll({ keepSelection = false } = {}) {
  state.phase = 'loading';
  renderLoading();
  try {
    const catalog = await loadCatalog(api, {
      onProgress: ({ done, total, disciplina }) => {
        const bar = $('#load-bar > i');
        const txt = $('#load-text');
        if (bar) bar.style.width = total ? `${Math.round((done / total) * 100)}%` : '4%';
        if (txt) txt.textContent = total ? `${disciplina ? `${disciplina} · ` : ''}${done} de ${plural(total, 'disciplina', 'disciplinas')}` : 'Listando seus cursos…';
      },
    });
    const previous = keepSelection ? new Set(state.selected) : null;
    indexCatalog(catalog);
    state.selected = new Set();
    for (const n of state.nodes.values()) if (n.leaf && (!previous || previous.has(n.key))) state.selected.add(n.key);
    if (previous && !state.selected.size) for (const n of state.nodes.values()) if (n.leaf) state.selected.add(n.key);
    state.phase = 'select';
    renderSelect();
    probeForTypes();
  } catch (err) {
    if (err?.session) {
      // A aba ainda tem os dados da sessão antiga: só tenta de novo quando o login mudar.
      state.deadSession = state.session;
      return renderLogin(true);
    }
    renderError(err);
  }
}

// ---------------------------------------------------------------- Modelo da árvore
function indexCatalog(catalog) {
  state.catalog = catalog;
  state.nodes = new Map();
  state.roots = [];
  const add = (n) => {
    state.nodes.set(n.key, n);
    return n;
  };
  for (const curso of catalog.cursos) {
    const cn = add({ type: 'curso', key: curso.key, data: curso, children: [], parent: null, label: prettyCase(curso.nome) });
    for (const disc of curso.disciplinas) {
      const dn = add({ type: 'disc', key: disc.key, data: disc, children: [], parent: cn, label: disc.nome, status: disc.status });
      for (const g of gruposDe(disc)) {
        const label = g.nome || g.rotulo;
        const gn = add({ type: 'grupo', key: g.key, data: g, children: [], parent: dn, label });
        for (const v of g.videos) gn.children.push(add({ type: 'video', key: v.key, data: v, children: [], parent: gn, label: v.titulo, leaf: true }));
        for (const m of g.materiais) gn.children.push(add({ type: 'material', key: m.key, data: m, children: [], parent: gn, label: m.nomeArquivo || m.titulo, leaf: true }));
        if (gn.children.length || g.links.length || g.avisos.length || g.error) dn.children.push(gn);
      }
      cn.children.push(dn);
    }
    state.roots.push(cn);
  }
  const leaves = (n) => (n.leaves = n.leaf ? [n] : n.children.flatMap(leaves));
  state.roots.forEach(leaves);
  for (const n of state.nodes.values()) n.text = fold(n.label);
}

const t = () => prefs.types;
const videoEnabled = () => t().video || t().audio || t().libras || t().completo;
const leafEnabled = (n) => (n.type === 'material' ? t().materiais : videoEnabled());

/** URLs que uma folha gera com os tipos atuais. */
function outputsOf(n) {
  if (n.type === 'material') return t().materiais && n.data.url ? [n.data.url] : [];
  const out = [];
  if (t().video) out.push(n.data.url);
  if (t().audio) out.push(audioUrlFor(n.data.url));
  if (t().libras) {
    const l = librasUrlFor(n.data.url);
    if (l && sizes.sizeOf(l) != null) out.push(l);
  }
  return out.filter(Boolean);
}

function sizeOfNode(n) {
  let total = 0;
  let unknown = 0;
  const count = (u) => {
    const s = sizes.sizeOf(u);
    if (s != null) total += s;
    else if (!sizes.missing(u)) unknown += 1;
  };
  for (const leaf of n.leaves) outputsOf(leaf).forEach(count);
  if (t().completo) {
    const grupos = n.type === 'grupo' ? [n] : n.type === 'disc' ? n.children : n.type === 'curso' ? n.children.flatMap((d) => d.children) : [];
    for (const g of grupos) g.data.completos.forEach((c) => count(c.url));
  }
  return { total, unknown };
}

function checkState(n) {
  const leaves = n.leaves.filter(leafEnabled);
  if (!leaves.length) return { disabled: true, checked: false, indeterminate: false };
  const sel = leaves.filter((l) => state.selected.has(l.key)).length;
  return { disabled: false, checked: sel === leaves.length, indeterminate: sel > 0 && sel < leaves.length, sel, total: leaves.length };
}

function toggleNode(n, value) {
  const leaves = n.leaves.filter(leafEnabled);
  const cs = checkState(n);
  const on = value ?? !cs.checked;
  for (const l of leaves) on ? state.selected.add(l.key) : state.selected.delete(l.key);
  sync();
}

// ---------------------------------------------------------------- Busca
function matchSet() {
  const q = fold(state.search.trim());
  if (!q) return null;
  const hits = new Set();
  for (const n of state.nodes.values()) {
    if (n.type === 'curso') continue;
    if (n.text.includes(q)) {
      // Um item encontrado mostra seus ancestrais e todos os seus descendentes.
      for (let p = n; p; p = p.parent) hits.add(p.key);
      const down = (x) => {
        hits.add(x.key);
        x.children.forEach(down);
      };
      down(n);
    }
  }
  return hits;
}

function highlight(text) {
  const q = fold(state.search.trim());
  if (!q) return esc(text);
  const chars = Array.from(text);
  const folded = chars.map((c) => fold(c) || c);
  const flat = folded.join('');
  const out = [];
  let i = 0;
  let pos = 0;
  // Converte posição no texto "dobrado" para índice de caractere original.
  const starts = [];
  folded.forEach((f, k) => {
    starts.push(pos);
    pos += f.length;
  });
  let from = 0;
  for (;;) {
    const at = flat.indexOf(q, from);
    if (at < 0) break;
    const a = starts.findIndex((s) => s >= at);
    let b = a;
    while (b < chars.length && starts[b] < at + q.length) b += 1;
    if (a < 0) break;
    out.push(esc(chars.slice(i, a).join('')), `<mark>${esc(chars.slice(a, b).join(''))}</mark>`);
    i = b;
    from = at + q.length;
  }
  out.push(esc(chars.slice(i).join('')));
  return out.join('');
}

// ---------------------------------------------------------------- Tela de seleção
const KIND_CHIPS = [
  { key: 'video', label: 'Vídeos por tema', icon: 'video', title: 'Cada tema da aula em um vídeo separado (Conversa inicial, Tema 1, Tema 2…)' },
  { key: 'completo', label: 'Aula completa', icon: 'clapper', title: 'Um vídeo único com a aula inteira (é a junção dos temas — ocupa o mesmo espaço de novo)' },
  { key: 'audio', label: 'Áudio MP3', icon: 'headphones', title: 'Áudio dos vídeos em MP3, ótimo para ouvir no celular' },
  { key: 'libras', label: 'Libras', icon: 'hand', title: 'Vídeos com intérprete de Libras, quando a aula tiver' },
  { key: 'materiais', label: 'Materiais', icon: 'file', title: 'PDFs, apostilas e arquivos das aulas e do material complementar' },
];

function chipCount(key) {
  const leaves = [...state.nodes.values()].filter((n) => n.leaf);
  const videos = leaves.filter((n) => n.type === 'video');
  if (key === 'video') return videos.length;
  if (key === 'audio') return videos.filter((v) => audioUrlFor(v.data.url)).length;
  if (key === 'materiais') return leaves.filter((n) => n.type === 'material').length;
  if (key === 'completo') return [...state.nodes.values()].filter((n) => n.type === 'grupo').reduce((s, g) => s + g.data.completos.length, 0);
  if (key === 'libras') {
    const urls = videos.map((v) => librasUrlFor(v.data.url)).filter(Boolean);
    if (!t().libras) return urls.length ? null : 0;
    if (urls.some((u) => !sizes.known(u))) return 'checking';
    return urls.filter((u) => sizes.sizeOf(u) != null).length;
  }
  return 0;
}

function renderSelect() {
  const discs = state.roots.flatMap((c) => c.children);
  const statusCounts = {};
  for (const d of discs) statusCounts[d.status] = (statusCounts[d.status] || 0) + 1;
  if (prefs.status !== 'todas' && !statusCounts[prefs.status]) prefs.status = 'todas';
  const statusOrder = ['andamento', 'anterior', 'futura', 'extra'].filter((s) => statusCounts[s]);

  view.innerHTML = `<section class="sheet" aria-labelledby="sel-title">
    <div class="sheet-head">
      <div class="sheet-title">
        <div>
          <h1 id="sel-title">O que você quer baixar?</h1>
          <p>Encontramos ${plural(discs.length, 'disciplina', 'disciplinas')} e ${plural([...state.nodes.values()].filter((n) => n.type === 'video').length, 'vídeo', 'vídeos')}. Desmarque o que não quiser.</p>
        </div>
      </div>
      <div class="toolbar">
        <div class="search">
          ${icon('search', 18)}
          <input id="q" type="search" placeholder="Buscar disciplina, aula ou tema…" autocomplete="off" aria-label="Buscar" value="${esc(state.search)}" />
          <span class="kbd" id="q-kbd">/</span>
          <button class="clear" id="q-clear" type="button" aria-label="Limpar busca" hidden>${icon('x', 14)}</button>
        </div>
        <div class="seg" role="group" aria-label="Filtrar disciplinas">
          <button type="button" data-status="todas" aria-pressed="${prefs.status === 'todas'}">Todas <span class="n">${discs.length}</span></button>
          ${statusOrder.map((s) => `<button type="button" data-status="${s}" aria-pressed="${prefs.status === s}">${STATUS_LABEL[s]} <span class="n">${statusCounts[s]}</span></button>`).join('')}
        </div>
      </div>
      <div class="types" role="group" aria-label="Tipos de conteúdo">
        <span>Incluir</span>
        ${KIND_CHIPS.map((c) => `<button type="button" class="chip" data-type="${c.key}" aria-pressed="${!!t()[c.key]}" title="${esc(c.title)}"><span class="box">${icon('check', 12)}</span>${icon(c.icon, 16)}${c.label}<span class="n" data-count="${c.key}"></span></button>`).join('')}
      </div>
    </div>
    <div class="sheet-body" id="tree-wrap">
      <div class="list-actions">
        <span id="list-info"></span>
        <div class="btns">
          <button class="btn ghost sm" id="sel-all" type="button">${icon('check', 15)}<span>Selecionar tudo</span></button>
          <button class="btn ghost sm" id="sel-none" type="button">${icon('x', 15)}<span>Limpar seleção</span></button>
        </div>
      </div>
      <div id="tree"></div>
      <div class="empty" id="empty" hidden></div>
    </div>
    <footer class="sheet-foot">
      <div class="summary" id="summary"></div>
      <div class="format">
        <span>Salvar como</span>
        <div class="seg" role="group" aria-label="Formato">
          <button type="button" data-format="zip" aria-pressed="${prefs.format === 'zip'}" title="Um único arquivo .zip, fácil de guardar ou mandar">${icon('archive', 16)}ZIP</button>
          <button type="button" data-format="dir" aria-pressed="${prefs.format === 'dir'}" title="Pasta organizada. Melhor para muitos GB: se parar no meio, continua de onde estava">${icon('folder', 16)}Pasta</button>
        </div>
      </div>
      <button class="btn primary lg" id="go" type="button">${icon('download', 18)}<span>Baixar</span></button>
    </footer>
  </section>`;
  setWho();
  buildTree();
  bindSelect();
  sync();
}

function nodeRow(n) {
  const id = `cb-${n.key.replace(/[^a-z0-9]/gi, '_')}`;
  if (n.type === 'disc') {
    const d = n.data;
    const nAulas = d.aulas.length;
    const nVid = n.leaves.filter((l) => l.type === 'video').length;
    const nMat = n.leaves.filter((l) => l.type === 'material').length;
    const sub = d.error ? `<span class="warn-ico">${esc(d.error)}</span>` : [plural(nAulas, 'aula', 'aulas'), nVid ? plural(nVid, 'vídeo', 'vídeos') : '', nMat ? plural(nMat, 'material', 'materiais') : ''].filter(Boolean).join(' · ');
    return `<li class="node disc" data-key="${esc(n.key)}">
      <div class="row">
        <button class="row-toggle" type="button" aria-expanded="false" aria-label="Abrir ${esc(n.label)}">${icon('chevron', 16)}</button>
        <input class="cb" type="checkbox" id="${id}" aria-label="Selecionar ${esc(n.label)}" />
        <span class="label" data-expand>
          <span class="glyph">${icon('book', 18)}</span>
          <span class="txt"><span class="name" data-name>${highlight(n.label)}</span><span class="sub">${sub}</span></span>
        </span>
        <span class="meta"><span class="tag ${d.status}">${STATUS_LABEL[d.status]}</span><span class="size" data-size></span></span>
      </div>
      <ul class="children" hidden></ul>
    </li>`;
  }
  if (n.type === 'grupo') {
    const g = n.data;
    const nVid = g.videos.length;
    const parts = [nVid ? plural(nVid, 'vídeo', 'vídeos') : '', g.completos.length ? 'aula completa' : '', g.materiais.length ? plural(g.materiais.length, 'material', 'materiais') : '', g.links.length ? plural(g.links.length, 'link', 'links') : ''].filter(Boolean);
    const glyph = g.ordem ? String(g.ordem).padStart(2, '0') : icon('layers', 15);
    const warn = g.avisos.length || g.error ? `<span class="warn-ico" title="${esc([g.error, ...g.avisos].filter(Boolean).join('\n'))}">${icon('alert', 15)}</span>` : '';
    const title = g.nome ? `${g.rotulo} ${g.ordem}` : '';
    return `<li class="node aula" data-key="${esc(n.key)}">
      <div class="row">
        <button class="row-toggle ${n.children.length || g.links.length ? '' : 'placeholder'}" type="button" aria-expanded="false" aria-label="Abrir ${esc(n.label)}">${icon('chevron', 16)}</button>
        <input class="cb" type="checkbox" id="${id}" aria-label="Selecionar ${esc(n.label)}" />
        <span class="label" data-expand>
          <span class="glyph">${glyph}</span>
          <span class="txt"><span class="name" data-name>${highlight(n.label)}</span><span class="sub">${esc([title, ...parts].filter(Boolean).join(' · '))}</span></span>
        </span>
        <span class="meta">${warn}<span class="size" data-size></span></span>
      </div>
      <ul class="children" hidden></ul>
    </li>`;
  }
  const isMat = n.type === 'material';
  const sub = isMat && n.data.nomeArquivo && n.data.titulo && fold(n.data.titulo) !== fold(n.data.nomeArquivo.replace(/\.[^.]+$/, '')) ? `<span class="sub">${esc(n.data.titulo)}</span>` : '';
  return `<li class="node leaf ${n.type === 'material' ? 'material' : 'video'}" data-key="${esc(n.key)}">
    <div class="row">
      <input class="cb" type="checkbox" id="${id}" />
      <label class="label" for="${id}">
        <span class="glyph">${icon(isMat ? 'file' : 'play', isMat ? 16 : 14)}</span>
        <span class="txt"><span class="name" data-name>${highlight(n.label)}</span>${sub}</span>
      </label>
      <span class="meta"><span class="size" data-size></span></span>
    </div>
  </li>`;
}

const rendered = new Map(); // key → li

function buildTree() {
  rendered.clear();
  const tree = $('#tree');
  tree.innerHTML = '';
  const multi = state.roots.length > 1;
  for (const c of state.roots) {
    if (!c.children.length) continue;
    if (multi || c.data.encerrado) {
      tree.append(h(`<div class="curso-head" data-curso="${esc(c.key)}">${icon('cap', 16)}<span>${esc(c.label)}</span>${c.data.encerrado ? '<span class="tag encerrado">Curso encerrado</span>' : ''}</div>`));
    }
    const ul = h('<ul class="tree"></ul>');
    for (const d of c.children) {
      const li = h(nodeRow(d));
      rendered.set(d.key, li);
      ul.append(li);
      if (state.expanded.has(d.key)) expand(d, li, true);
    }
    tree.append(ul);
  }
}

function renderChildren(n, li) {
  const ul = $(':scope > .children', li);
  if (ul.dataset.built) return ul;
  ul.dataset.built = '1';
  if (n.type === 'grupo') {
    const g = n.data;
    if (g.avisos.length || g.error) ul.append(h(`<li class="notes">${[g.error, ...g.avisos].filter(Boolean).map(esc).join('<br>')}</li>`));
  }
  for (const c of n.children) {
    const cli = h(nodeRow(c));
    rendered.set(c.key, cli);
    ul.append(cli);
    if (state.expanded.has(c.key)) expand(c, cli, true);
  }
  if (n.type === 'grupo' && n.data.links.length) {
    ul.append(
      h(`<li class="links">${n.data.links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener" title="Link externo — não é baixado">${icon('link', 13)}${esc(l.titulo)}</a>`).join('')}</li>`),
    );
  }
  return ul;
}

function expand(n, li, open) {
  const ul = renderChildren(n, li);
  ul.hidden = !open;
  li.classList.toggle('open', open);
  $(':scope > .row .row-toggle', li)?.setAttribute('aria-expanded', String(open));
  if (open) state.expanded.add(n.key);
  else state.expanded.delete(n.key);
}

function bindSelect() {
  const tree = $('#tree');
  tree.addEventListener('click', (e) => {
    const li = e.target.closest('li.node');
    if (!li) return;
    const n = state.nodes.get(li.dataset.key);
    if (e.target.closest('.row-toggle') || e.target.closest('[data-expand]')) {
      if (!n.children.length && !(n.data.links || []).length) return;
      expand(n, li, !li.classList.contains('open'));
      sync();
    }
  });
  tree.addEventListener('change', (e) => {
    if (!e.target.classList.contains('cb')) return;
    const li = e.target.closest('li.node');
    toggleNode(state.nodes.get(li.dataset.key), e.target.checked);
  });

  const q = $('#q');
  let deb;
  q.addEventListener('input', () => {
    clearTimeout(deb);
    deb = setTimeout(() => {
      state.search = q.value;
      applySearch();
    }, 120);
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && q.value) {
      e.stopPropagation();
      q.value = '';
      state.search = '';
      applySearch();
    }
  });
  $('#q-clear').onclick = () => {
    q.value = '';
    state.search = '';
    applySearch();
    q.focus();
  };

  for (const b of $$('[data-status]')) {
    b.onclick = () => {
      prefs.status = b.dataset.status;
      savePrefs();
      $$('[data-status]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      sync();
    };
  }
  for (const b of $$('[data-type]')) {
    b.onclick = () => {
      const k = b.dataset.type;
      t()[k] = !t()[k];
      savePrefs();
      b.setAttribute('aria-pressed', String(t()[k]));
      probeForTypes();
      sync();
    };
  }
  for (const b of $$('[data-format]')) {
    b.onclick = () => {
      prefs.format = b.dataset.format;
      savePrefs();
      $$('[data-format]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    };
  }
  $('#sel-all').onclick = () => {
    for (const n of visibleLeaves()) state.selected.add(n.key);
    sync();
  };
  $('#sel-none').onclick = () => {
    const vis = visibleLeaves();
    for (const n of vis) state.selected.delete(n.key);
    sync();
  };
  $('#go').onclick = startDownload;
}

function discVisibleByStatus(d) {
  return prefs.status === 'todas' || d.status === prefs.status;
}

function visibleLeaves() {
  const hits = matchSet();
  return [...state.nodes.values()].filter((n) => n.leaf && leafEnabled(n) && discVisibleByStatus(n.parent.parent) && (!hits || hits.has(n.key)));
}

function applySearch() {
  const hits = matchSet();
  $('#q-clear').hidden = !state.search;
  $('#q-kbd').hidden = Boolean(state.search);
  if (hits) {
    // Abre o caminho até cada resultado.
    for (const key of hits) {
      const n = state.nodes.get(key);
      if (n.type === 'disc' || n.type === 'grupo') {
        const hasHitChild = n.children.some((c) => hits.has(c.key)) && !n.text.includes(fold(state.search.trim()));
        if (hasHitChild) {
          const li = ensureRendered(n);
          if (li) expandForSearch(n, li);
        }
      }
    }
  } else {
    for (const [key, li] of rendered) {
      const n = state.nodes.get(key);
      if ((n.type === 'disc' || n.type === 'grupo') && li.dataset.searchOpen) {
        delete li.dataset.searchOpen;
        if (!state.expanded.has(key)) expand(n, li, false);
      }
    }
  }
  for (const [key, li] of rendered) {
    const n = state.nodes.get(key);
    const name = $(':scope > .row [data-name]', li);
    if (name) name.innerHTML = highlight(n.label);
  }
  sync();
}

function expandForSearch(n, li) {
  const wasOpen = li.classList.contains('open');
  const keep = state.expanded.has(n.key);
  expand(n, li, true);
  if (!keep && !wasOpen) {
    state.expanded.delete(n.key);
    li.dataset.searchOpen = '1';
  }
}

function ensureRendered(n) {
  if (rendered.has(n.key)) return rendered.get(n.key);
  if (!n.parent || n.parent.type === 'curso') return null;
  const pli = ensureRendered(n.parent);
  if (!pli) return null;
  renderChildren(n.parent, pli);
  return rendered.get(n.key) || null;
}

let syncQueued = false;
function sync() {
  if (state.phase !== 'select') return;
  const hits = matchSet();
  let visibleDiscs = 0;
  for (const [key, li] of rendered) {
    const n = state.nodes.get(key);
    const cs = checkState(n);
    const cb = $(':scope > .row .cb', li);
    cb.checked = cs.checked;
    cb.indeterminate = cs.indeterminate;
    cb.disabled = cs.disabled;
    li.classList.toggle('checked', cs.checked);
    li.classList.toggle('dim', cs.disabled);
    const sz = sizeOfNode(n);
    const sizeEl = $(':scope > .row [data-size]', li);
    if (sizeEl) sizeEl.textContent = sz.total || !sz.unknown ? formatBytes(sz.total, { approx: sz.unknown > 0 }) : '…';
    let visible = !hits || hits.has(key);
    if (n.type === 'disc') {
      visible = visible && discVisibleByStatus(n);
      if (visible) visibleDiscs += 1;
    }
    li.hidden = !visible;
  }
  for (const head of $$('.curso-head')) {
    const c = state.nodes.get(head.dataset.curso);
    const any = c.children.some((d) => !rendered.get(d.key)?.hidden);
    head.hidden = !any;
    head.nextElementSibling.hidden = !any;
  }
  const empty = $('#empty');
  empty.hidden = visibleDiscs > 0;
  if (!visibleDiscs) {
    empty.innerHTML = state.search ? `<strong>Nada encontrado para “${esc(state.search)}”</strong>Tente outra palavra ou limpe a busca.` : '<strong>Nenhuma disciplina neste filtro</strong>Escolha outro filtro acima.';
  }

  // Chips
  for (const c of KIND_CHIPS) {
    const el = $(`[data-count="${c.key}"]`);
    if (!el) continue;
    const v = chipCount(c.key);
    el.innerHTML = v === 'checking' ? '<span class="spinner" style="width:12px;height:12px;display:inline-block;vertical-align:-2px"></span>' : v == null ? '' : String(v);
  }

  // Botões de seleção em massa e informação da lista
  $('#sel-all span').textContent = state.search ? 'Selecionar resultados' : 'Selecionar tudo';
  $('#sel-none span').textContent = state.search ? 'Desmarcar resultados' : 'Limpar seleção';

  updateSummary();
}

function scheduleSync() {
  if (syncQueued) return;
  syncQueued = true;
  setTimeout(() => {
    syncQueued = false;
    sync();
  }, 250);
}

function currentPlan() {
  const selected = new Set([...state.selected].filter((k) => {
    const n = state.nodes.get(k);
    return n && leafEnabled(n);
  }));
  return buildPlan(state.catalog, { selected, types: t(), libras: sizes.asLibras(), sizes: sizes.asPlanSizes() });
}

function updateSummary() {
  const plan = currentPlan();
  const s = summarize(plan);
  const pending = plan.entries.filter((e) => e.size == null && !sizes.known(e.url)).length;
  const hiddenSel = [...state.selected].filter((k) => {
    const n = state.nodes.get(k);
    return n && leafEnabled(n) && !visibleLeavesSet().has(k);
  }).length;
  const el = $('#summary');
  if (!s.files) {
    el.innerHTML = `<strong>Nada selecionado</strong><span>Marque disciplinas, aulas ou temas para baixar.</span>`;
  } else {
    el.innerHTML = `<strong>${plural(s.files, 'arquivo', 'arquivos')} · ${formatBytes(s.totalBytes, { approx: s.unknownSizes > 0 })}</strong>
      <span>${plural(s.disciplinas, 'disciplina', 'disciplinas')} · ${plural(s.aulas, 'aula', 'aulas')}${pending ? ' · <span class="spinner"></span> calculando tamanho' : ''}${hiddenSel ? ` · inclui ${plural(hiddenSel, 'item', 'itens')} fora do filtro` : ''}</span>`;
  }
  const go = $('#go');
  go.disabled = !s.files;
  $('span', go).textContent = s.files ? `Baixar ${plural(s.files, 'arquivo', 'arquivos')}` : 'Baixar';
  $('#list-info').textContent = state.selected.size ? `${plural([...state.selected].filter((k) => leafEnabled(state.nodes.get(k))).length, 'item marcado', 'itens marcados')}` : '';
}

let visCache = null;
function visibleLeavesSet() {
  const key = `${state.search}|${prefs.status}|${JSON.stringify(t())}`;
  if (visCache?.key !== key) visCache = { key, set: new Set(visibleLeaves().map((n) => n.key)) };
  return visCache.set;
}

// Sonda tamanhos (e disponibilidade de Libras) conforme os tipos marcados.
async function probeForTypes() {
  if (!state.catalog) return;
  const leaves = [...state.nodes.values()].filter((n) => n.leaf);
  const urls = [];
  for (const n of leaves) {
    if (n.type === 'material') {
      if (n.data.url) urls.push(n.data.url);
      continue;
    }
    urls.push(n.data.url);
    if (t().audio) urls.push(audioUrlFor(n.data.url));
    if (t().libras) urls.push(librasUrlFor(n.data.url));
  }
  if (t().completo) for (const n of state.nodes.values()) if (n.type === 'grupo') n.data.completos.forEach((c) => urls.push(c.url));
  try {
    await sizes.ensure(urls, () => scheduleSync());
  } finally {
    scheduleSync();
  }
}

// ---------------------------------------------------------------- Download
function suggestedZipName() {
  const plan = currentPlan();
  const discs = [...new Set(plan.entries.map((e) => e.disciplina))];
  const date = new Date().toLocaleDateString('pt-BR').replace(/\//g, '-');
  if (discs.length === 1) return `${safeName(discs[0], 80)}.zip`;
  return `Aulas Uninter ${date}.zip`;
}

async function startDownload() {
  if (!('showSaveFilePicker' in window)) {
    toast('Este navegador não permite salvar arquivos grandes direto no disco. Use o Google Chrome ou o Microsoft Edge atualizados.');
    return;
  }
  const format = prefs.format;
  let handle;
  try {
    handle =
      format === 'zip'
        ? await window.showSaveFilePicker({ suggestedName: suggestedZipName(), id: 'ava-zip', startIn: 'downloads', types: [{ description: 'Arquivo ZIP', accept: { 'application/zip': ['.zip'] } }] })
        : await window.showDirectoryPicker({ id: 'ava-pasta', mode: 'readwrite', startIn: 'downloads' });
  } catch (err) {
    if (err?.name !== 'AbortError') toast(describeError(err));
    return;
  }
  await runDownload({ handle, format });
}

async function runDownload({ handle, format, onlyEntries = null }) {
  state.phase = 'download';
  setWho();
  renderPreparing(format, handle);

  let entries;
  let missing = [];
  try {
    if (onlyEntries) {
      // Tamanhos podem ter mudado no servidor: confere de novo antes de tentar.
      for (const e of onlyEntries) sizes.map.delete(e.url);
      await sizes.ensure(
        onlyEntries.map((e) => e.url),
        (d, total) => setPrepText(`Conferindo tamanhos… ${d} de ${total}`),
      );
      missing = onlyEntries.filter((e) => sizes.missing(e.url));
      entries = onlyEntries.filter((e) => !sizes.missing(e.url)).map((e) => ({ ...e, size: sizes.sizeOf(e.url) }));
    } else {
      if (t().libras) {
        const libras = [...state.selected].map((k) => state.nodes.get(k)).filter((n) => n?.type === 'video').map((n) => librasUrlFor(n.data.url));
        await sizes.ensure(libras, (d, total) => setPrepText(`Verificando vídeos em Libras… ${d} de ${total}`));
      }
      let plan = currentPlan();
      await sizes.ensure(
        plan.entries.map((e) => e.url),
        (d, total) => setPrepText(`Conferindo tamanhos… ${d} de ${total}`),
      );
      plan = currentPlan();
      missing = plan.entries.filter((e) => sizes.missing(e.url));
      entries = plan.entries.filter((e) => !sizes.missing(e.url));
      state.lastIndex = plan.index;
    }
  } catch (err) {
    renderError(err);
    return;
  }

  const index = state.lastIndex || [];
  const target = format === 'zip' ? new ZipTarget(handle, { index }) : new DirectoryTarget(handle, { index });
  const job = new DownloadJob({ entries, target, concurrency: Number(prefs.concurrency) || 4 });
  state.job = job;
  state.lastRun = { handle, format, missing };
  renderProgress(job, { format, handle, missing });

  try {
    chrome.power.requestKeepAwake('system');
  } catch {
    /* sem permissão: segue normalmente */
  }
  let error = null;
  try {
    await job.start();
  } catch (err) {
    error = err;
  } finally {
    // Tamanho guardado que não bate mais com o servidor: esquece para a próxima vez.
    for (const it of job.items) if (it.sizeChanged) sizes.map.delete(it.url);
    sizes.persist();
    try {
      chrome.power.releaseKeepAwake();
    } catch {
      /* nada */
    }
  }
  renderFinished(job, { format, handle, missing, error });
}

let prepEl = null;
function setPrepText(s) {
  if (prepEl) prepEl.textContent = s;
}

function destinationLabel(format, handle) {
  return format === 'zip' ? `Salvando em <b>${esc(handle.name)}</b>` : `Salvando na pasta <b>${esc(handle.name)}/${esc(FOLDER_NAME)}</b>`;
}

function renderPreparing(format, handle) {
  view.innerHTML = `<section class="dl"><div class="card dl-main">
    <div class="dl-top"><div><h1><span class="spinner" style="width:22px;height:22px;border-width:3px"></span>Preparando</h1>
    <p>${icon(format === 'zip' ? 'archive' : 'folder', 16)}<span>${destinationLabel(format, handle)}</span></p></div></div>
    <div class="bar indeterminate" style="margin-top:24px"><i></i></div>
    <p class="muted" id="prep" style="color:var(--text-3);margin:10px 0 0">Montando a lista de arquivos…</p>
  </div></section>`;
  prepEl = $('#prep');
}

const KIND_ICON = { video: 'play', completo: 'clapper', audio: 'headphones', libras: 'hand', material: 'file' };

function renderProgress(job, { format, handle }) {
  const total = job.items.length;
  view.innerHTML = `<section class="dl">
    <div class="card dl-main">
      <div class="dl-top">
        <div>
          <h1 id="dl-title">Baixando suas aulas</h1>
          <p>${icon(format === 'zip' ? 'archive' : 'folder', 16)}<span>${destinationLabel(format, handle)}</span></p>
        </div>
        <div class="actions">
          <button class="btn" id="dl-pause" type="button">${icon('pause', 16)}<span>Pausar</span></button>
          <button class="btn danger" id="dl-cancel" type="button">${icon('stop', 15)}<span>Cancelar</span></button>
        </div>
      </div>
      <div class="big-pct"><span id="dl-pct">0</span>%<small id="dl-of"></small></div>
      <div class="bar" id="dl-bar"><i></i></div>
      <div class="stats">
        <div class="stat"><small>Arquivos</small><b id="st-files">0 de ${total}</b></div>
        <div class="stat"><small>Velocidade</small><b id="st-speed">—</b></div>
        <div class="stat"><small>Tempo restante</small><b id="st-eta">calculando…</b></div>
        <div class="stat"><small>Falhas</small><b id="st-fail">0</b></div>
      </div>
      <div class="notice">${icon('info', 18)}<span>Pode usar o computador normalmente, só não feche esta aba até terminar.</span></div>
    </div>
    <div class="card section"><h2><span>Baixando agora</span><span id="dl-active-n"></span></h2><ul class="files" id="dl-active"></ul></div>
    <div class="card section" id="dl-fail-card" hidden><h2><span>Com problema</span></h2><ul class="files" id="dl-failed"></ul></div>
  </section>`;

  $('#dl-pause').onclick = () => {
    if (job.paused) job.resume();
    else job.pause();
    tick();
  };
  $('#dl-cancel').onclick = async () => {
    const ok = await confirmDialog({
      title: 'Cancelar o download?',
      body: format === 'zip' ? 'O arquivo ZIP incompleto será descartado.' : 'O que já foi baixado continua na pasta. Se baixar de novo, ele continua de onde parou.',
      ok: 'Cancelar download',
      cancel: 'Continuar baixando',
      danger: true,
    });
    if (ok) job.cancel();
  };

  const samples = [];
  const activeRows = new Map();
  const idle = h('<li class="file idle"><span class="name"><small></small></span></li>');
  $('#dl-active').append(idle);
  function tick() {
    if (state.job !== job || !$('#dl-bar')) return clearInterval(timer);
    const s = job.snapshot();
    const now = Date.now();
    samples.push({ t: now, b: s.transferred });
    while (samples.length > 2 && now - samples[0].t > 8000) samples.shift();
    const first = samples[0];
    const speed = now - first.t > 900 ? ((s.transferred - first.b) / (now - first.t)) * 1000 : null;
    const pct = s.total ? Math.min(100, (s.bytes / s.total) * 100) : 0;
    const finished = s.counts.done + s.counts.skipped + s.counts.failed;
    $('#dl-pct').textContent = pct >= 10 ? Math.floor(pct) : pct.toFixed(1).replace('.', ',');
    $('#dl-of').textContent = `${formatBytes(s.bytes)} de ${formatBytes(s.total)}`;
    $('#dl-bar > i').style.width = `${pct}%`;
    $('#dl-bar').classList.toggle('paused', s.paused);
    $('#st-files').textContent = `${finished} de ${total}`;
    $('#st-speed').textContent = s.paused ? 'pausado' : speed != null ? `${formatBytes(speed)}/s` : '—';
    $('#st-eta').textContent = s.paused ? '—' : speed > 0 ? formatDuration((s.total - s.bytes) / speed) : 'calculando…';
    $('#st-fail').textContent = String(s.counts.failed);
    $('#dl-title').textContent = s.paused ? 'Pausado' : s.phase === 'finishing' ? 'Finalizando…' : 'Baixando suas aulas';
    const pause = $('#dl-pause');
    pause.innerHTML = s.paused ? `${icon('resume', 15)}<span>Continuar</span>` : `${icon('pause', 16)}<span>Pausar</span>`;
    document.title = `${Math.floor(pct)}% · AVA Downloader`;

    // Lista dos arquivos em andamento
    const list = $('#dl-active');
    const keep = new Set();
    for (const it of s.active) {
      keep.add(it.path);
      let row = activeRows.get(it.path);
      if (!row) {
        const parts = it.path.split('/');
        row = h(`<li class="file"><span class="glyph">${icon(KIND_ICON[it.kind] || 'file', 16)}</span>
          <span class="name"><b>${esc(parts[parts.length - 1])}</b><small>${esc(parts.slice(1, -1).join(' › '))}</small></span>
          <span class="bar"><i></i></span><span class="pct"></span></li>`);
        activeRows.set(it.path, row);
        list.append(row);
      }
      const size = it.size ?? it.expected;
      const p = size ? Math.min(100, (it.progress / size) * 100) : 0;
      $('.bar > i', row).style.width = `${p}%`;
      $('.pct', row).textContent = it.error ? 'tentando…' : size ? `${Math.floor(p)}%` : formatBytes(it.progress);
    }
    for (const [path, row] of activeRows) {
      if (!keep.has(path)) {
        row.remove();
        activeRows.delete(path);
      }
    }
    $('#dl-active-n').textContent = s.active.length ? String(s.active.length) : '';
    idle.hidden = s.active.length > 0;
    $('small', idle).textContent = s.paused ? 'Pausado. Clique em “Continuar” para seguir de onde parou.' : s.phase === 'finishing' ? 'Gravando o índice e fechando os arquivos…' : 'Aguardando…';

    renderFailedList(s.failed);
  }
  const timer = setInterval(tick, 400);
  tick();
}

function renderFailedList(failed) {
  const card = $('#dl-fail-card');
  if (!card) return;
  card.hidden = !failed.length;
  const ul = $('#dl-failed');
  if (ul.childElementCount === failed.length) return;
  ul.innerHTML = failed
    .map((it) => {
      const parts = it.path.split('/');
      return `<li class="file failed"><span class="glyph">${icon('alert', 16)}</span><span class="name"><b>${esc(parts[parts.length - 1])}</b><small>${esc(it.error || 'Erro')} · ${esc(parts.slice(1, -1).join(' › '))}</small></span></li>`;
    })
    .join('');
}

function renderFinished(job, { format, handle, missing, error }) {
  document.title = 'AVA Downloader';
  const s = job.snapshot();
  const elapsed = (s.finishedAt - s.startedAt) / 1000;
  const cancelled = job.phase === 'cancelled';
  const failedAll = job.phase === 'error';
  const ok = s.counts.done + s.counts.skipped;

  if (cancelled || failedAll) {
    view.innerHTML = `<section class="state">
      <div class="art ${failedAll ? 'warn' : ''}">${icon(failedAll ? 'alert' : 'stop', 34)}</div>
      <h1>${failedAll ? 'O download parou' : 'Download cancelado'}</h1>
      <p>${failedAll ? esc(describeError(error || job.fatal)) : format === 'zip' ? 'O ZIP incompleto foi descartado.' : 'O que já foi baixado continua na pasta. Baixando de novo, ele continua de onde parou.'}</p>
      <div class="actions"><button class="btn primary" id="back">${icon('download', 16)}Voltar para a seleção</button></div>
    </section>`;
    $('#back').onclick = backToSelect;
    return;
  }

  const partial = s.counts.failed > 0;
  const newBytes = job.items.filter((i) => i.status === 'done').reduce((sum, i) => sum + (i.size ?? i.progress), 0);
  const line =
    s.counts.done === 0 && s.counts.skipped
      ? `Tudo já estava baixado nesta pasta (${plural(s.counts.skipped, 'arquivo', 'arquivos')}). Nada novo para baixar.`
      : `${plural(s.counts.done, 'arquivo baixado', 'arquivos baixados')} · ${formatBytes(newBytes)} em ${formatDuration(elapsed)}${s.counts.skipped ? ` · ${plural(s.counts.skipped, 'já estava', 'já estavam')} na pasta` : ''}`;
  view.innerHTML = `<section class="dl">
    <div class="card dl-main">
      <div class="dl-top">
        <div style="display:flex;gap:18px;align-items:center">
          <div class="success-ring ${partial ? 'partial' : ''}">${icon(partial ? 'alert' : 'check', 30)}</div>
          <div>
            <h1>${partial ? 'Quase tudo pronto' : 'Pronto!'}</h1>
            <p>${line}</p>
          </div>
        </div>
      </div>
      <div class="bar done" style="margin-top:22px"><i style="width:100%"></i></div>
      <div class="notice ok">${icon('sparkle', 18)}<span>${format === 'zip' ? `Abra <b>${esc(handle.name)}</b> e depois o arquivo <b>${INDEX_FILE}</b>: ele mostra tudo organizado e toca as aulas, mesmo sem internet.` : `Na pasta <b>${esc(handle.name)}/${FOLDER_NAME}</b>, abra <b>${INDEX_FILE}</b>: ele mostra tudo organizado e toca as aulas, mesmo sem internet.`}</span></div>
      ${partial ? `<div class="notice warn">${icon('alert', 18)}<span>${plural(s.counts.failed, 'arquivo não pôde', 'arquivos não puderam')} ser baixado${s.counts.failed > 1 ? 's' : ''}. ${format === 'zip' ? 'Eles estão listados no arquivo “LEIA-ME” dentro do ZIP.' : 'Tente de novo: o que já foi baixado não é baixado outra vez.'}</span></div>` : ''}
      ${missing.length ? `<div class="notice warn">${icon('info', 18)}<span>${plural(missing.length, 'arquivo não existe', 'arquivos não existem')} mais no servidor da Uninter e ${missing.length > 1 ? 'foram ignorados' : 'foi ignorado'}.</span></div>` : ''}
      <div class="cta">
        <button class="btn primary lg" id="more">${icon('download', 18)}Baixar mais aulas</button>
        ${partial ? `<button class="btn lg" id="retry-failed">${icon('refresh', 18)}Tentar de novo os que falharam</button>` : ''}
      </div>
    </div>
    <div class="card section" id="dl-fail-card" hidden><h2><span>Com problema</span></h2><ul class="files" id="dl-failed"></ul></div>
  </section>`;
  renderFailedList(s.failed);
  $('#more').onclick = backToSelect;
  const retry = $('#retry-failed');
  if (retry) {
    retry.onclick = async () => {
      const failedEntries = job.items.filter((i) => i.status === 'failed').map(({ path, url, size, kind, titulo, curso, disciplina, aula }) => ({ path, url, size, kind, titulo, curso, disciplina, aula }));
      let target = handle;
      if (format === 'zip') {
        try {
          target = await window.showSaveFilePicker({ suggestedName: handle.name.replace(/\.zip$/i, '') + ' (faltantes).zip', id: 'ava-zip', types: [{ description: 'Arquivo ZIP', accept: { 'application/zip': ['.zip'] } }] });
        } catch (err) {
          if (err?.name !== 'AbortError') toast(describeError(err));
          return;
        }
      }
      runDownload({ handle: target, format, onlyEntries: failedEntries });
    };
  }
}

function backToSelect() {
  state.job = null;
  state.phase = 'select';
  renderSelect();
}

// ---------------------------------------------------------------- Atalhos, configurações e início
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && state.phase === 'select' && document.activeElement?.tagName !== 'INPUT') {
    e.preventDefault();
    $('#q')?.focus();
  }
});

window.addEventListener('beforeunload', (e) => {
  if (state.job && ['running', 'finishing'].includes(state.job.phase)) {
    e.preventDefault();
    e.returnValue = '';
  }
});

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem('ava-theme', theme);
  } catch {
    /* sem armazenamento: vale só nesta aba */
  }
  const dark = theme === 'dark';
  const btn = $('#btn-theme');
  const label = dark ? 'Usar modo claro' : 'Usar modo escuro';
  btn.innerHTML = icon(dark ? 'sun' : 'moon', 16);
  btn.title = label;
  btn.setAttribute('aria-label', label);
}
applyTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
$('#btn-theme').onclick = () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');

$('#btn-refresh').onclick = () => loadAll({ keepSelection: true });
$('#btn-settings').onclick = () => {
  $('#opt-concurrency').value = String(prefs.concurrency);
  $('#settings').showModal();
};
$('#opt-concurrency').onchange = (e) => {
  prefs.concurrency = Number(e.target.value) || 4;
  savePrefs();
};

(async function boot() {
  await Promise.all([loadPrefs(), sizes.load()]);
  await connect();
})();
