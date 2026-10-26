/* Player "Assistir aulas" — o mesmo código roda em dois lugares:
 * - na página "Assistir aulas.html" da pasta (file://, duplo clique), embutido pelo offline-index.js;
 * - dentro da extensão (app/watch.html), que já tem acesso à pasta: window.AVA_HOST = { data, handle, folderId, vendor }.
 * Com a extensão instalada, a página da pasta abre a versão da extensão sozinha (nada para escolher).
 * Os dados do aluno (progresso, destaques, notas) ficam em %storage%/dados.json na pasta e no localStorage. */
(() => {
  'use strict';

  const HOST = window.AVA_HOST || null;
  const RAW = HOST ? HOST.data : JSON.parse(document.getElementById('ava-data').textContent);
  const STORAGE = RAW.storage || '%storage%';
  const INDEX_FILE = 'Assistir aulas.html';
  const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
  // pdf.js e leitor de .docx: na extensão, de extension/vendor; na pasta, da cópia em %storage%/app.
  const LIB = HOST ? HOST.vendor : `${enc(STORAGE)}/app`;
  const folderPath = HOST
    ? `ext:${HOST.folderId}`
    : (() => {
        try {
          return decodeURIComponent(location.pathname).replace(/\/[^/]*$/, '');
        } catch {
          return location.pathname.replace(/\/[^/]*$/, '');
        }
      })();
  const folderName = HOST ? HOST.handle.name : folderPath.split('/').filter(Boolean).pop() || 'Aulas';

  // ------------------------------------------------------------------ utilidades
  const $ = (s, r = document) => r.querySelector(s);
  const SVG = 'http://www.w3.org/2000/svg';
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    if (props)
      for (const k in props) {
        const v = props[k];
        if (v == null || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k === 'style' && typeof v === 'object') for (const sk in v) sk.startsWith('--') ? e.style.setProperty(sk, v[sk]) : (e.style[sk] = v[sk]);
        else if (k === 'dataset') Object.assign(e.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v === true ? '' : v);
      }
    for (const c of kids.flat(3)) if (c != null && c !== false) e.append(c.nodeType ? c : String(c));
    return e;
  }
  function svgEl(tag, attrs = {}) {
    const e = document.createElementNS(SVG, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  const ICONS = {
    cap: '<path d="m2 9.5 10-5 10 5-10 5z"/><path d="M6 11.5V16c0 1.5 2.7 3 6 3s6-1.5 6-3v-4.5"/><path d="M22 9.5v5"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>',
    left: '<path d="m15 6-6 6 6 6"/>',
    right: '<path d="m9 6 6 6-6 6"/>',
    play: '<path d="M7 4.8v14.4a1 1 0 0 0 1.53.85l11.4-7.2a1 1 0 0 0 0-1.7L8.53 3.95A1 1 0 0 0 7 4.8Z" fill="currentColor" stroke="none"/>',
    pause: '<rect x="6" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" stroke="none"/><rect x="14" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" stroke="none"/>',
    film: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
    headphones: '<path d="M3 15v-3a9 9 0 0 1 18 0v3"/><path d="M21 16.5a2.5 2.5 0 0 1-2.5 2.5H17v-6h1.5a2.5 2.5 0 0 1 2.5 2.5z"/><path d="M3 16.5A2.5 2.5 0 0 0 5.5 19H7v-6H5.5A2.5 2.5 0 0 0 3 15.5z"/>',
    hand: '<path d="M8 12V5.5a1.5 1.5 0 0 1 3 0V11"/><path d="M11 10.5V4a1.5 1.5 0 0 1 3 0v6.5"/><path d="M14 10.5V5.5a1.5 1.5 0 0 1 3 0V12"/><path d="M17 9.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-2a6 6 0 0 1-4.7-2.3l-3-3.9a1.6 1.6 0 0 1 2.4-2.1L8 14"/>',
    youtube: '<rect x="2.5" y="5" width="19" height="14" rx="4"/><path d="m10 9.2 5 2.8-5 2.8z" fill="currentColor"/>',
    doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6"/><path d="M9 17h4"/>',
    external: '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M19 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4"/>',
    check: '<path d="m5 12.5 4.5 4.5L19.5 7"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M2.5 12h2M19.5 12h2M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
    moon: '<path d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a7 7 0 0 0 11 11z"/>',
    folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>',
    folderOk: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/><path d="m9 13.5 2 2 4-4"/>',
    alert: '<path d="M10.3 3.9 2.2 18a2 2 0 0 0 1.7 3h16.2a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4"/><path d="M12 17.2v.1"/>',
    sidebar: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9 4v16"/>',
    keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M7.5 14h9"/>',
    back10: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4.5h4.5"/><text x="12" y="15.2" text-anchor="middle" font-size="7.5" font-weight="700" fill="currentColor" stroke="none" font-family="system-ui,sans-serif">10</text>',
    fwd10: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4.5h-4.5"/><text x="12" y="15.2" text-anchor="middle" font-size="7.5" font-weight="700" fill="currentColor" stroke="none" font-family="system-ui,sans-serif">10</text>',
    vol: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/><path d="M18.5 6.5a7.5 7.5 0 0 1 0 11"/>',
    volLow: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/>',
    mute: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>',
    pip: '<rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><rect x="12" y="11.5" width="7" height="5.5" rx="1" fill="currentColor" stroke="none"/>',
    full: '<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/>',
    unfull: '<path d="M9 4v3.5A1.5 1.5 0 0 1 7.5 9H4M20 9h-3.5A1.5 1.5 0 0 1 15 7.5V4M15 20v-3.5a1.5 1.5 0 0 1 1.5-1.5H20M4 15h3.5A1.5 1.5 0 0 1 9 16.5V20"/>',
    note: '<path d="M5 4h14a1 1 0 0 1 1 1v10l-5 5H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path d="M15 20v-4a1 1 0 0 1 1-1h4"/><path d="M8 9h8M8 12.5h5"/>',
    pen: '<path d="m15 5 4 4"/><path d="M13.5 6.5 5 15l-1 5 5-1 8.5-8.5a2.8 2.8 0 0 0-4-4z"/>',
    marker: '<path d="m9 11-5 5v4h4l5-5"/><path d="m14.5 5.5 4 4"/><path d="M9 11 16.5 3.5a2.1 2.1 0 0 1 3 0l1 1a2.1 2.1 0 0 1 0 3L13 15z"/>',
    trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    onePage: '<rect x="6" y="3.5" width="12" height="17" rx="1.8"/>',
    twoPage: '<rect x="2.5" y="4.5" width="8.5" height="15" rx="1.5"/><rect x="13" y="4.5" width="8.5" height="15" rx="1.5"/>',
    grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    home: '<path d="m3 11 9-7 9 7"/><path d="M5 9.5V19a1 1 0 0 0 1 1h4v-5h4v5h4a1 1 0 0 0 1-1V9.5"/>',
    next: '<path d="M5 5.5v13a1 1 0 0 0 1.5.8l9-6.5a1 1 0 0 0 0-1.6l-9-6.5A1 1 0 0 0 5 5.5z"/><path d="M19 5v14"/>',
    prev: '<path d="M19 5.5v13a1 1 0 0 1-1.5.8l-9-6.5a1 1 0 0 1 0-1.6l9-6.5a1 1 0 0 1 1.5.8z"/><path d="M5 5v14"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    sparkle: '<path d="M12 3.5 13.8 9a2 2 0 0 0 1.2 1.2l5.5 1.8-5.5 1.8a2 2 0 0 0-1.2 1.2L12 20.5 10.2 15a2 2 0 0 0-1.2-1.2L3.5 12 9 10.2A2 2 0 0 0 10.2 9z"/>',
    book: '<path d="M12 6.5C10 5 7.5 4.5 4 4.5v14c3.5 0 6 .5 8 2 2-1.5 4.5-2 8-2v-14c-3.5 0-6 .5-8 2z"/><path d="M12 6.5v14"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="m21 16-5-5-9 9"/>',
    lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    speed: '<path d="M12 13.5 16 9"/><path d="M4.5 18a9 9 0 1 1 15 0"/>',
  };
  function icon(name, cls = '') {
    const s = svgEl('svg', { viewBox: '0 0 24 24', class: `ico ${cls}`.trim(), 'aria-hidden': 'true' });
    s.innerHTML = ICONS[name] || '';
    return s;
  }
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  function debounce(fn, ms) {
    let t;
    const d = (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
    d.flush = (...a) => {
      clearTimeout(t);
      fn(...a);
    };
    return d;
  }
  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
  }
  function fmtDur(s) {
    if (!s) return '';
    const m = Math.round(s / 60);
    if (m < 60) return `${Math.max(1, m)} min`;
    return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
  }
  function fmtAgo(t) {
    const d = (Date.now() - t) / 1000;
    if (d < 60) return 'agora';
    if (d < 3600) return `há ${Math.floor(d / 60)} min`;
    if (d < 86400) return `há ${Math.floor(d / 3600)} h`;
    if (d < 86400 * 7) return `há ${Math.floor(d / 86400)} d`;
    return new Date(t).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
  }
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  /** Texto com o trecho buscado em <mark>, sem perder os acentos do original. */
  function marked(text, q) {
    if (!q) return text;
    let norm = '';
    const map = [];
    for (let i = 0; i < text.length; i++) {
      const f = fold(text[i]);
      for (let k = 0; k < f.length; k++) map.push(i);
      norm += f;
    }
    const at = norm.indexOf(q);
    if (at < 0) return text;
    const a = map[at];
    const b = (map[at + q.length - 1] ?? text.length - 1) + 1;
    const frag = document.createDocumentFragment();
    frag.append(text.slice(0, a), h('mark', { text: text.slice(a, b) }), text.slice(b));
    return frag;
  }
  const isTyping = (e) => {
    const t = e.target;
    return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  };

  // ------------------------------------------------------------------ preferências (só deste navegador)
  const PREFS_KEY = 'ava-player-prefs';
  const prefs = Object.assign(
    { speed: 1, volume: 1, muted: false, autoplay: true, spread: 1, zoom: 'page', color: 'yellow', thumbs: false, notes: true, filter: 'all', side: true },
    (() => {
      try {
        return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
      } catch {
        return {};
      }
    })(),
  );
  const savePrefs = debounce(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {}
  }, 300);
  const UI_KEY = `ava-player-ui:${folderPath}`;
  const ui = (() => {
    try {
      const u = JSON.parse(localStorage.getItem(UI_KEY)) || {};
      return { open: new Set(u.open || []) };
    } catch {
      return { open: new Set() };
    }
  })();
  const saveUi = debounce(() => {
    try {
      localStorage.setItem(UI_KEY, JSON.stringify({ open: [...ui.open] }));
    } catch {}
  }, 300);

  // ------------------------------------------------------------------ modelo
  const KIND = {
    completo: { label: 'Aula completa', short: 'Completa', icon: 'film' },
    video: { label: 'Vídeo', short: '', icon: 'play' },
    youtube: { label: 'YouTube', short: 'YouTube', icon: 'youtube' },
    libras: { label: 'Libras', short: 'Libras', icon: 'hand' },
    audio: { label: 'Áudio', short: 'Áudio', icon: 'headphones' },
    material: { label: 'Material', short: '', icon: 'doc' },
    link: { label: 'Link', short: '', icon: 'external' },
  };
  const EXT = {
    video: new Set(['mp4', 'm4v', 'webm', 'mov', 'ogv']),
    audio: new Set(['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac']),
    image: new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif']),
    text: new Set(['txt', 'md', 'csv', 'json', 'xml', 'srt', 'vtt']),
    docx: new Set(['docx', 'docm', 'dotx']),
    doc: new Set(['doc', 'dot']),
  };
  const COLORS = [
    { id: 'yellow', name: 'Amarelo' },
    { id: 'green', name: 'Verde' },
    { id: 'blue', name: 'Azul' },
    { id: 'pink', name: 'Rosa' },
    { id: 'orange', name: 'Laranja' },
  ];
  const colorName = (id) => (COLORS.find((c) => c.id === id) || COLORS[0]).name;

  const M = { cursos: [], discs: [], aulas: [], items: [], byPath: new Map() };
  let seq = 0;
  for (const c of RAW.cursos || []) {
    const curso = { name: c.n, discs: [] };
    M.cursos.push(curso);
    for (const d of c.d || []) {
      const disc = { id: `d${seq++}`, name: d.n, curso, aulas: [] };
      curso.discs.push(disc);
      M.discs.push(disc);
      for (const g of d.g || []) {
        const aula = { id: `a${seq++}`, name: g.n, disc, items: [], links: [] };
        disc.aulas.push(aula);
        M.aulas.push(aula);
        for (const i of g.i || []) {
          const ext = (/\.([a-z0-9]+)$/i.exec(i.p) || [])[1]?.toLowerCase() || '';
          let view = i.k === 'audio' ? 'audio' : 'video';
          if (i.k === 'material') view = ext === 'pdf' ? 'pdf' : EXT.docx.has(ext) ? 'docx' : EXT.doc.has(ext) ? 'doc' : EXT.video.has(ext) ? 'video' : EXT.audio.has(ext) ? 'audio' : EXT.image.has(ext) ? 'image' : EXT.text.has(ext) ? 'text' : 'file';
          const it = { path: i.p, title: i.t, kind: i.k, url: i.u || null, ext, view, href: enc(i.p), aula, disc, curso, order: M.items.length };
          aula.items.push(it);
          M.items.push(it);
          M.byPath.set(it.path, it);
        }
        for (const l of g.l || []) aula.links.push({ title: l.t, url: l.h, kind: 'link', aula });
      }
    }
  }
  const isMedia = (it) => it.view === 'video' || it.view === 'audio';
  const family = (it) => it.aula.items.filter((o) => o !== it && fold(o.title) === fold(it.title) && o.kind !== 'material' && it.kind !== 'material');

  // ------------------------------------------------------------------ dados do aluno
  const LS_KEY = `ava-player:${folderPath}`;
  const empty = () => ({ v: AvaMerge.VERSION, items: {}, hl: {}, notes: {}, last: null });
  const { mergeData } = AvaMerge;
  const listeners = new Set();
  const Store = {
    d: empty(),
    annotDirty: false,
    load() {
      try {
        const raw = localStorage.getItem(LS_KEY);
        if (raw) this.d = mergeData(empty(), JSON.parse(raw));
      } catch {}
    },
    st(path) {
      return this.d.items[path] || {};
    },
    set(path, patch, { quiet = false } = {}) {
      this.d.items[path] = { ...this.st(path), ...patch, at: Date.now() };
      this.save(quiet);
    },
    list(kind, path) {
      return (this.d[kind][path] || []).filter((x) => !x.del);
    },
    upsert(kind, path, obj) {
      const arr = (this.d[kind][path] ||= []);
      const i = arr.findIndex((x) => x.id === obj.id);
      const rec = { ...(i >= 0 ? arr[i] : {}), ...obj, at: Date.now() };
      if (i >= 0) arr[i] = rec;
      else arr.push(rec);
      this.annotDirty = true;
      this.save();
      return rec;
    },
    remove(kind, path, id) {
      const arr = this.d[kind][path] || [];
      const i = arr.findIndex((x) => x.id === id);
      if (i >= 0) arr[i] = { id, del: true, at: Date.now() };
      this.annotDirty = true;
      this.save();
    },
    count(path) {
      return this.list('hl', path).length + this.list('notes', path).length;
    },
    setLast(path) {
      this.d.last = { path, at: Date.now() };
      this.save(true);
    },
    save(quiet = false) {
      this.writeLocal();
      Folder.schedule();
      if (!quiet) for (const fn of listeners) fn();
    },
    localFull: false,
    writeLocal: debounce(() => {
      // Todas as páginas file:// dividem o mesmo localStorage: outra aba desta pasta pode ter gravado
      // depois desta. Junta antes de gravar, para uma aba antiga não apagar o que a nova fez.
      try {
        const raw = localStorage.getItem(LS_KEY);
        if (raw) Store.d = mergeData(Store.d, JSON.parse(raw));
      } catch {}
      // Lápides de itens apagados há mais de 60 dias não precisam mais ir junto.
      const old = Date.now() - 60 * 86400e3;
      for (const kind of ['hl', 'notes']) for (const k in Store.d[kind]) Store.d[kind][k] = Store.d[kind][k].filter((x) => !x.del || x.at > old);
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(Store.d));
        Store.localFull = false;
      } catch {
        if (!Store.localFull && Folder.state !== 'ready') toast('O navegador ficou sem espaço para guardar seu progresso. Conecte a pasta das aulas para salvar nela.', { ms: 9000 });
        Store.localFull = true;
      }
    }, 250),
  };
  window.addEventListener('storage', (e) => {
    if (e.key !== LS_KEY || !e.newValue) return;
    try {
      Store.d = mergeData(Store.d, JSON.parse(e.newValue));
      emit();
    } catch {}
  });
  const onChange = (fn) => listeners.add(fn);
  const emit = () => {
    for (const fn of listeners) fn();
  };
  Store.load();

  function frac(it) {
    const s = Store.st(it.path);
    if (s.done) return 1;
    if (s.dur && s.pos) return clamp(s.pos / s.dur, 0, 0.97);
    if (s.pages && s.page) return clamp(s.page / s.pages, 0, 0.97);
    return 0;
  }
  const isDone = (it) => Boolean(Store.st(it.path).done);
  function aulaUnits(a) {
    const by = (k) => a.items.filter((i) => i.kind === k);
    const vids = by('video');
    const comps = by('completo');
    const units = [];
    // "Aula completa" e os temas são a mesma gravação: qualquer um dos dois conta.
    if (comps.length && vids.length) units.push(Math.max(...comps.map(frac), vids.reduce((s, i) => s + frac(i), 0) / vids.length));
    else for (const i of [...comps, ...vids]) units.push(frac(i));
    for (const i of [...by('youtube'), ...by('material')]) units.push(frac(i));
    if (!units.length) for (const i of a.items) units.push(frac(i));
    return units;
  }
  function aulaProgress(a) {
    const u = aulaUnits(a);
    if (!u.length) return { frac: 0, done: false };
    const f = u.reduce((s, x) => s + x, 0) / u.length;
    return { frac: f, done: u.every((x) => x >= 1) };
  }
  /** "Material complementar" tem progresso próprio, mas não conta como aula nos totais. */
  const countsAsAula = (a) => a.items.length > 0 && !/^material complementar/i.test(a.name);
  function discProgress(d) {
    const ps = d.aulas.filter(countsAsAula).map(aulaProgress);
    return { done: ps.filter((p) => p.done).length, total: ps.length, frac: ps.length ? ps.reduce((s, p) => s + p.frac, 0) / ps.length : 0 };
  }
  /** Marca/desmarca (com as versões em áudio/Libras da mesma gravação). Devolve a função "Desfazer". */
  function setDone(it, value) {
    return markItems([it, ...family(it)], value, !value);
  }
  function setAulaDone(a, value) {
    return markItems(a.items, value, false);
  }
  function markItems(items, value, resetPos) {
    const snap = items.map((o) => [o.path, { ...Store.st(o.path) }]);
    const t = Date.now();
    const patch = { done: value, dAt: t, ...(value ? { doneAt: t } : resetPos ? { pos: 0 } : {}) };
    for (const o of items) Store.set(o.path, patch, { quiet: true });
    emit();
    return () => {
      const t2 = Date.now();
      for (const [p, rec] of snap) Store.d.items[p] = { ...rec, at: t2, dAt: t2 };
      Store.save();
    };
  }
  function nextPending(d) {
    for (const a of d.aulas) {
      if (aulaProgress(a).done) continue;
      const it = a.items.find((i) => !isDone(i) && i.kind !== 'audio' && i.kind !== 'libras' && !(i.kind === 'video' && a.items.some((c) => c.kind === 'completo' && !isDone(c)))) || a.items.find((i) => !isDone(i));
      if (it) return it;
    }
    return null;
  }

  // ------------------------------------------------------------------ IndexedDB (guarda a pasta conectada)
  let dbP = null;
  function idb() {
    dbP ??= new Promise((ok, ko) => {
      const r = indexedDB.open('ava-player', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('handles');
      r.onsuccess = () => ok(r.result);
      r.onerror = () => ko(r.error);
    }).catch((err) => {
      dbP = null;
      throw err;
    });
    return dbP;
  }
  async function idbGet(k) {
    const db = await idb();
    return new Promise((ok, ko) => {
      const q = db.transaction('handles').objectStore('handles').get(k);
      q.onsuccess = () => ok(q.result);
      q.onerror = () => ko(q.error);
    });
  }
  async function idbSet(k, v) {
    const db = await idb();
    return new Promise((ok, ko) => {
      const t = db.transaction('handles', 'readwrite');
      t.objectStore('handles').put(v, k);
      t.oncomplete = () => ok();
      t.onerror = () => ko(t.error);
    });
  }

  // ------------------------------------------------------------------ pasta (%storage%)
  const Folder = {
    state: 'none', // unsupported | none | prompt | ready | error
    handle: null,
    saving: false,
    lastSaved: 0,
    error: null,
    async init() {
      if (HOST) {
        this.handle = HOST.handle;
        await this.ready();
        return;
      }
      if (!('showDirectoryPicker' in window)) {
        this.state = 'unsupported';
        return;
      }
      try {
        this.handle = (await idbGet(folderPath)) || null;
      } catch {
        this.handle = null;
      }
      if (!this.handle) {
        this.state = 'none';
        return;
      }
      let p = 'prompt';
      try {
        p = await this.handle.queryPermission({ mode: 'readwrite' });
      } catch {}
      if (p === 'granted') await this.ready();
      else this.state = 'prompt';
    },
    /** Precisa de um clique do usuário (o navegador exige). */
    async connect({ pick = true } = {}) {
      if (HOST) {
        // Na extensão a pasta já é conhecida: só confirma a permissão, nunca pede para escolher.
        try {
          if ((await this.handle.requestPermission({ mode: 'readwrite' })) === 'granted') return this.ready();
        } catch {}
        return false;
      }
      if (this.state === 'unsupported') {
        toast('Para salvar na pasta e abrir PDFs aqui, use o Google Chrome ou o Microsoft Edge.');
        return false;
      }
      if (this.handle && this.state !== 'ready') {
        try {
          if ((await this.handle.requestPermission({ mode: 'readwrite' })) === 'granted') return this.ready();
        } catch {}
        if (!pick) return false;
      }
      if (!pick) return false;
      let dir;
      try {
        dir = await window.showDirectoryPicker({ id: 'ava-aulas', mode: 'readwrite' });
      } catch (err) {
        if (err?.name !== 'AbortError') toast('Não consegui abrir a pasta: ' + (err?.message || err));
        return false;
      }
      const ok = await this.validate(dir);
      if (!ok) {
        toast(`Essa não é a pasta das aulas. Escolha “${folderName}”, a pasta onde está o arquivo “${INDEX_FILE}”.`, { ms: 7000 });
        return false;
      }
      this.handle = ok;
      try {
        await idbSet(folderPath, ok);
      } catch {}
      return this.ready();
    },
    async validate(dir) {
      // A pasta certa tem esta página; se ela foi renomeada, basta um dos primeiros arquivos existir.
      const probes = M.items.slice(0, 5).map((i) => i.path);
      const test = async (d) => {
        try {
          await d.getFileHandle(INDEX_FILE);
          return true;
        } catch {}
        for (const p of probes) {
          try {
            await this.file(p, d);
            return true;
          } catch {}
        }
        return false;
      };
      if (await test(dir)) return dir;
      try {
        const inner = await dir.getDirectoryHandle(folderName);
        if (await test(inner)) return inner;
      } catch {}
      return null;
    },
    async ready() {
      this.state = 'ready';
      this.error = null;
      try {
        const disk = await this.readData();
        if (disk) Store.d = mergeData(Store.d, disk);
        Store.annotDirty = true;
        Store.writeLocal();
        await this.write();
      } catch (err) {
        this.fail(err);
      }
      emit();
      renderStore();
      return this.state === 'ready';
    },
    async dir(path, create = false, base = this.handle) {
      let d = base;
      for (const name of path.split('/').filter(Boolean)) d = await d.getDirectoryHandle(name, { create });
      return d;
    },
    async file(path, base = this.handle) {
      const parts = path.split('/');
      const d = await this.dir(parts.slice(0, -1).join('/'), false, base);
      return (await d.getFileHandle(parts.at(-1))).getFile();
    },
    /** dados.json da pasta; null se ainda não existe. Nunca grava por cima de um arquivo que não entende. */
    async readData() {
      let text;
      try {
        text = await (await this.file(`${STORAGE}/dados.json`)).text();
      } catch (err) {
        if (err?.name === 'NotFoundError') return null;
        throw err;
      }
      let d = null;
      try {
        d = JSON.parse(text);
      } catch {}
      if (!d || typeof d !== 'object' || Array.isArray(d)) {
        if (!text.trim()) return null;
        // Ilegível (cópia cortada, conflito de sincronização…): guarda ao lado antes de seguir.
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        await this.writeText(`dados (ilegível ${stamp}).json`, text);
        toast(`O arquivo de anotações da pasta estava danificado. Guardei uma cópia em ${STORAGE} e segui com o que está neste navegador.`, { ms: 10000 });
        return null;
      }
      if ((d.v || 1) > AvaMerge.VERSION) throw new Error('As anotações da pasta são de uma versão mais nova desta página. Atualize a página pela extensão (Mais opções → Atualizar numa pasta já baixada).');
      return d;
    },
    async writeText(name, text) {
      const d = await this.dir(STORAGE, true);
      const w = await (await d.getFileHandle(name, { create: true })).createWritable();
      await w.write(text);
      await w.close();
    },
    schedule: debounce(() => Folder.write(), 1200),
    async write() {
      if (this.state !== 'ready') return;
      if (this.saving) {
        this.again = true;
        return;
      }
      this.saving = true;
      renderStore();
      try {
        // Outra aba ou outro computador pode ter gravado antes: junta antes de sobrescrever.
        const disk = await this.readData();
        if (disk) Store.d = mergeData(Store.d, disk);
        await this.writeText('dados.json', JSON.stringify(Store.d));
        if (Store.annotDirty) {
          Store.annotDirty = false;
          await this.writeText('Minhas anotações.md', exportMarkdown());
        }
        this.lastSaved = Date.now();
      } catch (err) {
        this.fail(err);
      } finally {
        this.saving = false;
        renderStore();
        if (this.again) {
          this.again = false;
          this.schedule();
        }
      }
    },
    fail(err) {
      if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') this.state = 'prompt';
      else {
        this.state = 'error';
        this.error = err?.message || String(err);
      }
    },
  };

  function exportMarkdown() {
    const out = ['# Minhas anotações', '', `_${folderName} · atualizado em ${new Date().toLocaleString('pt-BR', { dateStyle: 'long', timeStyle: 'short' })}_`, ''];
    for (const d of M.discs) {
      const block = [];
      for (const a of d.aulas) {
        const lines = [];
        for (const it of a.items) {
          const hls = Store.list('hl', it.path).sort((x, y) => x.page - y.page || x.rects[0][1] - y.rects[0][1]);
          const notes = Store.list('notes', it.path).sort((x, y) => (x.page ?? 0) - (y.page ?? 0) || (x.t ?? 0) - (y.t ?? 0));
          if (!hls.length && !notes.length) continue;
          lines.push(`#### ${it.title}`, '');
          for (const x of hls) {
            lines.push(`- **p. ${x.page}** · ${colorName(x.color).toLowerCase()} — “${x.text}”`);
            if (x.note) lines.push(`  > ${x.note.replace(/\n/g, '\n  > ')}`);
          }
          for (const n of notes) {
            if (!n.text) continue;
            const where = n.t != null ? fmtTime(n.t) : `p. ${n.page}`;
            lines.push(`- **${where}** — ${n.text.replace(/\n/g, '\n  ')}`);
          }
          lines.push('');
        }
        if (lines.length) block.push(`### ${a.name}`, '', ...lines);
      }
      if (block.length) out.push(`## ${d.name}`, '', ...block);
    }
    return out.join('\n');
  }

  // ------------------------------------------------------------------ toasts
  let toastBox;
  function toast(msg, { action, onAction, ms = 4200 } = {}) {
    if (!toastBox) document.body.append((toastBox = h('div', { id: 'toasts', role: 'status', 'aria-live': 'polite' })));
    const t = h('div', { class: 'toast' }, h('span', { text: msg }));
    const close = () => {
      t.classList.add('out');
      setTimeout(() => t.remove(), 220);
    };
    if (action)
      t.append(
        h('button', {
          text: action,
          onclick: () => {
            close();
            onAction?.();
          },
        }),
      );
    toastBox.append(t);
    while (toastBox.children.length > 3) toastBox.firstChild.remove();
    setTimeout(close, ms);
  }

  // ------------------------------------------------------------------ estrutura da página
  const app = $('#app');
  const rows = { items: new Map(), aulas: new Map(), discs: new Map() };
  let current = null;
  let view = null;
  let viewToken = 0;

  const searchInput = h('input', { type: 'search', placeholder: 'Buscar aula, tema ou material', 'aria-label': 'Buscar', autocomplete: 'off', spellcheck: 'false' });
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Filtrar' });
  const overallEl = h('div', { class: 'overall' });
  const tree = h('nav', { class: 'tree', 'aria-label': 'Aulas' });
  const storeBtn = h('button', { class: 'store', type: 'button' });
  const crumbsEl = h('div', { class: 'crumbs' });
  const content = h('div', { class: 'content', id: 'content' });
  const themeBtn = h('button', { class: 'btn ghost icon', type: 'button' });
  const quando = new Date(RAW.geradoEm || Date.now()).toLocaleString('pt-BR', { dateStyle: 'long', timeStyle: 'short' });

  const side = h(
    'aside',
    { class: 'side' },
    h(
      'div',
      { class: 'side-head' },
      h(
        'div',
        { class: 'brand' },
        h('div', { class: 'brand-mark' }, icon('cap')),
        h('div', { style: { minWidth: 0 } }, h('h1', { text: 'Minhas aulas' }), h('p', { text: `Baixado em ${quando} · funciona sem internet`, title: `Baixado em ${quando}` })),
      ),
      h('label', { class: 'search' }, icon('search'), searchInput, h('kbd', { text: '/' })),
      seg,
      overallEl,
    ),
    tree,
    h('div', { class: 'side-foot' }, storeBtn),
  );
  const main = h(
    'div',
    { class: 'main' },
    h(
      'header',
      { class: 'topbar' },
      h('button', { class: 'btn ghost icon', type: 'button', title: 'Mostrar/ocultar a lista (B)', 'aria-label': 'Mostrar ou ocultar a lista de aulas', onclick: toggleSide }, icon('sidebar')),
      crumbsEl,
      h(
        'div',
        { class: 'top-actions' },
        h('button', { class: 'btn ghost icon', type: 'button', title: 'Atalhos do teclado (?)', 'aria-label': 'Atalhos do teclado', onclick: showKeys }, icon('keyboard')),
        themeBtn,
      ),
    ),
    content,
  );
  app.append(side, h('div', { class: 'backdrop-side', onclick: () => app.classList.remove('side-open') }), main);
  app.removeAttribute('aria-busy');

  const narrow = () => matchMedia('(max-width: 860px)').matches;
  function toggleSide() {
    if (narrow()) app.classList.toggle('side-open');
    else {
      prefs.side = !prefs.side;
      app.classList.toggle('side-hidden', !prefs.side);
      savePrefs();
    }
  }
  app.classList.toggle('side-hidden', !prefs.side);

  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    themeBtn.replaceChildren(icon(t === 'dark' ? 'sun' : 'moon'));
    themeBtn.title = t === 'dark' ? 'Usar modo claro' : 'Usar modo escuro';
    themeBtn.setAttribute('aria-label', themeBtn.title);
  }
  const sysDark = () => matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(document.documentElement.dataset.theme || (sysDark() ? 'dark' : 'light'));
  themeBtn.onclick = () => {
    const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(t);
    try {
      localStorage.setItem('ava-theme', t);
    } catch {}
  };

  // ------------------------------------------------------------------ status da pasta
  function renderStore() {
    const s = Folder.state;
    let cls = '';
    let title;
    let sub;
    let ic = 'folder';
    if (s === 'ready') {
      cls = 'ready';
      ic = 'folderOk';
      title = Folder.saving ? 'Salvando na pasta…' : 'Salvo na pasta';
      sub = `${STORAGE} · ${Folder.lastSaved ? fmtAgo(Folder.lastSaved) : 'conectada'}`;
    } else if (s === 'prompt') {
      cls = 'warn';
      title = 'Liberar acesso à pasta';
      sub = 'Clique para continuar salvando nela';
    } else if (s === 'error') {
      cls = 'err';
      ic = 'alert';
      title = 'Não consegui salvar na pasta';
      sub = 'Clique para tentar de novo';
    } else if (s === 'unsupported') {
      title = 'Salvo neste navegador';
      sub = 'Use Chrome ou Edge para salvar na pasta';
    } else {
      cls = 'warn';
      title = 'Conectar a pasta';
      sub = 'Para salvar progresso e anotações nela';
    }
    storeBtn.className = `store ${cls}${Folder.saving ? ' saving' : ''}`;
    storeBtn.title = s === 'error' && Folder.error ? Folder.error : '';
    storeBtn.replaceChildren(h('span', { class: 'store-ico' }, icon(ic)), h('span', { style: { minWidth: 0 } }, h('b', { text: title }), h('small', { text: sub })), h('span', { class: 'dot' }));
  }
  storeBtn.onclick = async () => {
    if (Folder.state === 'ready') return showStoreInfo();
    if (Folder.state === 'error') {
      Folder.state = 'ready';
      return Folder.write();
    }
    if (await Folder.connect()) toast('Pasta conectada. Seu progresso e suas anotações ficam salvos nela.');
  };
  setInterval(() => Folder.state === 'ready' && renderStore(), 30000);

  function modal(build) {
    const d = h('dialog', { class: 'modal' });
    const close = () => d.close();
    d.append(build(close));
    d.addEventListener('close', () => d.remove());
    d.addEventListener('click', (e) => e.target === d && close());
    document.body.append(d);
    d.showModal();
    return d;
  }
  function showStoreInfo() {
    let hl = 0;
    let notes = 0;
    for (const k in Store.d.hl) hl += Store.list('hl', k).length;
    for (const k in Store.d.notes) notes += Store.list('notes', k).length;
    modal((close) =>
      h(
        'div',
        { class: 'modal-body' },
        h('h3', { text: 'Seus dados ficam na pasta das aulas' }),
        h('p', {}, 'Progresso, destaques e notas são gravados em ', h('b', { text: `${folderName}/${STORAGE}` }), '. Se levar a pasta para outro computador, eles vão junto. Uma cópia legível fica em ', h('b', { text: 'Minhas anotações.md' }), '.'),
        h('div', { class: 'stats', style: { gridTemplateColumns: 'repeat(3, 1fr)' } }, stat('Destaques', hl), stat('Notas', notes), stat('Última gravação', Folder.lastSaved ? fmtAgo(Folder.lastSaved) : '—')),
        h(
          'div',
          { class: 'modal-actions' },
          HOST ? null : h(
            'button',
            {
              class: 'btn',
              type: 'button',
              onclick: async () => {
                close();
                Folder.handle = null;
                Folder.state = 'none';
                if (await Folder.connect()) toast('Pasta trocada.');
                renderStore();
              },
            },
            icon('folder'),
            'Escolher outra pasta',
          ),
          h('button', { class: 'btn primary', type: 'button', onclick: close }, 'Fechar'),
        ),
      ),
    );
  }
  const stat = (label, value, extra) => h('div', { class: 'stat' }, h('small', { text: label }), h('b', {}, value), extra || null);

  // ------------------------------------------------------------------ lista lateral
  const FILTERS = [
    { id: 'all', label: 'Todas' },
    { id: 'todo', label: 'Pendentes' },
    { id: 'notes', label: 'Anotadas' },
  ];
  function renderSeg() {
    seg.replaceChildren(
      ...FILTERS.map((f) =>
        h('button', {
          type: 'button',
          text: f.label,
          'aria-pressed': String(prefs.filter === f.id),
          onclick: () => {
            prefs.filter = f.id;
            savePrefs();
            renderSeg();
            renderTree();
          },
        }),
      ),
    );
  }

  const RING_C = 2 * Math.PI * 8;
  function ring(f = 0, done = false) {
    const s = svgEl('svg', { class: `ring${done ? ' ok' : ''}`, viewBox: '0 0 20 20', 'aria-hidden': 'true' });
    s.append(svgEl('circle', { class: 'bg', cx: 10, cy: 10, r: 8 }));
    const fg = svgEl('circle', { class: 'fg', cx: 10, cy: 10, r: 8, 'stroke-dasharray': RING_C.toFixed(2) });
    fg.style.strokeDashoffset = (RING_C * (1 - f)).toFixed(2);
    s.append(fg, svgEl('path', { class: 'tick', d: 'M6.3 10.4l2.4 2.4 5-5.1' }));
    return s;
  }
  function setRing(s, f, done) {
    s.classList.toggle('ok', done);
    s.querySelector('.fg').style.strokeDashoffset = (RING_C * (1 - (done ? 1 : f))).toFixed(2);
  }
  function itemMeta(it) {
    if (it.kind === 'material') return it.ext ? it.ext.toUpperCase() : 'ARQ';
    const s = Store.st(it.path);
    if (s.dur) return s.pos && !s.done && s.pos < s.dur - 5 ? `${fmtTime(s.pos)} / ${fmtTime(s.dur)}` : fmtTime(s.dur);
    return KIND[it.kind]?.short || '';
  }

  function matches(q, ...texts) {
    return !q || texts.some((t) => fold(t).includes(q));
  }
  function itemVisible(it, q, aulaHit) {
    if (prefs.filter === 'todo' && isDone(it)) return false;
    if (prefs.filter === 'notes' && !Store.count(it.path)) return false;
    return aulaHit || matches(q, it.title);
  }

  function renderTree() {
    const q = fold(searchInput.value.trim());
    const keepScroll = tree.scrollTop;
    tree.replaceChildren();
    rows.items.clear();
    rows.aulas.clear();
    rows.discs.clear();
    let shown = 0;
    for (const curso of M.cursos) {
      const cursoBox = [];
      for (const d of curso.discs) {
        const discHit = matches(q, d.name);
        const aulaEls = [];
        for (const a of d.aulas) {
          const aulaHit = discHit || matches(q, a.name);
          const its = a.items.filter((it) => itemVisible(it, q, aulaHit));
          const links = prefs.filter === 'all' ? a.links.filter((l) => aulaHit || matches(q, l.title)) : [];
          if (!its.length && !links.length) continue;
          if (prefs.filter === 'todo' && aulaProgress(a).done) continue;
          aulaEls.push(aulaRow(a, its, links, q));
          shown += its.length + links.length;
        }
        if (aulaEls.length) cursoBox.push(discRow(d, aulaEls, q));
      }
      if (cursoBox.length) {
        if (M.cursos.length > 1) tree.append(h('div', { class: 't-curso', text: curso.name }));
        tree.append(...cursoBox);
      }
    }
    if (!shown) {
      const msg = q ? `Nada encontrado para “${searchInput.value.trim()}”.` : prefs.filter === 'todo' ? 'Tudo concluído. Parabéns!' : prefs.filter === 'notes' ? 'Você ainda não fez anotações.' : 'Nenhuma aula nesta pasta.';
      tree.append(h('div', { class: 'tree-empty', text: msg }));
    }
    tree.scrollTop = keepScroll;
    updateStatus();
  }
  function discRow(d, aulaEls, q) {
    const open = q || ui.open.has(d.id);
    const count = h('span', { class: 't-disc-count' });
    const bar = h('div', { class: 'bar thin t-disc-bar' }, h('i'));
    const el = h(
      'div',
      { class: `t-disc${open ? ' open' : ''}` },
      h(
        'button',
        {
          class: 't-disc-btn',
          type: 'button',
          'aria-expanded': String(Boolean(open)),
          onclick: (e) => {
            const o = el.classList.toggle('open');
            e.currentTarget.setAttribute('aria-expanded', String(o));
            if (o) ui.open.add(d.id);
            else ui.open.delete(d.id);
            saveUi();
          },
        },
        icon('chevron', 'chev'),
        h('span', { class: 't-disc-name' }, marked(d.name, q)),
        count,
        bar,
      ),
      h('div', { class: 't-disc-body' }, aulaEls),
    );
    rows.discs.set(d.id, { el, count, bar, d });
    return el;
  }
  function aulaRow(a, its, links, q) {
    const open = q || ui.open.has(a.id);
    const r = ring();
    const check = h(
      'span',
      {
        class: 't-check',
        role: 'button',
        tabindex: '0',
        title: 'Marcar a aula inteira como concluída',
        onclick: (e) => {
          e.stopPropagation();
          const v = !aulaProgress(a).done;
          const undo = setAulaDone(a, v);
          toast(v ? `“${a.name}” concluída.` : `“${a.name}” desmarcada.`, { action: 'Desfazer', onAction: undo });
        },
        onkeydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            e.currentTarget.click();
          }
        },
      },
      r,
    );
    const el = h(
      'div',
      { class: `t-aula${open ? ' open' : ''}` },
      h(
        'button',
        {
          class: 't-aula-btn',
          type: 'button',
          'aria-expanded': String(Boolean(open)),
          onclick: (e) => {
            const o = el.classList.toggle('open');
            e.currentTarget.setAttribute('aria-expanded', String(o));
            if (o) ui.open.add(a.id);
            else ui.open.delete(a.id);
            saveUi();
          },
        },
        check,
        h('span', { class: 't-aula-name' }, marked(a.name, q)),
        icon('chevron', 'chev'),
      ),
      h('div', { class: 't-aula-body' }, its.map((it) => itemRow(it, q)), links.map((l) => linkRow(l, q))),
    );
    rows.aulas.set(a.id, { el, ring: r, a });
    return el;
  }
  function itemRow(it, q) {
    const r = ring();
    const meta = h('span', { class: 't-meta' });
    const check = h(
      'button',
      {
        class: 't-check',
        type: 'button',
        onclick: (e) => {
          e.stopPropagation();
          const v = !isDone(it);
          const undo = setDone(it, v);
          toast(v ? `“${it.title}” concluída.` : `“${it.title}” desmarcada.`, { action: 'Desfazer', onAction: undo });
        },
      },
      r,
    );
    const el = h(
      'div',
      {
        class: `t-item k-${it.kind}${it.kind === 'material' ? ' is-mat' : ''}`,
        role: 'link',
        tabindex: '0',
        title: it.title,
        onclick: () => go(it),
        onkeydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            go(it);
          }
        },
      },
      check,
      h('span', { class: `chip k-${it.kind}`, title: KIND[it.kind]?.label }, icon(it.kind === 'material' && it.view === 'image' ? 'image' : KIND[it.kind]?.icon || 'doc')),
      h('span', { class: 't-title' }, marked(it.title, q)),
      meta,
    );
    rows.items.set(it.path, { el, ring: r, meta, check, it });
    return el;
  }
  function linkRow(l, q) {
    return h(
      'a',
      { class: 't-item is-link', href: l.url, target: '_blank', rel: 'noopener noreferrer', title: `${l.title} (abre na internet)` },
      h('span', { class: 't-check' }),
      h('span', { class: 'chip k-link' }, icon('external')),
      h('span', { class: 't-title' }, marked(l.title, q)),
      h('span', { class: 't-meta', text: 'link' }),
    );
  }

  function updateStatus() {
    for (const { el, ring: r, meta, check, it } of rows.items.values()) {
      const done = isDone(it);
      setRing(r, frac(it), done);
      el.classList.toggle('done', done);
      el.classList.toggle('on', current === it);
      meta.textContent = itemMeta(it);
      check.setAttribute('aria-label', done ? `Desmarcar “${it.title}”` : `Marcar “${it.title}” como concluída`);
      check.title = done ? 'Concluída · clique para desmarcar' : 'Marcar como concluída';
    }
    for (const { el, ring: r, a } of rows.aulas.values()) {
      const p = aulaProgress(a);
      setRing(r, p.frac, p.done);
      r.parentElement.title = p.done ? 'Aula concluída · clique para desmarcar' : 'Marcar a aula inteira como concluída';
      el.classList.toggle('done', p.done);
      el.classList.toggle('has-current', current?.aula === a);
    }
    for (const { count, bar, d } of rows.discs.values()) {
      const p = discProgress(d);
      count.textContent = `${p.done}/${p.total}`;
      count.classList.toggle('all', p.done === p.total && p.total > 0);
      bar.classList.toggle('ok', p.done === p.total);
      bar.firstChild.style.width = `${Math.round(p.frac * 100)}%`;
    }
    let done = 0;
    let total = 0;
    for (const a of M.aulas) {
      if (!countsAsAula(a)) continue;
      total++;
      if (aulaProgress(a).done) done++;
    }
    overallEl.replaceChildren(
      h('div', { class: 'overall-row' }, h('span', {}, h('b', { text: String(done) }), ` de ${total} aulas concluídas`), h('span', { text: `${total ? Math.round((done / total) * 100) : 0}%` })),
      h('div', { class: 'bar' }, h('i', { style: { width: `${total ? (done / total) * 100 : 0}%` } })),
    );
  }
  onChange(() => {
    if (prefs.filter !== 'all') renderTree();
    else updateStatus();
  });

  function reveal(it) {
    let changed = false;
    for (const id of [it.disc.id, it.aula.id])
      if (!ui.open.has(id)) {
        ui.open.add(id);
        changed = true;
      }
    if (changed) saveUi();
    if (changed || !rows.items.has(it.path)) renderTree();
    else updateStatus();
    requestAnimationFrame(() => rows.items.get(it.path)?.el.scrollIntoView({ block: 'nearest' }));
  }

  searchInput.addEventListener('input', debounce(renderTree, 120));
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      searchInput.value = '';
      renderTree();
      searchInput.blur();
    } else if (e.key === 'Enter') {
      const first = tree.querySelector('.t-item[role="link"]');
      if (first) first.click();
    }
  });

  // ------------------------------------------------------------------ navegação
  function setCrumbs(parts) {
    crumbsEl.replaceChildren(h('a', { href: '#/', title: 'Início' }, icon('home')));
    for (const p of parts) {
      crumbsEl.append(icon('chevron', 'sep'));
      if (p.last) crumbsEl.append(h('span', { class: 'cur', text: p.text, title: p.text }));
      else crumbsEl.append(h('button', { class: 'crumb', type: 'button', text: p.text, title: p.text, onclick: p.onclick }));
    }
  }
  function go(it) {
    const hash = `#/i/${encodeURIComponent(it.path)}`;
    if (location.hash === hash) route();
    else location.hash = hash;
  }
  function destroyView() {
    viewToken++;
    try {
      view?.destroy?.();
    } catch {}
    view = null;
    closePops();
    content.replaceChildren();
    content.className = 'content';
    content.scrollTop = 0;
  }
  function route() {
    const m = /^#\/i\/(.+)$/.exec(location.hash);
    let it = null;
    if (m) {
      try {
        it = M.byPath.get(decodeURIComponent(m[1])) || null;
      } catch {}
    }
    destroyView();
    if (narrow()) app.classList.remove('side-open');
    if (!it) {
      current = null;
      document.title = 'Minhas aulas';
      updateStatus();
      return showHome();
    }
    current = it;
    Store.setLast(it.path);
    document.title = `${it.title} · Minhas aulas`;
    reveal(it);
    const discAula = (a) => () => {
      const first = a.items.find((x) => !isDone(x)) || a.items[0];
      if (first) go(first);
    };
    setCrumbs([{ text: it.disc.name, onclick: discAula(it.disc.aulas[0]) }, { text: it.aula.name, onclick: discAula(it.aula) }, { text: it.title, last: true }]);
    if (isMedia(it)) showMedia(it);
    else if (it.view === 'pdf') showPdf(it);
    else if (it.view === 'image') showImage(it);
    else if (it.view === 'docx' || it.view === 'doc') showWord(it);
    else showFile(it);
  }
  window.addEventListener('hashchange', route);

  const neighbors = (it) => {
    let prev = null;
    let next = null;
    for (let j = it.order - 1; j >= 0 && !prev; j--) prev = M.items[j];
    for (let j = it.order + 1; j < M.items.length && !next; j++) next = M.items[j];
    return { prev, next };
  };
  /** Próximo vídeo para tocar sozinho: mesmo tipo (vídeo, áudio ou Libras), sem repetir a mesma gravação. */
  function nextAuto(it) {
    const fam = (x) => (x.kind === 'audio' ? 'a' : x.kind === 'libras' ? 'l' : x.kind === 'material' ? null : 'v');
    const f = fam(it);
    for (let j = it.order + 1; j < M.items.length; j++) {
      const n = M.items[j];
      if (!isMedia(n) || fam(n) !== f) continue;
      if (it.kind === 'completo' && n.aula === it.aula && n.kind === 'video') continue;
      return n;
    }
    return null;
  }

  // ------------------------------------------------------------------ início
  function showHome() {
    setCrumbs([]);
    const wrap = h('div', { class: 'home' });
    content.append(wrap);
    const draw = () => {
      let done = 0;
      let total = 0;
      let seconds = 0;
      let annots = 0;
      for (const a of M.aulas) {
        if (!countsAsAula(a)) continue;
        total++;
        if (aulaProgress(a).done) done++;
      }
      for (const it of M.items) {
        const s = Store.st(it.path);
        if (isMedia(it) && s.dur) seconds += s.done ? s.dur : s.pos || 0;
        annots += Store.count(it.path);
      }
      const discDone = M.discs.filter((d) => {
        const p = discProgress(d);
        return p.total && p.done === p.total;
      }).length;

      const last = Store.d.last && M.byPath.get(Store.d.last.path);
      const resumeIt = last && !isDone(last) ? last : last ? nextPending(last.disc) || nextAuto(last) : M.discs.map(nextPending).find(Boolean);
      const parts = [
        h('div', { class: 'home-hello' }, h('h2', { text: last ? 'De volta aos estudos' : 'Bons estudos!' }), h('p', { text: `${plural(M.discs.length, 'disciplina', 'disciplinas')} · ${plural(total, 'aula', 'aulas')} · baixado em ${quando}` })),
      ];
      if (resumeIt) parts.push(resumeCard(resumeIt, Boolean(last)));
      parts.push(
        h(
          'div',
          { class: 'stats' },
          stat('Aulas concluídas', h('span', {}, String(done), h('span', { text: ` / ${total}` })), h('div', { class: 'bar' }, h('i', { style: { width: `${total ? (done / total) * 100 : 0}%` } }))),
          stat('Disciplinas concluídas', h('span', {}, String(discDone), h('span', { text: ` / ${M.discs.length}` }))),
          stat('Tempo assistido', seconds ? fmtDur(seconds) : '0 min'),
          stat('Destaques e notas', String(annots)),
        ),
      );
      if (Folder.state === 'none' || Folder.state === 'prompt') parts.push(connectCard());
      parts.push(
        h('section', {}, h('div', { class: 'sec-title' }, h('h3', { text: 'Disciplinas' }), h('small', { text: 'Clique para continuar de onde parou' })), h('div', { class: 'cards' }, M.discs.map(discCard))),
      );
      const recent = recentAnnotations();
      if (recent.length) parts.push(h('section', {}, h('div', { class: 'sec-title' }, h('h3', { text: 'Anotações recentes' })), h('div', { class: 'recent' }, recent)));
      wrap.replaceChildren(...parts);
    };
    draw();
    const redraw = debounce(draw, 200);
    onChange(redraw);
    view = { destroy: () => listeners.delete(redraw) };
  }
  function resumeCard(it, isResume) {
    const s = Store.st(it.path);
    const f = frac(it);
    const where = isMedia(it) && s.pos && s.dur ? `Parou em ${fmtTime(s.pos)} de ${fmtTime(s.dur)}` : it.view === 'pdf' && s.page ? `Parou na página ${s.page} de ${s.pages}` : null;
    const art = h('div', { class: `resume-art k-${it.view === 'audio' ? 'audio' : it.kind === 'material' ? 'material' : 'video'}` }, icon(it.kind === 'material' ? 'doc' : it.view === 'audio' ? 'headphones' : 'play'), f > 0 ? h('div', { class: 'bar' }, h('i', { style: { width: `${f * 100}%` } })) : null);
    return h(
      'div',
      { class: 'resume', role: 'link', tabindex: '0', onclick: () => go(it), onkeydown: (e) => e.key === 'Enter' && go(it) },
      art,
      h('div', { style: { minWidth: 0 } }, h('div', { class: 'eyebrow', text: isResume && f > 0 ? 'Continue de onde parou' : 'Próximo passo' }), h('h3', { text: it.title }), h('p', { text: `${it.disc.name} · ${it.aula.name}` }), where ? h('p', { text: where, style: { marginTop: '6px', color: 'var(--text-2)' } }) : null),
      h('button', { class: 'btn primary lg', type: 'button', tabindex: '-1' }, icon(it.kind === 'material' ? 'book' : 'play'), f > 0 ? 'Continuar' : 'Começar'),
    );
  }
  function connectCard() {
    const prompt = Folder.state === 'prompt';
    return h(
      'div',
      { class: 'card connect-card' },
      h('div', { class: 'big-ico' }, icon('folder')),
      h('div', {}, h('h4', { text: prompt ? 'Libere o acesso à pasta para continuar salvando nela' : 'Salve seu progresso e suas anotações na pasta' }), h('p', { text: prompt ? 'O navegador pede de novo a cada vez que a página é aberta. Um clique resolve.' : `Escolha a pasta “${folderName}” uma vez. Isso também libera o leitor de PDF com destaques e notas.` })),
      h(
        'button',
        {
          class: 'btn primary',
          type: 'button',
          onclick: async () => {
            if (await Folder.connect()) toast('Pasta conectada.');
          },
        },
        icon('folderOk'),
        prompt ? 'Liberar acesso' : 'Conectar pasta',
      ),
    );
  }
  function discCard(d) {
    const p = discProgress(d);
    const nx = nextPending(d);
    const all = p.total && p.done === p.total;
    return h(
      'button',
      { class: `card disc-card${all ? ' all' : ''}`, type: 'button', onclick: () => go(nx || d.aulas[0].items[0] || M.items[0]) },
      h('div', { class: 'row' }, h('span', { text: M.cursos.length > 1 ? d.curso.name : `${plural(p.total, 'aula', 'aulas')}` }), h('span', { text: `${Math.round(p.frac * 100)}%` })),
      h('h4', { text: d.name }),
      h('div', { class: `bar${all ? ' ok' : ''}` }, h('i', { style: { width: `${p.frac * 100}%` } })),
      h('div', { class: 'next' }, icon(all ? 'check' : 'play'), h('span', { text: all ? 'Tudo concluído' : nx ? `${nx.aula.name} · ${nx.title}` : 'Começar' })),
    );
  }
  function recentAnnotations() {
    const all = [];
    for (const it of M.items) {
      for (const x of Store.list('hl', it.path)) all.push({ it, at: x.at, color: `var(--hl-${x.color})`, text: x.note ? `${x.note} — “${x.text}”` : x.text, where: `p. ${x.page}`, page: x.page });
      for (const n of Store.list('notes', it.path)) if (n.text) all.push({ it, at: n.at, color: 'var(--brand)', text: n.text, where: n.t != null ? fmtTime(n.t) : `p. ${n.page}`, t: n.t, page: n.page });
    }
    return all
      .sort((a, b) => b.at - a.at)
      .slice(0, 6)
      .map((x) =>
        h(
          'div',
          {
            class: 'recent-item',
            role: 'link',
            tabindex: '0',
            onclick: () => {
              pendingJump = { path: x.it.path, t: x.t, page: x.page };
              go(x.it);
            },
          },
          h('span', { class: 'sw', style: { background: x.color } }),
          h('div', { style: { minWidth: 0 } }, h('q', { text: x.text }), h('small', { text: `${x.it.title} · ${x.where}` })),
          h('time', { text: fmtAgo(x.at) }),
        ),
      );
  }
  let pendingJump = null;
  const takeJump = (it) => {
    const j = pendingJump && pendingJump.path === it.path ? pendingJump : null;
    pendingJump = null;
    return j;
  };

  // ------------------------------------------------------------------ cabeçalho comum (concluída, anterior, próxima)
  function doneButton(it) {
    const b = h('button', { class: 'btn', type: 'button' });
    const draw = () => {
      const d = isDone(it);
      b.className = `btn${d ? ' done' : ''}`;
      b.replaceChildren(icon('check'), h('span', { class: 'lbl', text: d ? (it.kind === 'material' ? 'Lido' : 'Concluída') : it.kind === 'material' ? 'Marcar como lido' : 'Marcar como concluída' }));
      b.title = d ? 'Clique para desmarcar' : 'Marcar como concluída';
    };
    b.onclick = () => setDone(it, !isDone(it));
    draw();
    return { el: b, draw };
  }
  function navButtons(it) {
    const { prev, next } = neighbors(it);
    return [
      h('button', { class: 'btn icon', type: 'button', title: prev ? `Anterior: ${prev.title} (Shift+P)` : 'Início da lista', disabled: !prev, onclick: () => prev && go(prev), 'aria-label': 'Anterior' }, icon('left')),
      h('button', { class: 'btn', type: 'button', title: next ? `Próxima: ${next.title} (Shift+N)` : 'Fim da lista', disabled: !next, onclick: () => next && go(next) }, 'Próxima', icon('right')),
    ];
  }

  // ------------------------------------------------------------------ vídeo / áudio
  function showMedia(it) {
    const jump = takeJump(it);
    const wrap = h('div', { class: 'lesson' });
    content.append(wrap);
    const notes = notesPanel(it);
    const player = createPlayer(it, { jump, onNote: () => notes.focus(), onTime: (t) => notes.time(t) });
    notes.attach(player);
    const done = doneButton(it);
    const alts = family(it).filter(isMedia);
    const mats = it.aula.items.filter((x) => x.kind === 'material');
    const chips = [];
    if (alts.length) {
      chips.push(h('span', { text: 'Também em:' }));
      for (const a of alts) chips.push(h('button', { class: 'alt', type: 'button', onclick: () => go(a) }, icon(KIND[a.kind].icon), KIND[a.kind].label));
    }
    if (mats.length) {
      chips.push(h('span', { text: alts.length ? ' · Materiais:' : 'Materiais desta aula:' }));
      for (const m of mats.slice(0, 6)) chips.push(h('button', { class: 'alt', type: 'button', title: m.title, onclick: () => go(m), style: { color: 'var(--doc)' } }, icon('doc'), m.title.length > 34 ? m.title.slice(0, 32) + '…' : m.title));
    }
    wrap.append(
      player.el,
      h(
        'div',
        { class: 'lesson-head' },
        h('div', { style: { minWidth: 0 } }, h('h2', { text: it.title }), h('p', { text: `${it.disc.name} · ${it.aula.name}` })),
        h('div', { class: 'lesson-actions' }, done.el, ...navButtons(it)),
      ),
      chips.length ? h('div', { class: 'alts' }, chips) : null,
      notes.el,
    );
    onChange(done.draw);
    view = {
      destroy: () => {
        listeners.delete(done.draw);
        player.destroy();
      },
      key: (e) => player.key(e),
    };
  }

  function createPlayer(it, { jump, onNote, onTime }) {
    const audio = it.view === 'audio';
    const v = document.createElement(audio ? 'audio' : 'video');
    v.preload = 'metadata';
    v.playsInline = true;
    let objUrl = null;
    if (HOST)
      Folder.file(it.path).then(
        (f) => {
          if (destroyed) return;
          objUrl = URL.createObjectURL(f);
          v.src = objUrl;
          v.play().catch(() => {});
        },
        () => v.dispatchEvent(new Event('error')),
      );
    else v.src = it.href;
    v.volume = clamp(prefs.volume, 0, 1);
    v.muted = prefs.muted;
    const st0 = Store.st(it.path);

    const prog = h('i', { class: 'vp-prog' });
    const buf = h('i', { class: 'vp-buf' });
    const hov = h('i', { class: 'vp-hover' });
    const knob = h('b', { class: 'vp-knob' });
    const marks = h('span');
    const tip = h('div', { class: 'vp-tip' });
    const rail = h('div', { class: 'vp-rail' }, buf, hov, prog, marks, knob);
    const seek = h('div', { class: 'vp-seek', role: 'slider', tabindex: '0', 'aria-label': 'Posição' }, rail, tip);
    const playBtn = h('button', { class: 'vb play', type: 'button', 'aria-label': 'Reproduzir (K)', title: 'Reproduzir (K)' }, icon('play'));
    const time = h('div', { class: 'vp-time' });
    const volBtn = h('button', { class: 'vb', type: 'button', 'aria-label': 'Som (M)', title: 'Som (M)' });
    const volIn = h('input', { type: 'range', min: '0', max: '1', step: '0.02', 'aria-label': 'Volume' });
    const speedBtn = h('button', { class: 'vb speed', type: 'button', title: 'Velocidade', 'aria-haspopup': 'menu' });
    const menu = h('div', { class: 'vp-menu', role: 'menu' });
    const noteBtn = h('button', { class: 'vb', type: 'button', title: 'Anotar neste momento (N)', 'aria-label': 'Anotar neste momento' }, icon('note'));
    const pipBtn = !audio && document.pictureInPictureEnabled ? h('button', { class: 'vb', type: 'button', title: 'Janela flutuante (I)', 'aria-label': 'Janela flutuante' }, icon('pip')) : null;
    const fsBtn = h('button', { class: 'vb', type: 'button', title: 'Tela cheia (F)', 'aria-label': 'Tela cheia' }, icon('full'));
    const center = h('button', { class: 'vp-center', type: 'button', 'aria-label': 'Reproduzir' }, icon('play'));
    const flash = h('div', { class: 'vp-flash' });
    const ctrl = h(
      'div',
      { class: 'vp-ctrl' },
      seek,
      h(
        'div',
        { class: 'vp-row' },
        playBtn,
        h('button', { class: 'vb', type: 'button', title: 'Voltar 10 s (J)', 'aria-label': 'Voltar 10 segundos', onclick: () => skip(-10) }, icon('back10')),
        h('button', { class: 'vb', type: 'button', title: 'Avançar 10 s (L)', 'aria-label': 'Avançar 10 segundos', onclick: () => skip(10) }, icon('fwd10')),
        h('div', { class: 'vp-vol' }, volBtn, volIn),
        time,
        h('div', { class: 'grow' }),
        speedBtn,
        noteBtn,
        pipBtn,
        fsBtn,
      ),
      menu,
    );
    const root = h(
      'div',
      { class: `vp${audio ? ' audio' : ''}`, tabindex: '0', 'aria-label': `Player: ${it.title}` },
      v,
      audio ? h('div', { class: 'vp-art' }, h('div', { class: 'disc' }, icon('headphones')), h('div', { style: { minWidth: 0 } }, h('h4', { text: it.title }), h('p', { text: `${it.disc.name} · ${it.aula.name}` }), h('div', { class: 'eq' }, h('i'), h('i'), h('i'), h('i'), h('i')))) : null,
      h('div', { class: 'vp-shade' }),
      h('div', { class: 'vp-top', text: it.title }),
      h('div', { class: 'vp-spin' }),
      center,
      flash,
      ctrl,
    );

    let dragging = false;
    let idleTimer = 0;
    let savedAt = 0;
    let markedDone = isDone(it);
    let nextTimer = null;
    let destroyed = false;
    // Só grava a posição depois que o vídeo carregou: sair antes (ou arquivo sumido) não zera o "onde parei".
    let loaded = false;
    const dur = () => (isFinite(v.duration) ? v.duration : st0.dur || 0);

    function save(force = false) {
      if (!loaded || !dur() || destroyed) return;
      const now = Date.now();
      if (!force && now - savedAt < 4000) return;
      savedAt = now;
      Store.set(it.path, { pos: Math.round(v.currentTime), dur: Math.round(dur()) }, { quiet: true });
      const row = rows.items.get(it.path);
      if (row) {
        setRing(row.ring, frac(it), isDone(it));
        row.meta.textContent = itemMeta(it);
      }
    }
    function drawTime() {
      const d = dur();
      const f = d ? v.currentTime / d : 0;
      if (!dragging) {
        prog.style.width = `${f * 100}%`;
        knob.style.left = `${f * 100}%`;
      }
      time.replaceChildren(fmtTime(v.currentTime), h('span', { text: ` / ${fmtTime(d)}` }));
      seek.setAttribute('aria-valuetext', `${fmtTime(v.currentTime)} de ${fmtTime(d)}`);
      if (v.buffered.length) {
        let end = 0;
        for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 1) end = Math.max(end, v.buffered.end(i));
        buf.style.width = `${d ? (end / d) * 100 : 0}%`;
      }
    }
    function drawPlay() {
      const p = !v.paused && !v.ended;
      root.classList.toggle('playing', p);
      playBtn.replaceChildren(icon(p ? 'pause' : 'play'));
      playBtn.title = p ? 'Pausar (K)' : 'Reproduzir (K)';
      playBtn.setAttribute('aria-label', playBtn.title);
    }
    function drawVol() {
      const m = v.muted || v.volume === 0;
      volBtn.replaceChildren(icon(m ? 'mute' : v.volume < 0.5 ? 'volLow' : 'vol'));
      volIn.value = String(m ? 0 : v.volume);
      volIn.style.setProperty('--v', `${(m ? 0 : v.volume) * 100}%`);
    }
    function drawSpeed() {
      speedBtn.textContent = `${String(v.playbackRate).replace('.', ',')}×`;
    }
    function drawMarks(list) {
      marks.replaceChildren();
      const d = dur();
      if (!d) return;
      for (const n of list) if (n.t != null) marks.append(h('i', { class: 'vp-mark', style: { left: `${clamp(n.t / d, 0, 1) * 100}%` } }));
    }
    function showFlash(name, text) {
      flash.replaceChildren(name ? icon(name) : h('span', { text }));
      flash.classList.remove('go');
      void flash.offsetWidth;
      flash.classList.add('go');
    }
    function toggle() {
      if (nextTimer) cancelNext();
      if (v.paused || v.ended) v.play().catch(() => {});
      else v.pause();
    }
    function skip(s) {
      v.currentTime = clamp(v.currentTime + s, 0, dur() || 0);
      showFlash(null, `${s > 0 ? '+' : '−'}${Math.abs(s)} s`);
      wake();
    }
    function setVol(x) {
      v.volume = clamp(x, 0, 1);
      v.muted = v.volume === 0;
      prefs.volume = v.volume;
      prefs.muted = v.muted;
      savePrefs();
    }
    function setSpeed(r) {
      v.playbackRate = r;
      v.defaultPlaybackRate = r;
      prefs.speed = r;
      savePrefs();
      drawSpeed();
      showFlash(null, `${String(r).replace('.', ',')}×`);
    }
    function wake() {
      root.classList.remove('idle');
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (!v.paused && !menu.classList.contains('open') && !dragging) root.classList.add('idle');
      }, 2600);
    }
    function fracAt(e) {
      const r = rail.getBoundingClientRect();
      return clamp((e.clientX - r.left) / r.width, 0, 1);
    }
    function pill(text, action, fn, ms = 7000) {
      root.querySelector('.vp-pill')?.remove();
      const p = h('div', { class: 'vp-pill' }, h('span', { text }), action ? h('button', { type: 'button', text: action, onclick: (e) => (e.stopPropagation(), fn(), p.remove()) }) : null);
      root.append(p);
      setTimeout(() => p.remove(), ms);
    }

    // seek
    seek.addEventListener('pointermove', (e) => {
      const f = fracAt(e);
      const d = dur();
      hov.style.width = `${f * 100}%`;
      tip.style.left = `${clamp(f * 100, 4, 96)}%`;
      const t = f * d;
      const near = notesNear(t, d);
      tip.replaceChildren(fmtTime(t), near ? h('small', { text: near.text }) : null);
      if (dragging) {
        prog.style.width = `${f * 100}%`;
        knob.style.left = `${f * 100}%`;
      }
    });
    seek.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      seek.classList.add('drag');
      seek.setPointerCapture(e.pointerId);
      const f = fracAt(e);
      prog.style.width = `${f * 100}%`;
      knob.style.left = `${f * 100}%`;
    });
    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      seek.classList.remove('drag');
      v.currentTime = fracAt(e) * dur();
      save(true);
    };
    seek.addEventListener('pointerup', endDrag);
    seek.addEventListener('pointercancel', () => {
      dragging = false;
      seek.classList.remove('drag');
    });
    seek.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        skip(e.key === 'ArrowLeft' ? -5 : 5);
      }
    });
    let noteList = [];
    const notesNear = (t, d) => noteList.find((n) => n.t != null && Math.abs(n.t - t) < Math.max(3, d * 0.008));

    playBtn.onclick = toggle;
    center.onclick = (e) => (e.stopPropagation(), toggle());
    volBtn.onclick = () => {
      if (v.muted || v.volume === 0) {
        v.muted = false;
        if (v.volume === 0) v.volume = 0.6;
      } else v.muted = true;
      prefs.muted = v.muted;
      prefs.volume = v.volume;
      savePrefs();
    };
    volIn.oninput = () => setVol(Number(volIn.value));
    speedBtn.onclick = (e) => {
      e.stopPropagation();
      menu.classList.toggle('open');
      menu.replaceChildren(
        h('h5', { text: 'Velocidade' }),
        ...[0.75, 1, 1.25, 1.5, 1.75, 2, 2.5].map((r) =>
          h('button', {
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': String(v.playbackRate === r),
            text: r === 1 ? 'Normal' : `${String(r).replace('.', ',')}×`,
            onclick: () => {
              setSpeed(r);
              menu.classList.remove('open');
            },
          }),
        ),
        h('h5', { text: 'Ao terminar', style: { marginTop: '8px' } }),
        h('button', {
          type: 'button',
          role: 'menuitemcheckbox',
          'aria-checked': String(prefs.autoplay),
          text: 'Tocar a próxima',
          onclick: () => {
            prefs.autoplay = !prefs.autoplay;
            savePrefs();
            menu.classList.remove('open');
          },
        }),
      );
    };
    noteBtn.onclick = () => onNote?.();
    if (pipBtn)
      pipBtn.onclick = () => {
        if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
        else v.requestPictureInPicture().catch(() => {});
      };
    const toggleFs = () => {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else root.requestFullscreen().catch(() => {});
    };
    fsBtn.onclick = toggleFs;
    const onFs = () => {
      const on = document.fullscreenElement === root;
      fsBtn.replaceChildren(icon(on ? 'unfull' : 'full'));
      fsBtn.title = on ? 'Sair da tela cheia (F)' : 'Tela cheia (F)';
    };
    document.addEventListener('fullscreenchange', onFs);

    // clique no vídeo: play/pause; duplo clique: tela cheia
    v.addEventListener('click', () => {
      menu.classList.remove('open');
      toggle();
      showFlash(v.paused ? 'pause' : 'play');
    });
    v.addEventListener('dblclick', toggleFs);
    root.addEventListener('pointermove', wake);
    root.addEventListener('pointerleave', () => {
      if (!v.paused) root.classList.add('idle');
    });
    root.addEventListener('click', (e) => {
      if (!menu.contains(e.target) && e.target !== speedBtn) menu.classList.remove('open');
    });

    v.addEventListener('loadedmetadata', () => {
      loaded = true;
      v.playbackRate = prefs.speed || 1;
      v.defaultPlaybackRate = v.playbackRate;
      drawSpeed();
      const d = v.duration;
      if (jump?.t != null) v.currentTime = clamp(jump.t, 0, d);
      else if (st0.pos > 5 && st0.pos < d - 10) {
        v.currentTime = st0.pos;
        pill(`Continuando de ${fmtTime(st0.pos)}`, 'Recomeçar', () => (v.currentTime = 0));
      }
      if (!st0.dur || Math.round(d) !== st0.dur) Store.set(it.path, { dur: Math.round(d) }, { quiet: true });
      drawMarks(noteList);
      drawTime();
    });
    v.addEventListener('timeupdate', () => {
      drawTime();
      onTime?.(v.currentTime);
      save();
      if (!markedDone && dur() && v.currentTime / dur() >= 0.92) {
        markedDone = true;
        setDone(it, true);
      }
    });
    v.addEventListener('progress', drawTime);
    v.addEventListener('play', () => (drawPlay(), wake()));
    v.addEventListener('pause', () => (drawPlay(), save(true), root.classList.remove('idle')));
    v.addEventListener('waiting', () => root.classList.add('waiting'));
    v.addEventListener('playing', () => root.classList.remove('waiting'));
    v.addEventListener('canplay', () => root.classList.remove('waiting'));
    v.addEventListener('seeked', () => save(true));
    v.addEventListener('volumechange', drawVol);
    v.addEventListener('ended', () => {
      drawPlay();
      save(true);
      if (!markedDone) {
        markedDone = true;
        setDone(it, true);
      }
      const nx = nextAuto(it);
      if (prefs.autoplay && nx) upNext(nx);
    });
    v.addEventListener('error', () => {
      loaded = false;
      const yt = it.url;
      root.append(
        h(
          'div',
          { class: 'vp-error' },
          h(
            'div',
            {},
            icon('alert'),
            h('h4', { text: 'Não consegui abrir este arquivo' }),
            h('p', { text: yt ? 'O vídeo do YouTube não está nesta pasta. Baixe de novo pela extensão ou assista online.' : 'Ele pode ter sido movido, renomeado ou apagado da pasta.' }),
            yt ? h('a', { href: yt, target: '_blank', rel: 'noopener noreferrer', text: 'Abrir no YouTube ↗' }) : h('p', { text: it.path, style: { fontSize: '12px', wordBreak: 'break-all' } }),
          ),
        ),
      );
    });

    function upNext(nx) {
      const C = 2 * Math.PI * 33;
      const circ = svgEl('circle', { cx: 36, cy: 36, r: 33, 'stroke-dasharray': C.toFixed(2), 'stroke-dashoffset': '0' });
      const svg = svgEl('svg', { viewBox: '0 0 72 72', width: 72, height: 72 });
      svg.append(circ);
      const box = h(
        'div',
        { class: 'vp-next' },
        h(
          'div',
          { class: 'vp-next-card' },
          h('small', { text: 'A seguir' }),
          h('button', { class: 'vp-next-ring', type: 'button', 'aria-label': 'Assistir agora', onclick: () => go(nx) }, svg, icon('play')),
          h('h4', { text: nx.title }),
          h('p', { text: nx.aula === it.aula ? nx.aula.name : `${nx.disc.name} · ${nx.aula.name}` }),
          h('div', { class: 'vp-next-actions' }, h('button', { type: 'button', text: 'Cancelar', onclick: cancelNext }), h('button', { class: 'go', type: 'button', text: 'Assistir agora', onclick: () => go(nx) })),
        ),
      );
      root.append(box);
      const total = 8000;
      const t0 = performance.now();
      const tick = () => {
        const f = clamp((performance.now() - t0) / total, 0, 1);
        circ.setAttribute('stroke-dashoffset', (C * f).toFixed(2));
        if (f >= 1) return go(nx);
        nextTimer = requestAnimationFrame(tick);
      };
      nextTimer = requestAnimationFrame(tick);
    }
    function cancelNext() {
      cancelAnimationFrame(nextTimer);
      nextTimer = null;
      root.querySelector('.vp-next')?.remove();
    }

    drawPlay();
    drawVol();
    drawSpeed();
    drawTime();
    v.play().catch(() => {});

    const onHide = () => save(true);
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onHide);

    return {
      el: root,
      time: () => v.currentTime,
      seek: (t, play = true) => {
        v.currentTime = clamp(t, 0, dur() || t);
        if (play) v.play().catch(() => {});
        root.focus({ preventScroll: true });
      },
      pause: () => v.pause(),
      setMarks: (list) => {
        noteList = list;
        drawMarks(list);
      },
      key(e) {
        if (e.ctrlKey || e.metaKey || e.altKey) return false;
        const k = e.key;
        if (k === ' ' || k === 'k' || k === 'K') toggle(), showFlash(v.paused ? 'pause' : 'play');
        else if (k === 'j' || k === 'J') skip(-10);
        else if (k === 'l' || k === 'L') skip(10);
        else if (k === 'ArrowLeft') skip(-5);
        else if (k === 'ArrowRight') skip(5);
        else if (k === 'ArrowUp') setVol(v.volume + 0.05), showFlash(null, `${Math.round(v.volume * 100)}%`);
        else if (k === 'ArrowDown') setVol(v.volume - 0.05), showFlash(null, `${Math.round(v.volume * 100)}%`);
        else if (k === 'm' || k === 'M') volBtn.click();
        else if (k === 'f' || k === 'F') toggleFs();
        else if ((k === 'i' || k === 'I') && pipBtn) pipBtn.click();
        else if (k === 'n') onNote?.();
        else if (k === '>' || (k === '.' && e.shiftKey)) setSpeed(Math.min(3, Math.round((v.playbackRate + 0.25) * 100) / 100));
        else if (k === '<' || (k === ',' && e.shiftKey)) setSpeed(Math.max(0.5, Math.round((v.playbackRate - 0.25) * 100) / 100));
        else if (/^[0-9]$/.test(k) && dur()) v.currentTime = (Number(k) / 10) * dur();
        else if (k === 'Home') v.currentTime = 0;
        else if (k === 'End' && dur()) v.currentTime = dur() - 1;
        else return false;
        wake();
        return true;
      },
      destroy() {
        save(true);
        destroyed = true;
        cancelNext();
        clearTimeout(idleTimer);
        document.removeEventListener('fullscreenchange', onFs);
        window.removeEventListener('pagehide', onHide);
        document.removeEventListener('visibilitychange', onHide);
        if (document.pictureInPictureElement === v) document.exitPictureInPicture().catch(() => {});
        if (document.fullscreenElement === root) document.exitFullscreen().catch(() => {});
        v.pause();
        v.removeAttribute('src');
        v.load();
        if (objUrl) URL.revokeObjectURL(objUrl);
      },
    };
  }

  // ------------------------------------------------------------------ notas com tempo (vídeo/áudio)
  function notesPanel(it) {
    let player = null;
    let stamp = 0;
    let typing = false;
    const count = h('span', { class: 'count' });
    const tbtn = h('button', { class: 'tstamp', type: 'button', title: 'A nota fica neste momento do vídeo' }, icon('clock'), h('span', { text: '0:00' }));
    const ta = h('textarea', { class: 'field', rows: '1', placeholder: 'Escreva uma nota sobre este momento…  (Enter salva · Shift+Enter quebra a linha)', 'aria-label': 'Nova nota' });
    const add = h('button', { class: 'btn primary', type: 'button' }, icon('plus'), 'Salvar');
    const list = h('ul', { class: 'notes-list' });
    const emptyMsg = h('p', { class: 'empty-note', text: 'Suas notas aparecem aqui, em ordem de tempo, e viram marcas amarelas na barra do vídeo. Atalho: N.' });
    const el = h(
      'section',
      { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h3', {}, icon('note'), 'Minhas anotações', count), h('small', { style: { color: 'var(--muted)', fontSize: '12px' } }, h('kbd', { text: 'N' }), ' anota no tempo atual')),
      h('div', { class: 'note-new' }, tbtn, ta, add),
      list,
      emptyMsg,
    );
    const grow = () => {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(200, ta.scrollHeight + 2)}px`;
    };
    const setStamp = (t) => {
      stamp = t;
      tbtn.lastChild.textContent = fmtTime(t);
    };
    ta.addEventListener('focus', () => {
      typing = true;
      if (player) setStamp(player.time());
    });
    ta.addEventListener('blur', () => (typing = ta.value.trim().length > 0));
    ta.addEventListener('input', grow);
    tbtn.onclick = () => player?.seek(stamp);
    const save = () => {
      const text = ta.value.trim();
      if (!text) return;
      Store.upsert('notes', it.path, { id: uid(), t: Math.round(stamp * 10) / 10, text });
      ta.value = '';
      typing = false;
      grow();
      draw();
    };
    add.onclick = save;
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        save();
      } else if (e.key === 'Escape') {
        ta.blur();
        player?.el.focus();
      }
    });
    function draw() {
      const notes = Store.list('notes', it.path).sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
      count.textContent = String(notes.length);
      emptyMsg.hidden = notes.length > 0;
      player?.setMarks(notes);
      list.replaceChildren(
        ...notes.map((n) => {
          const txt = h('div', { class: 'txt', text: n.text });
          const edit = () => {
            txt.contentEditable = 'plaintext-only';
            txt.focus();
            getSelection().selectAllChildren(txt);
            getSelection().collapseToEnd();
          };
          const commit = () => {
            if (!txt.isContentEditable) return;
            txt.contentEditable = 'false';
            const v = txt.innerText.trim();
            if (!v) Store.remove('notes', it.path, n.id);
            else if (v !== n.text) Store.upsert('notes', it.path, { id: n.id, text: v });
            draw();
          };
          txt.addEventListener('blur', commit);
          txt.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              txt.blur();
            } else if (e.key === 'Escape') {
              txt.textContent = n.text;
              txt.blur();
            }
          });
          txt.addEventListener('dblclick', edit);
          return h(
            'li',
            {},
            h('button', { class: 'tstamp', type: 'button', title: 'Ir para este momento', onclick: () => player?.seek(n.t) }, icon('play'), fmtTime(n.t)),
            txt,
            h(
              'div',
              { class: 'acts' },
              h('button', { class: 'btn ghost sm icon', type: 'button', title: 'Editar', 'aria-label': 'Editar nota', onclick: edit }, icon('pen')),
              h(
                'button',
                {
                  class: 'btn ghost sm icon',
                  type: 'button',
                  title: 'Apagar',
                  'aria-label': 'Apagar nota',
                  onclick: () => {
                    Store.remove('notes', it.path, n.id);
                    draw();
                    toast('Nota apagada.', { action: 'Desfazer', onAction: () => (Store.upsert('notes', it.path, { ...n, del: false }), draw()) });
                  },
                },
                icon('trash'),
              ),
            ),
          );
        }),
      );
    }
    draw();
    return {
      el,
      attach(p) {
        player = p;
        draw();
      },
      focus() {
        if (player) setStamp(player.time());
        typing = true;
        ta.focus({ preventScroll: true });
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      },
      time(t) {
        if (!typing) setStamp(t);
      },
    };
  }

  // ------------------------------------------------------------------ popovers
  let popEl = null;
  let popClose = null;
  function closePops() {
    const fn = popClose;
    popEl?.remove();
    popEl = null;
    popClose = null;
    fn?.();
  }
  function openPop(el, r, onClose) {
    closePops();
    popEl = el;
    popClose = onClose || null;
    (document.fullscreenElement || document.body).append(el);
    const pw = el.offsetWidth;
    const ph = el.offsetHeight;
    let top = r.top - ph - 10;
    if (top < 8) top = r.bottom + 10;
    el.style.left = `${clamp(r.left + r.width / 2 - pw / 2, 8, innerWidth - pw - 8)}px`;
    el.style.top = `${clamp(top, 8, innerHeight - ph - 8)}px`;
  }
  document.addEventListener('pointerdown', (e) => {
    if (popEl && !popEl.contains(e.target)) closePops();
  });

  const tb = (ic, title, fn, label) => h('button', { class: 'tb', type: 'button', title, 'aria-label': title, onclick: fn }, icon(ic), label ? h('span', { class: 'hide-sm', text: label }) : null);

  function fullPath(it) {
    if (HOST) return `${folderName}/${it.path}`;
    const p = `${folderPath}/${it.path}`;
    return /^\/[A-Za-z]:/.test(p) ? p.slice(1).replace(/\//g, '\\') : p;
  }
  function copy(text, msg) {
    navigator.clipboard?.writeText(text).then(
      () => toast(msg),
      () => toast('Não consegui copiar.'),
    );
  }
  function docTitle(it) {
    return h('div', { class: 'dv-title' }, h('span', { class: 'chip k-material' }, icon(it.view === 'image' ? 'image' : 'doc')), h('div', {}, h('b', { text: it.title, title: it.title }), h('small', { text: it.aula.name })));
  }
  function dvMsg({ ic = 'doc', title, text, extra = [], actions = [] }) {
    return h('div', { class: 'dv-msg' }, h('div', { class: 'big' }, icon(ic)), h('h3', { text: title }), h('p', {}, text), ...extra, actions.length ? h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'center' } }, actions) : null);
  }
  function simpleBar(it, extra = []) {
    const done = doneButton(it);
    done.el.classList.add('sm');
    onChange(done.draw);
    const { prev, next } = neighbors(it);
    return {
      el: h(
        'div',
        { class: 'dv-bar' },
        docTitle(it),
        h('div', { class: 'spacer' }),
        ...extra,
        done.el,
        h('div', { class: 'vsep' }),
        tb('left', prev ? `Anterior: ${prev.title}` : 'Início', () => prev && go(prev)),
        tb('right', next ? `Próxima: ${next.title}` : 'Fim', () => next && go(next)),
      ),
      destroy: () => listeners.delete(done.draw),
    };
  }

  // ------------------------------------------------------------------ PDF
  let pdfjsP = null;
  function loadScript(src) {
    return new Promise((ok, ko) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = ok;
      s.onerror = () => ko(new Error(`Não carregou ${src}`));
      document.head.append(s);
    });
  }
  function loadPdfJs() {
    pdfjsP ??= (async () => {
      if (!window.pdfjsLib) await loadScript(`${LIB}/pdfjs/pdf.min.js`);
      const lib = window.pdfjsLib;
      if (!lib) throw new Error('pdf.js');
      lib.GlobalWorkerOptions.workerSrc = `${LIB}/pdfjs/pdf.worker.min.js`;
      // Em file:// não dá para criar Worker por caminho: Worker a partir de um Blob; se falhar, o pdf.js roda na página.
      if (!HOST)
        try {
          const wf = await Folder.file(`${STORAGE}/app/pdfjs/pdf.worker.min.js`);
          lib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([await wf.arrayBuffer()], { type: 'text/javascript' }));
        } catch {}
      return lib;
    })().catch((err) => {
      pdfjsP = null;
      throw err;
    });
    return pdfjsP;
  }

  /** Lê o arquivo da pasta para o leitor (PDF/Word). Sem acesso à pasta, mostra como liberar e devolve null. */
  async function folderBytes(it, { root, bar, token, what }) {
    const msg = (o) => root.replaceChildren(bar.el, dvMsg(o));
    if (Folder.state === 'unsupported') {
      return msg({
        title: 'Abra no Google Chrome ou no Microsoft Edge',
        text: `A prévia precisa ler os arquivos da pasta, e só esses navegadores permitem isso numa página aberta do computador.`,
        actions: it.view === 'pdf' ? [h('a', { class: 'btn', href: it.href, target: '_blank', rel: 'noopener' }, icon('external'), 'Abrir o PDF neste navegador')] : [],
      });
      return null;
    }
    if (Folder.state !== 'ready' && Folder.state === 'prompt' && navigator.userActivation?.isActive) await Folder.connect({ pick: false });
    if (token !== viewToken) return null;
    if (Folder.state !== 'ready') {
      const prompt = Folder.state === 'prompt' || HOST;
      msg({
        ic: 'book',
        title: prompt ? `Libere o acesso à pasta para abrir ${what}` : `Abra ${what} aqui, sem baixar nada`,
        text: prompt
          ? 'Por segurança, o Chrome pede uma confirmação para a página usar a pasta. Escolha “Permitir em todas as visitas” e ele não pergunta mais.'
          : h('span', {}, 'O navegador só deixa esta página ler os arquivos depois que você escolhe a pasta das aulas ', h('b', { text: 'uma vez' }), '. Com a extensão AVA Downloader instalada, nem isso: use “Atualizar numa pasta já baixada” e a página passa a abrir pela extensão.'),
        extra: prompt ? [] : [h('ol', { class: 'steps' }, h('li', { text: 'Clique em “Escolher a pasta”.' }), h('li', {}, 'Selecione a pasta ', h('b', { text: `“${folderName}”` }), ' (onde está este arquivo).'), h('li', { text: 'Confirme “Permitir” quando o navegador perguntar.' }))],
        actions: [
          h(
            'button',
            {
              class: 'btn primary lg',
              type: 'button',
              onclick: async () => {
                if (await Folder.connect()) route();
              },
            },
            icon('folderOk'),
            prompt ? 'Liberar acesso' : `Escolher a pasta “${folderName}”`,
          ),
        ],
      });
      return null;
    }

    root.replaceChildren(bar.el, h('div', { class: 'dv-msg' }, h('div', { class: 'vp-spin', style: { display: 'block', position: 'static', margin: '0', borderColor: 'var(--line)', borderTopColor: 'var(--brand)' } }), h('p', { text: `Abrindo ${what}…` })));
    try {
      const data = new Uint8Array(await (await Folder.file(it.path)).arrayBuffer());
      return token === viewToken ? data : null;
    } catch (err) {
      if (token !== viewToken) return null;
      if (err?.name === 'NotAllowedError') {
        Folder.state = 'prompt';
        renderStore();
        route();
        return null;
      }
      msg({ ic: 'alert', title: 'Não encontrei este arquivo na pasta', text: 'Ele pode ter sido movido, renomeado ou apagado.', extra: [h('code', { text: fullPath(it) })] });
      return null;
    }
  }

  async function showPdf(it) {
    const token = viewToken;
    const jump = takeJump(it);
    content.className = 'content flush';
    const root = h('div', { class: 'dv' });
    content.append(root);
    const bar = simpleBar(it);
    view = { destroy: bar.destroy };
    const msg = (o) => root.replaceChildren(bar.el, dvMsg(o));
    const data = await folderBytes(it, { root, bar, token, what: 'o PDF' });
    if (!data) return;
    let lib;
    try {
      lib = await loadPdfJs();
    } catch {
      if (token !== viewToken) return;
      return msg({ ic: 'alert', title: 'Falta o leitor de PDF nesta pasta', text: `A pasta “${STORAGE}/app” está incompleta. Na extensão AVA Downloader, use “Mais opções → Atualizar numa pasta já baixada”.` });
    }
    if (token !== viewToken) return;
    let doc;
    try {
      doc = await lib.getDocument({ data, isEvalSupported: false, enableXfa: false }).promise;
    } catch (err) {
      if (token !== viewToken) return;
      const locked = err?.name === 'PasswordException';
      return msg({ ic: locked ? 'lock' : 'alert', title: locked ? 'Este PDF tem senha' : 'Não consegui abrir este PDF', text: locked ? 'PDFs protegidos por senha não abrem no leitor. Abra-o pelo programa de PDF do computador.' : 'O arquivo pode estar corrompido ou incompleto. Tente baixá-lo de novo pela extensão.', extra: [h('code', { text: fullPath(it) })] });
    }
    if (token !== viewToken) return doc.destroy();
    root.replaceChildren();
    bar.destroy();
    const viewer = createPdfViewer(root, it, doc, lib, jump);
    view = viewer;
  }

  function createPdfViewer(root, it, doc, lib, jump) {
    const n = doc.numPages;
    const s0 = Store.st(it.path);
    let spread = n > 1 ? prefs.spread : 1;
    const first = (p) => (spread === 2 ? p - ((p - 1) % 2) : p);
    let page = first(clamp(jump?.page || s0.page || 1, 1, n));
    let zoom = prefs.zoom;
    let scale = 1;
    let tool = null;
    let color = prefs.color;
    let filter = 'all';
    let renderTok = 0;
    let dead = false;
    let readTimer = 0;
    const tasks = [];
    const pageCache = new Map();
    const getPage = (k) => {
      if (!pageCache.has(k)) pageCache.set(k, doc.getPage(k));
      return pageCache.get(k);
    };
    const pct = (x) => `${(x * 100).toFixed(3)}%`;
    const hls = () => Store.list('hl', it.path);
    const pins = () => Store.list('notes', it.path).filter((x) => x.page != null);

    // ---- barra
    const pgIn = h('input', { type: 'text', inputmode: 'numeric', 'aria-label': 'Página' });
    const prevB = tb('left', 'Página anterior (←)', () => turn(-1));
    const nextB = tb('right', 'Próxima página (→)', () => turn(1));
    const zoomSel = h('select', { class: 'zoom-val', 'aria-label': 'Zoom' });
    const oneB = tb('onePage', 'Uma página (1)', () => setSpread(1));
    const twoB = tb('twoPage', 'Duas páginas (2)', () => setSpread(2));
    const hlB = tb('marker', 'Marca-texto (H): selecione um trecho e ele já fica destacado', () => setTool(tool === 'hl' ? null : 'hl'), 'Destacar');
    const sw = COLORS.map((c) => h('button', { class: `sw-btn c-${c.id}`, type: 'button', title: c.name, 'aria-label': `Cor ${c.name}`, onclick: () => setColor(c.id) }));
    const noteB = tb('note', 'Nota adesiva (N): clique em qualquer ponto da página', () => setTool(tool === 'note' ? null : 'note'), 'Nota');
    const annCount = h('span', { class: 'count' });
    const annB = h('button', { class: 'tb', type: 'button', title: 'Destaques e notas (A)', onclick: () => togglePanel() }, icon('list'), h('span', { class: 'hide-sm', text: 'Anotações' }), annCount);
    const thumbB = tb('grid', 'Miniaturas das páginas (T)', () => toggleThumbs());
    const fsB = tb('full', 'Tela cheia (F)', () => toggleFs());
    const done = doneButton(it);
    done.el.classList.add('sm');
    // O título já está no topo (caminho da aula): a barra fica só com as ferramentas, numa linha.
    const bar = h(
      'div',
      { class: 'dv-bar' },
      h('div', { class: 'grp' }, thumbB),
      h('div', { class: 'spacer' }),
      h('div', { class: 'grp' }, prevB, h('label', { class: 'pg-input' }, pgIn, h('span', { text: `de ${n}` })), nextB),
      h('div', { class: 'vsep' }),
      h('div', { class: 'grp' }, tb('minus', 'Diminuir (−)', () => zoomBy(1 / 1.2)), zoomSel, tb('plus', 'Aumentar (+)', () => zoomBy(1.2))),
      n > 1 ? h('div', { class: 'vsep hide-sm' }) : null,
      n > 1 ? h('div', { class: 'grp hide-sm' }, oneB, twoB) : null,
      h('div', { class: 'vsep' }),
      h('div', { class: 'grp' }, hlB, h('div', { class: 'swatches' }, sw), noteB),
      h('div', { class: 'spacer' }),
      h('div', { class: 'grp' }, annB, fsB),
      h('div', { class: 'vsep hide-sm' }),
      done.el,
    );

    // ---- corpo
    const thumbs = h('aside', { class: 'dv-thumbs', 'aria-label': 'Miniaturas' });
    const spreadEl = h('div', { class: 'dv-spread' });
    const stage = h('div', { class: 'dv-stage', tabindex: '0', 'aria-label': `Documento: ${it.title}` }, spreadEl);
    const navPrev = h('button', { class: 'dv-nav prev', type: 'button', 'aria-label': 'Página anterior', onclick: () => turn(-1) }, icon('left'));
    const navNext = h('button', { class: 'dv-nav next', type: 'button', 'aria-label': 'Próxima página', onclick: () => turn(1) }, icon('right'));
    const listEl = h('div', { class: 'dvn-list' });
    const filterEl = h('div', { class: 'dvn-filter' });
    const panel = h('aside', { class: 'dv-notes', 'aria-label': 'Anotações' }, h('div', { class: 'dvn-head' }, h('h3', {}, h('span', { text: 'Destaques e notas' }), h('button', { class: 'btn ghost sm icon', type: 'button', title: 'Fechar', 'aria-label': 'Fechar', onclick: () => togglePanel(false) }, icon('x'))), filterEl), listEl);
    root.append(bar, h('div', { class: 'dv-body' }, thumbs, h('div', { style: { position: 'relative', flex: '1', display: 'flex', minWidth: '0' } }, stage, navPrev, navNext), panel));
    // Em tela estreita os painéis cobrem a página: começam fechados.
    root.classList.toggle('thumbs', prefs.thumbs && !narrow());
    root.classList.toggle('notes', prefs.notes && !narrow() && hls().length + pins().length > 0);

    // ---- render
    function computeScale(base) {
      const W = stage.clientWidth - 48;
      const H = stage.clientHeight - 64;
      const gap = 18 * (base.length - 1);
      const sumW = base.reduce((s, v) => s + v.width, 0);
      const maxH = Math.max(...base.map((v) => v.height));
      const fw = (W - gap) / sumW;
      if (zoom === 'width') return Math.max(0.1, fw);
      if (zoom === 'page') return Math.max(0.1, Math.min(fw, H / maxH));
      return zoom;
    }
    async function render(scrollTo = 'top') {
      const tok = ++renderTok;
      for (const t of tasks.splice(0))
        try {
          t.cancel();
        } catch {}
      const nums = spread === 2 ? [page, page + 1].filter((k) => k <= n) : [page];
      const pages = await Promise.all(nums.map(getPage));
      if (tok !== renderTok || dead) return;
      const base = pages.map((p) => p.getViewport({ scale: 1 }));
      scale = computeScale(base);
      const prevTop = stage.scrollTop;
      for (const c of spreadEl.querySelectorAll('canvas')) {
        c.width = 0;
        c.height = 0;
      }
      spreadEl.classList.toggle('fit', zoom === 'page');
      spreadEl.replaceChildren(
        ...nums.map((k, i) =>
          h(
            'div',
            { class: 'pg', dataset: { page: k }, style: { width: `${base[i].width * scale}px`, height: `${base[i].height * scale}px`, '--scale-factor': String(scale) } },
            h('canvas', { class: 'pv' }),
            h('div', { class: 'hl-layer' }),
            h('div', { class: 'textLayer' }),
            h('div', { class: 'pg-loading' }),
            h('span', { class: 'pg-num', text: `${k}` }),
          ),
        ),
      );
      if (scrollTo === 'top') stage.scrollTop = 0;
      else if (scrollTo === 'bottom') stage.scrollTop = stage.scrollHeight;
      else stage.scrollTop = prevTop;
      if (scrollTo !== 'keep') stage.scrollLeft = (stage.scrollWidth - stage.clientWidth) / 2;
      drawBar();
      saveProgress();
      await Promise.all(nums.map((k, i) => paintPage(pages[i], k, spreadEl.children[i], tok)));
    }
    async function paintPage(p, k, el, tok) {
      const vp = p.getViewport({ scale });
      let out = window.devicePixelRatio || 1;
      const maxPx = 16e6;
      if (vp.width * vp.height * out * out > maxPx) out = Math.sqrt(maxPx / (vp.width * vp.height));
      const canvas = el.querySelector('canvas');
      canvas.width = Math.floor(vp.width * out);
      canvas.height = Math.floor(vp.height * out);
      const task = p.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport: vp, transform: out !== 1 ? [out, 0, 0, out, 0, 0] : null });
      tasks.push(task);
      try {
        await task.promise;
      } catch (err) {
        if (err?.name !== 'RenderingCancelledException' && tok === renderTok) el.querySelector('.pg-loading')?.replaceWith(h('div', { class: 'dv-msg', text: 'Não consegui desenhar esta página.' }));
        return;
      }
      if (tok !== renderTok || dead) return;
      el.querySelector('.pg-loading')?.remove();
      paintAnnots(el, k);
      try {
        const tc = await p.getTextContent();
        if (tok !== renderTok || dead) return;
        const tl = el.querySelector('.textLayer');
        const tt = lib.renderTextLayer({ textContentSource: tc, container: tl, viewport: vp, textDivs: [] });
        tasks.push(tt);
        await tt.promise;
        tl.append(h('div', { class: 'endOfContent' }));
      } catch {}
    }
    function paintAnnots(el, k) {
      const layer = el.querySelector('.hl-layer');
      layer.replaceChildren();
      el.querySelectorAll('.pin, .hl-note').forEach((x) => x.remove());
      for (const a of hls().filter((x) => x.page === k)) {
        for (const r of a.rects) layer.append(h('div', { class: `hl c-${a.color}`, dataset: { id: a.id }, style: { left: pct(r[0]), top: pct(r[1]), width: pct(r[2]), height: pct(r[3]) } }));
        if (a.note) {
          const r = a.rects[a.rects.length - 1];
          el.append(h('button', { class: `hl-note c-${a.color}`, type: 'button', title: a.note, 'aria-label': 'Ver nota do destaque', style: { left: pct(r[0] + r[2]), top: pct(r[1]) }, onclick: (e) => (e.stopPropagation(), editHl(a.id, e.currentTarget.getBoundingClientRect())) }, icon('note')));
        }
      }
      for (const p of pins().filter((x) => x.page === k)) el.append(h('button', { class: 'pin', type: 'button', title: p.text || 'Nota', 'aria-label': 'Nota', dataset: { id: p.id }, style: { left: pct(p.x), top: pct(p.y) }, onclick: (e) => (e.stopPropagation(), editPin(p.id, e.currentTarget.getBoundingClientRect())) }, icon('note')));
    }
    function repaint() {
      if (dead) return;
      for (const el of spreadEl.children) paintAnnots(el, Number(el.dataset.page));
      drawPanel();
      markThumbs();
    }

    // ---- barra: estado
    const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
    function drawBar() {
      pgIn.value = spread === 2 && page + 1 <= n ? `${page}–${page + 1}` : String(page);
      prevB.disabled = navPrev.disabled = page <= 1;
      nextB.disabled = navNext.disabled = page + spread > n;
      oneB.setAttribute('aria-pressed', String(spread === 1));
      twoB.setAttribute('aria-pressed', String(spread === 2));
      hlB.setAttribute('aria-pressed', String(tool === 'hl'));
      noteB.setAttribute('aria-pressed', String(tool === 'note'));
      annB.setAttribute('aria-pressed', String(root.classList.contains('notes')));
      thumbB.setAttribute('aria-pressed', String(root.classList.contains('thumbs')));
      root.classList.toggle('tool-note', tool === 'note');
      sw.forEach((b, i) => b.setAttribute('aria-pressed', String(COLORS[i].id === color)));
      const opts = [['page', 'Página inteira'], ['width', 'Largura'], ...ZOOMS.map((z) => [String(z), `${Math.round(z * 100)}%`])];
      if (typeof zoom === 'number' && !ZOOMS.includes(zoom)) opts.push([String(zoom), `${Math.round(zoom * 100)}%`]);
      zoomSel.replaceChildren(...opts.map(([v, t]) => h('option', { value: v, text: t })));
      zoomSel.value = String(zoom);
      annCount.textContent = String(hls().length + pins().length);
      markThumbs();
    }
    function saveProgress() {
      const last = Math.min(n, page + spread - 1);
      Store.set(it.path, { page: last, pages: n }, { quiet: true });
      const row = rows.items.get(it.path);
      if (row) setRing(row.ring, frac(it), isDone(it));
      clearTimeout(readTimer);
      // Chegou na última página e ficou nela: conta como lido.
      if (last >= n && !isDone(it))
        readTimer = setTimeout(() => {
          if (dead || isDone(it)) return;
          const undo = setDone(it, true);
          toast('Material marcado como lido.', { action: 'Desfazer', onAction: undo });
        }, 4000);
    }

    // ---- ações
    function turn(dir, scrollTo) {
      const np = page + dir * spread;
      if (np < 1 || np > n) return;
      page = first(np);
      closePops();
      render(scrollTo);
    }
    function goto(k) {
      page = first(clamp(k, 1, n));
      return render();
    }
    function setSpread(s) {
      spread = n > 1 ? s : 1;
      prefs.spread = s;
      savePrefs();
      page = first(page);
      render();
    }
    function setZoom(z) {
      zoomLater.active = false;
      spreadEl.style.transform = '';
      zoom = z;
      prefs.zoom = z;
      savePrefs();
      render('keep');
    }
    function zoomBy(f) {
      setZoom(clamp(Math.round(scale * f * 100) / 100, 0.25, 5));
    }
    function setTool(t) {
      tool = t;
      if (t === 'hl') {
        const sel = getSelection();
        if (sel && !sel.isCollapsed) handleSelection(sel);
      }
      drawBar();
    }
    function setColor(c) {
      color = c;
      prefs.color = c;
      savePrefs();
      if (tool !== 'hl') tool = 'hl';
      drawBar();
    }
    function togglePanel(force) {
      const on = root.classList.toggle('notes', force);
      prefs.notes = on;
      savePrefs();
      drawBar();
      if (typeof zoom !== 'number') render('keep');
    }
    let thumbIO = null;
    function toggleThumbs(force) {
      const on = root.classList.toggle('thumbs', force);
      prefs.thumbs = on;
      savePrefs();
      if (on && !thumbIO) buildThumbs();
      drawBar();
      if (typeof zoom !== 'number') render('keep');
    }
    function toggleFs() {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else root.requestFullscreen().catch(() => {});
    }
    const onFs = () => {
      fsB.replaceChildren(icon(document.fullscreenElement === root ? 'unfull' : 'full'));
      closePops();
    };
    document.addEventListener('fullscreenchange', onFs);

    pgIn.addEventListener('focus', () => pgIn.select());
    pgIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const k = parseInt(pgIn.value, 10);
        if (k) goto(k);
        stage.focus();
      } else if (e.key === 'Escape') {
        drawBar();
        stage.focus();
      }
    });
    pgIn.addEventListener('blur', drawBar);
    zoomSel.addEventListener('change', () => {
      const v = zoomSel.value;
      setZoom(v === 'page' || v === 'width' ? v : Number(v));
    });

    // ---- miniaturas
    async function buildThumbs() {
      const p1 = await getPage(1);
      const v1 = p1.getViewport({ scale: 1 });
      thumbIO = new IntersectionObserver(
        (entries) => {
          for (const en of entries)
            if (en.isIntersecting) {
              thumbIO.unobserve(en.target);
              drawThumb(en.target);
            }
        },
        { root: thumbs, rootMargin: '300px' },
      );
      for (let k = 1; k <= n; k++) {
        const b = h('button', { class: 'thumb', type: 'button', dataset: { page: k }, 'aria-label': `Página ${k}`, onclick: () => goto(k) }, h('div', { class: 'tcv', style: { aspectRatio: `${v1.width} / ${v1.height}` } }), h('span', { text: String(k) }));
        thumbs.append(b);
        thumbIO.observe(b);
      }
      markThumbs();
    }
    async function drawThumb(b) {
      if (dead) return;
      const k = Number(b.dataset.page);
      let p;
      try {
        p = await getPage(k);
      } catch {
        return;
      }
      if (dead) return;
      const v1 = p.getViewport({ scale: 1 });
      const vv = p.getViewport({ scale: (120 * (window.devicePixelRatio || 1)) / v1.width });
      const c = document.createElement('canvas');
      c.width = Math.floor(vv.width);
      c.height = Math.floor(vv.height);
      const box = b.querySelector('.tcv');
      box.style.aspectRatio = `${v1.width} / ${v1.height}`;
      try {
        await p.render({ canvasContext: c.getContext('2d', { alpha: false }), viewport: vv }).promise;
        if (!dead) box.prepend(c);
      } catch {}
    }
    function markThumbs() {
      if (!thumbIO) return;
      const withAnn = new Set([...hls(), ...pins()].map((x) => x.page));
      for (const b of thumbs.children) {
        const k = Number(b.dataset.page);
        const on = k >= page && k < page + spread;
        b.classList.toggle('on', on);
        const box = b.querySelector('.tcv');
        const dot = box.querySelector('i');
        if (withAnn.has(k) && !dot) box.append(h('i'));
        else if (!withAnn.has(k) && dot) dot.remove();
        if (on && root.classList.contains('thumbs') && k === page) b.scrollIntoView({ block: 'nearest' });
      }
    }

    // ---- seleção e destaques
    function rectsFor(range, pg) {
      const box = pg.getBoundingClientRect();
      const raw = [];
      for (const r of range.getClientRects()) {
        if (r.width < 0.5 || r.height < 0.5) continue;
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        if (cx < box.left || cx > box.right || cy < box.top || cy > box.bottom) continue;
        const x = { x: (r.left - box.left) / box.width, y: (r.top - box.top) / box.height, w: r.width / box.width, h: r.height / box.height };
        if (x.h > 0.12 || x.w > 0.98) continue; // caixas do contêiner, não do texto
        raw.push(x);
      }
      raw.sort((a, b) => a.y - b.y || a.x - b.x);
      const out = [];
      for (const r of raw) {
        const m = out.find((o) => Math.abs(o.y + o.h / 2 - (r.y + r.h / 2)) < Math.min(o.h, r.h) * 0.6 && r.x <= o.x + o.w + 0.015 && r.x + r.w >= o.x - 0.015);
        if (m) {
          const x1 = Math.min(m.x, r.x);
          const y1 = Math.min(m.y, r.y);
          const x2 = Math.max(m.x + m.w, r.x + r.w);
          const y2 = Math.max(m.y + m.h, r.y + r.h);
          Object.assign(m, { x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
        } else out.push({ ...r });
      }
      const r4 = (v) => Math.round(v * 10000) / 10000;
      return out.map((r) => [r4(r.x), r4(r.y), r4(r.w), r4(r.h)]);
    }
    function handleSelection(sel) {
      const range = sel.getRangeAt(0);
      const node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
      const pg = node?.closest?.('.pg');
      if (!pg || !spreadEl.contains(pg)) return;
      const text = sel.toString().replace(/\s+/g, ' ').trim();
      if (!text) return;
      const rects = rectsFor(range, pg);
      if (!rects.length) return;
      const data = { page: Number(pg.dataset.page), rects, text: text.slice(0, 3000) };
      if (tool === 'hl') {
        addHl(data, color);
        sel.removeAllRanges();
        return;
      }
      selPop(data, range.getBoundingClientRect());
    }
    function addHl(data, c) {
      const rec = Store.upsert('hl', it.path, { id: uid(), ...data, color: c, note: '' });
      if (!root.classList.contains('notes') && hls().length === 1) togglePanel(true);
      repaint();
      return rec;
    }
    function selPop(data, r) {
      const keep = (e) => e.preventDefault();
      const pop = h(
        'div',
        { class: 'pop sel', role: 'toolbar', 'aria-label': 'Destacar seleção' },
        COLORS.map((c) =>
          h('button', {
            class: `sw-btn c-${c.id}`,
            type: 'button',
            title: `Destacar em ${c.name.toLowerCase()}`,
            'aria-pressed': String(c.id === color),
            onmousedown: keep,
            onclick: () => {
              color = c.id;
              prefs.color = c.id;
              savePrefs();
              addHl(data, c.id);
              getSelection().removeAllRanges();
              closePops();
              drawBar();
            },
          }),
        ),
        h('div', { class: 'vsep' }),
        h(
          'button',
          {
            class: 'tb',
            type: 'button',
            onmousedown: keep,
            onclick: () => {
              const rec = addHl(data, color);
              getSelection().removeAllRanges();
              editHl(rec.id, r, true);
            },
          },
          icon('note'),
          'Anotar',
        ),
        h(
          'button',
          {
            class: 'tb',
            type: 'button',
            title: 'Copiar o texto',
            'aria-label': 'Copiar',
            onmousedown: keep,
            onclick: () => {
              copy(data.text, 'Texto copiado.');
              closePops();
            },
          },
          icon('copy'),
        ),
      );
      openPop(pop, r);
    }
    function hlRect(id) {
      const els = [...spreadEl.querySelectorAll(`.hl[data-id="${id}"]`)];
      if (!els.length) return null;
      const rs = els.map((e) => e.getBoundingClientRect());
      const left = Math.min(...rs.map((x) => x.left));
      const top = Math.min(...rs.map((x) => x.top));
      const right = Math.max(...rs.map((x) => x.right));
      const bottom = Math.max(...rs.map((x) => x.bottom));
      return { left, top, right, bottom, width: right - left, height: bottom - top };
    }
    function editHl(id, r, focus = false) {
      const a = hls().find((x) => x.id === id);
      if (!a) return;
      r = hlRect(id) || r;
      const ta = h('textarea', { class: 'field', placeholder: 'Escreva uma nota sobre este trecho…', 'aria-label': 'Nota do destaque' });
      ta.value = a.note || '';
      const saveNote = debounce(() => {
        const cur = hls().find((x) => x.id === id);
        if (cur && (cur.note || '') !== ta.value.trim()) {
          Store.upsert('hl', it.path, { id, note: ta.value.trim() });
          repaint();
        }
      }, 400);
      ta.addEventListener('input', saveNote);
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closePops();
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) closePops();
      });
      const sws = COLORS.map((c) =>
        h('button', {
          class: `sw-btn c-${c.id}`,
          type: 'button',
          title: c.name,
          'aria-pressed': String(c.id === a.color),
          onclick: () => {
            Store.upsert('hl', it.path, { id, color: c.id });
            sws.forEach((b, i) => b.setAttribute('aria-pressed', String(COLORS[i].id === c.id)));
            repaint();
          },
        }),
      );
      const pop = h(
        'div',
        { class: 'pop edit' },
        h(
          'div',
          { class: 'row' },
          h('div', { class: 'swatches', style: { padding: 0 } }, sws),
          h(
            'div',
            { style: { display: 'flex', gap: '2px' } },
            h('button', { class: 'btn ghost sm icon', type: 'button', title: 'Copiar o texto', 'aria-label': 'Copiar', onclick: () => copy(a.text, 'Texto copiado.') }, icon('copy')),
            h(
              'button',
              {
                class: 'btn ghost sm icon danger',
                type: 'button',
                title: 'Apagar destaque',
                'aria-label': 'Apagar destaque',
                onclick: () => {
                  saveNote.flush();
                  const old = hls().find((x) => x.id === id);
                  popClose = null;
                  closePops();
                  Store.remove('hl', it.path, id);
                  repaint();
                  toast('Destaque apagado.', { action: 'Desfazer', onAction: () => (Store.upsert('hl', it.path, { ...old, del: false }), repaint()) });
                },
              },
              icon('trash'),
            ),
          ),
        ),
        h('q', { text: a.text }),
        ta,
        h('div', { class: 'row' }, h('small', { style: { color: 'var(--muted)', fontSize: '12px' }, text: `Página ${a.page}` }), h('button', { class: 'btn sm primary', type: 'button', text: 'Pronto', onclick: closePops })),
      );
      openPop(pop, r, () => saveNote.flush());
      if (focus || !a.note) ta.focus();
    }
    function editPin(id, r, isNew = false) {
      const p = pins().find((x) => x.id === id);
      if (!p) return;
      const ta = h('textarea', { class: 'field', placeholder: 'Escreva sua nota…', 'aria-label': 'Nota' });
      ta.value = p.text || '';
      const save = () => {
        const v = ta.value.trim();
        const cur = pins().find((x) => x.id === id);
        if (!cur) return;
        if (!v && (isNew || !cur.text)) Store.remove('notes', it.path, id);
        else if (v && v !== cur.text) Store.upsert('notes', it.path, { id, text: v });
        repaint();
      };
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) closePops();
      });
      const pop = h(
        'div',
        { class: 'pop edit' },
        h(
          'div',
          { class: 'row' },
          h('b', { text: `Nota · página ${p.page}`, style: { fontSize: '13px' } }),
          h(
            'button',
            {
              class: 'btn ghost sm icon danger',
              type: 'button',
              title: 'Apagar nota',
              'aria-label': 'Apagar nota',
              onclick: () => {
                popClose = null;
                closePops();
                Store.remove('notes', it.path, id);
                repaint();
              },
            },
            icon('trash'),
          ),
        ),
        ta,
        h('div', { class: 'row' }, h('small', { style: { color: 'var(--muted)', fontSize: '12px' }, text: 'Ctrl+Enter para fechar' }), h('button', { class: 'btn sm primary', type: 'button', text: 'Pronto', onclick: closePops })),
      );
      openPop(pop, r, save);
      ta.focus();
      if (isNew && tool === 'note') {
        tool = null;
        drawBar();
      }
    }
    function flashAnn(a) {
      requestAnimationFrame(() => {
        const els = a.type === 'pin' ? [spreadEl.querySelector(`.pin[data-id="${a.id}"]`)] : [...spreadEl.querySelectorAll(`.hl[data-id="${a.id}"]`)];
        const first = els.filter(Boolean)[0];
        if (!first) return;
        first.scrollIntoView({ block: 'center', inline: 'nearest' });
        for (const e of els) {
          if (!e) continue;
          e.classList.remove('flash');
          void e.offsetWidth;
          e.classList.add('flash');
        }
      });
    }

    // ---- painel
    function drawPanel() {
      const all = [...hls().map((a) => ({ type: 'hl', ...a, y: a.rects[0]?.[1] || 0 })), ...pins().map((p) => ({ type: 'pin', ...p }))];
      const counts = { all: all.length, pin: all.filter((x) => x.type === 'pin').length };
      for (const c of COLORS) counts[c.id] = all.filter((x) => x.type === 'hl' && x.color === c.id).length;
      if (filter !== 'all' && !counts[filter]) filter = 'all';
      filterEl.replaceChildren(
        ...[{ id: 'all', name: 'Tudo' }, ...COLORS.filter((c) => counts[c.id]), ...(counts.pin ? [{ id: 'pin', name: 'Notas' }] : [])].map((f) =>
          h(
            'button',
            {
              type: 'button',
              'aria-pressed': String(filter === f.id),
              onclick: () => {
                filter = f.id;
                drawPanel();
              },
            },
            f.id !== 'all' && f.id !== 'pin' ? h('i', { class: `c-${f.id}` }) : null,
            `${f.name} ${counts[f.id]}`,
          ),
        ),
      );
      const shown = all.filter((x) => filter === 'all' || (filter === 'pin' ? x.type === 'pin' : x.type === 'hl' && x.color === filter)).sort((a, b) => a.page - b.page || a.y - b.y);
      if (!shown.length) {
        listEl.replaceChildren(h('div', { class: 'dvn-empty' }, icon('marker'), h('b', { text: 'Nenhum destaque ainda' }), h('span', { text: 'Selecione um trecho do texto e escolha uma cor. Para uma nota solta, use “Nota” e clique na página.' })));
        return;
      }
      listEl.replaceChildren(
        ...shown.map((a) => {
          const open = async () => {
            if (a.page < page || a.page >= page + spread) await goto(a.page);
            flashAnn(a);
          };
          const edit = async (e) => {
            e.stopPropagation();
            await open();
            requestAnimationFrame(() => {
              if (a.type === 'pin') {
                const el = spreadEl.querySelector(`.pin[data-id="${a.id}"]`);
                if (el) editPin(a.id, el.getBoundingClientRect());
              } else editHl(a.id, hlRect(a.id) || stage.getBoundingClientRect());
            });
          };
          const del = (e) => {
            e.stopPropagation();
            const old = a.type === 'pin' ? pins().find((x) => x.id === a.id) : hls().find((x) => x.id === a.id);
            const kind = a.type === 'pin' ? 'notes' : 'hl';
            Store.remove(kind, it.path, a.id);
            repaint();
            toast(a.type === 'pin' ? 'Nota apagada.' : 'Destaque apagado.', { action: 'Desfazer', onAction: () => (Store.upsert(kind, it.path, { ...old, del: false }), repaint()) });
          };
          const body = a.type === 'hl' ? a.note : a.text;
          return h(
            'div',
            { class: `ann${a.page >= page && a.page < page + spread ? ' on' : ''}`, role: 'button', tabindex: '0', style: { '--c': a.type === 'hl' ? `var(--hl-${a.color})` : 'var(--brand)' }, onclick: open, onkeydown: (e) => e.key === 'Enter' && open() },
            h(
              'div',
              { class: 'ann-top' },
              h('span', { text: `Página ${a.page}${a.type === 'pin' ? ' · nota' : ''}` }),
              h('div', { class: 'acts' }, h('button', { class: 'btn ghost sm icon', type: 'button', title: 'Editar', 'aria-label': 'Editar', onclick: edit }, icon('pen')), h('button', { class: 'btn ghost sm icon', type: 'button', title: 'Apagar', 'aria-label': 'Apagar', onclick: del }, icon('trash'))),
            ),
            a.type === 'hl' ? h('q', { text: a.text }) : null,
            body ? h('p', { text: body }) : a.type === 'pin' ? h('p', { text: '(nota vazia)', style: { fontStyle: 'italic' } }) : null,
          );
        }),
      );
    }

    // ---- eventos do palco
    stage.addEventListener('pointerdown', (e) => {
      const tl = e.target.closest?.('.textLayer');
      if (tl) tl.classList.add('selecting');
    });
    const onUp = (e) => {
      spreadEl.querySelectorAll('.textLayer.selecting').forEach((t) => t.classList.remove('selecting'));
      if (!stage.contains(e.target) || e.button !== 0) return;
      setTimeout(() => {
        if (dead) return;
        const sel = getSelection();
        if (sel && !sel.isCollapsed && sel.rangeCount) return handleSelection(sel);
        const pg = e.target.closest?.('.pg');
        if (!pg || e.target.closest('.pin, .hl-note')) return;
        const k = Number(pg.dataset.page);
        const box = pg.getBoundingClientRect();
        const x = (e.clientX - box.left) / box.width;
        const y = (e.clientY - box.top) / box.height;
        if (tool === 'note') {
          const rec = Store.upsert('notes', it.path, { id: uid(), page: k, x: clamp(x, 0, 0.97), y: clamp(y, 0.03, 1), text: '' });
          repaint();
          const el = spreadEl.querySelector(`.pin[data-id="${rec.id}"]`);
          if (el) editPin(rec.id, el.getBoundingClientRect(), true);
          return;
        }
        const hit = hls().find((a) => a.page === k && a.rects.some((r) => x >= r[0] && x <= r[0] + r[2] && y >= r[1] && y <= r[1] + r[3]));
        if (hit) editHl(hit.id, { left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY, width: 0, height: 0 });
      }, 0);
    };
    document.addEventListener('pointerup', onUp);

    let wheelAcc = 0;
    let lastTurn = 0;
    const zoomLater = debounce(() => setZoom(clamp(Math.round(pendingScale * 100) / 100, 0.25, 5)), 140);
    let pendingScale = 1;
    stage.addEventListener(
      'wheel',
      (e) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          pendingScale = (zoomLater.active ? pendingScale : scale) * (e.deltaY < 0 ? 1.08 : 1 / 1.08);
          zoomLater.active = true;
          spreadEl.style.transform = `scale(${pendingScale / scale})`;
          spreadEl.style.transformOrigin = 'center top';
          zoomLater();
          return;
        }
        if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
        const max = stage.scrollHeight - stage.clientHeight;
        const atBottom = stage.scrollTop >= max - 2;
        const atTop = stage.scrollTop <= 2;
        if ((e.deltaY > 0 && atBottom) || (e.deltaY < 0 && atTop)) {
          e.preventDefault();
          wheelAcc += e.deltaY;
          if (Math.abs(wheelAcc) > 90 && Date.now() - lastTurn > 450) {
            const dir = wheelAcc > 0 ? 1 : -1;
            wheelAcc = 0;
            lastTurn = Date.now();
            turn(dir, dir < 0 && max > 2 ? 'bottom' : 'top');
          }
        } else wheelAcc = 0;
      },
      { passive: false },
    );

    const ro = new ResizeObserver(debounce(() => !dead && typeof zoom !== 'number' && render('keep'), 160));
    ro.observe(stage);

    onChange(done.draw);
    const onStore = debounce(() => !dead && (repaint(), drawBar()), 60);
    onChange(onStore);

    render().then(() => {
      if (jump?.page) {
        const a = [...hls(), ...pins()].find((x) => x.page === jump.page);
        if (a) flashAnn({ ...a, type: a.rects ? 'hl' : 'pin' });
      }
      stage.focus({ preventScroll: true });
    });
    drawPanel();
    if (root.classList.contains('thumbs')) buildThumbs();

    return {
      key(e) {
        if (e.ctrlKey || e.metaKey || e.altKey) return false;
        const k = e.key;
        if (k === 'ArrowLeft' || k === 'PageUp') turn(-1);
        else if (k === 'ArrowRight' || k === 'PageDown') turn(1);
        else if (k === ' ' && !e.shiftKey) {
          if (stage.scrollTop < stage.scrollHeight - stage.clientHeight - 2) return false;
          turn(1);
        } else if (k === 'Home') goto(1);
        else if (k === 'End') goto(n);
        else if (k === '+' || k === '=') zoomBy(1.2);
        else if (k === '-' || k === '_') zoomBy(1 / 1.2);
        else if (k === '0') setZoom('page');
        else if (k === '1') setSpread(1);
        else if (k === '2' && n > 1) setSpread(2);
        else if (k === 'f' || k === 'F') toggleFs();
        else if (k === 'h' || k === 'H') setTool(tool === 'hl' ? null : 'hl');
        else if (k === 'n') setTool(tool === 'note' ? null : 'note');
        else if (k === 'a' || k === 'A') togglePanel();
        else if (k === 't' || k === 'T') toggleThumbs();
        else if (k === 'Escape' && tool) setTool(null);
        else return false;
        return true;
      },
      destroy() {
        dead = true;
        clearTimeout(readTimer);
        for (const t of tasks.splice(0))
          try {
            t.cancel();
          } catch {}
        ro.disconnect();
        thumbIO?.disconnect();
        listeners.delete(done.draw);
        listeners.delete(onStore);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('fullscreenchange', onFs);
        if (document.fullscreenElement === root) document.exitFullscreen().catch(() => {});
        for (const c of root.querySelectorAll('canvas')) {
          c.width = 0;
          c.height = 0;
        }
        doc.destroy();
      },
    };
  }

  // ------------------------------------------------------------------ Word (.docx e .doc)
  /** .doc antigo → páginas em HTML (texto, tabelas, negrito/itálico, alinhamento). */
  function renderDoc(blocks) {
    let page = h('div', { class: 'docpage' });
    const pages = [page];
    const para = (p) => {
      const el = h('p', { style: { textAlign: p.align || 'left' } });
      for (const r of p.runs) {
        r.text.split('\n').forEach((t, i) => {
          if (i) el.append(h('br'));
          if (!t) return;
          const sp = h('span', { text: t });
          if (r.b) sp.style.fontWeight = '700';
          if (r.i) sp.style.fontStyle = 'italic';
          const deco = [r.u && 'underline', r.s && 'line-through'].filter(Boolean).join(' ');
          if (deco) sp.style.textDecoration = deco;
          if (r.size) sp.style.fontSize = `${clamp(r.size, 6, 48)}pt`;
          el.append(sp);
        });
      }
      if (!el.textContent.trim()) el.classList.add('empty');
      return el;
    };
    for (const b of blocks) {
      if (b.type === 'break') {
        page = h('div', { class: 'docpage' });
        pages.push(page);
      } else if (b.type === 'p') page.append(para(b));
      else page.append(h('table', { class: 'doctable' }, h('tbody', {}, b.rows.map((row) => h('tr', {}, row.map((cell) => h('td', {}, cell.map(para))))))));
    }
    return h('div', { class: 'docwrap' }, pages.filter((pg) => pg.childNodes.length), h('p', { class: 'docnote', text: 'Prévia de arquivo .doc: texto, tabelas e formatação básica. Imagens e caixas de texto não aparecem.' }));
  }

  async function showWord(it) {
    const token = viewToken;
    content.className = 'content flush';
    const root = h('div', { class: 'dv' });
    content.append(root);
    let zoom = prefs.wordZoom || 1;
    const zoomLbl = h('span', { class: 'zoom-lbl' });
    const inner = h('div', { class: 'word-zoom' });
    const stage = h('div', { class: 'word-stage', tabindex: '0', 'aria-label': `Documento: ${it.title}` }, inner);
    const setZoom = (z) => {
      zoom = clamp(Math.round(z * 100) / 100, 0.4, 3);
      prefs.wordZoom = zoom;
      savePrefs();
      inner.style.zoom = String(zoom);
      zoomLbl.textContent = `${Math.round(zoom * 100)}%`;
    };
    const fs = () => (document.fullscreenElement ? document.exitFullscreen() : root.requestFullscreen()).catch(() => {});
    const bar = simpleBar(it, [h('div', { class: 'grp' }, tb('minus', 'Diminuir (−)', () => setZoom(zoom / 1.15)), zoomLbl, tb('plus', 'Aumentar (+)', () => setZoom(zoom * 1.15))), tb('full', 'Tela cheia (F)', fs), h('div', { class: 'vsep' })]);
    let readTimer = 0;
    view = {
      destroy: () => {
        bar.destroy();
        clearTimeout(readTimer);
      },
      key: (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return false;
        if (e.key === '+' || e.key === '=') setZoom(zoom * 1.15);
        else if (e.key === '-' || e.key === '_') setZoom(zoom / 1.15);
        else if (e.key === '0') setZoom(1);
        else if (e.key === 'f' || e.key === 'F') fs();
        else return false;
        return true;
      },
    };
    setZoom(zoom);
    const data = await folderBytes(it, { root, bar, token, what: 'o documento' });
    if (!data) return;
    root.replaceChildren(bar.el, stage);
    inner.replaceChildren(h('div', { class: 'dv-msg' }, h('p', { text: 'Montando a prévia…' })));
    try {
      if (it.view === 'docx') {
        if (!window.JSZip) await loadScript(`${LIB}/docx/jszip.min.js`);
        if (!window.docx) await loadScript(`${LIB}/docx/docx-preview.min.js`);
        if (token !== viewToken) return;
        const style = h('div');
        const body = h('div');
        await window.docx.renderAsync(data, body, style, { className: 'docx', inWrapper: true, ignoreLastRenderedPageBreak: true, renderHeaders: true, renderFooters: true, renderFootnotes: true, useBase64URL: true });
        if (token !== viewToken) return;
        inner.replaceChildren(style, body);
      } else {
        inner.replaceChildren(renderDoc(AvaDoc.parse(data).blocks));
      }
    } catch (err) {
      if (token !== viewToken) return;
      root.replaceChildren(bar.el, dvMsg({ ic: 'alert', title: 'Não consegui mostrar este documento', text: err?.message && /[áéíóúãõç]/i.test(err.message) ? err.message : 'O arquivo pode estar corrompido ou num formato que a prévia não entende.', extra: [h('code', { text: fullPath(it) })] }));
      return;
    }
    stage.focus({ preventScroll: true });
    // Rolou até o fim e ficou lá: conta como lido.
    stage.addEventListener('scroll', () => {
      clearTimeout(readTimer);
      if (isDone(it) || stage.scrollTop + stage.clientHeight < stage.scrollHeight - 40) return;
      readTimer = setTimeout(() => {
        if (token !== viewToken || isDone(it)) return;
        const undo = setDone(it, true);
        toast('Material marcado como lido.', { action: 'Desfazer', onAction: undo });
      }, 3000);
    });
  }

  // ------------------------------------------------------------------ imagens e outros arquivos
  function showImage(it) {
    content.className = 'content flush';
    const img = h('img', { alt: it.title });
    let objUrl = null;
    if (HOST)
      Folder.file(it.path).then(
        (f) => (img.src = objUrl = URL.createObjectURL(f)),
        () => img.onerror?.(),
      );
    else img.src = it.href;
    const stageI = h('div', { class: 'img-stage' }, img);
    img.onclick = () => stageI.classList.toggle('zoom');
    const root = h('div', { class: 'dv' });
    const fs = () => (document.fullscreenElement ? document.exitFullscreen() : root.requestFullscreen()).catch(() => {});
    const bar = simpleBar(it, [tb('full', 'Tela cheia (F)', fs), h('div', { class: 'vsep' })]);
    img.onerror = () => stageI.replaceChildren(dvMsg({ ic: 'alert', title: 'Não encontrei esta imagem na pasta', text: 'Ela pode ter sido movida, renomeada ou apagada.', extra: [h('code', { text: fullPath(it) })] }));
    root.append(bar.el, stageI);
    content.append(root);
    view = {
      destroy: () => {
        bar.destroy();
        if (objUrl) URL.revokeObjectURL(objUrl);
      },
      key: (e) => {
        if (e.key === 'f' || e.key === 'F') return fs(), true;
        return false;
      },
    };
  }

  const TYPE_NAME = {
    doc: 'documento de texto',
    docx: 'documento de texto',
    odt: 'documento de texto',
    rtf: 'documento de texto',
    ppt: 'apresentação',
    pptx: 'apresentação',
    pps: 'apresentação',
    ppsx: 'apresentação',
    odp: 'apresentação',
    xls: 'planilha',
    xlsx: 'planilha',
    ods: 'planilha',
    csv: 'planilha',
    zip: 'arquivo compactado',
    rar: 'arquivo compactado',
    '7z': 'arquivo compactado',
  };
  const TYPE_APP = { 'documento de texto': 'Word, LibreOffice ou Google Docs', apresentação: 'PowerPoint, Keynote ou LibreOffice', planilha: 'Excel, Numbers ou LibreOffice', 'arquivo compactado': 'o descompactador do sistema' };
  async function showFile(it) {
    const token = viewToken;
    content.className = 'content flush';
    const root = h('div', { class: 'dv' });
    const bar = simpleBar(it);
    view = { destroy: bar.destroy };
    root.append(bar.el);
    content.append(root);
    if (it.view === 'text' && Folder.state === 'ready') {
      try {
        const txt = await (await Folder.file(it.path)).text();
        if (token !== viewToken) return;
        root.append(h('div', { class: 'txt-stage' }, h('pre', { text: txt.slice(0, 2_000_000) })));
        return;
      } catch {}
    }
    if (token !== viewToken) return;
    const tipo = TYPE_NAME[it.ext] || (it.ext ? `arquivo ${it.ext.toUpperCase()}` : 'arquivo');
    const appName = TYPE_APP[tipo];
    root.append(
      dvMsg({
        title: it.title,
        text: h('span', {}, `Este ${tipo} abre no seu computador${appName ? `, com ${appName}` : ''}. Ele já está na pasta das aulas — abra direto de lá, sem baixar de novo:`),
        extra: [h('code', { text: fullPath(it) })],
        actions: [
          h('button', { class: 'btn primary', type: 'button', onclick: () => copy(fullPath(it), 'Caminho copiado. Cole na busca do Finder (⌘⇧G) ou no Explorador de Arquivos.') }, icon('copy'), 'Copiar caminho do arquivo'),
          h('button', { class: 'btn', type: 'button', onclick: () => copy(fullPath(it).replace(/[\\/][^\\/]*$/, ''), 'Caminho da pasta copiado.') }, icon('folder'), 'Copiar a pasta'),
        ],
      }),
    );
  }

  // ------------------------------------------------------------------ atalhos
  function showKeys() {
    const row = (label, ...keys) => h('div', {}, h('span', { text: label }), h('span', {}, keys.map((k) => h('kbd', { text: k }))));
    modal((close) =>
      h(
        'div',
        { class: 'modal-body' },
        h('h3', { text: 'Atalhos do teclado' }),
        h(
          'div',
          { class: 'keys' },
          h('h4', { text: 'Geral' }),
          row('Buscar', '/'),
          row('Mostrar/ocultar a lista', 'B'),
          row('Próximo item', 'Shift', 'N'),
          row('Item anterior', 'Shift', 'P'),
          row('Esta ajuda', '?'),
          h('h4', { text: 'Vídeo e áudio' }),
          row('Tocar / pausar', 'K'),
          row('Voltar / avançar 10 s', 'J', 'L'),
          row('Voltar / avançar 5 s', '←', '→'),
          row('Volume', '↑', '↓'),
          row('Sem som', 'M'),
          row('Velocidade', '<', '>'),
          row('Anotar no tempo atual', 'N'),
          row('Tela cheia', 'F'),
          row('Janela flutuante', 'I'),
          row('Ir para 0–90%', '0', '9'),
          h('h4', { text: 'Leitor de PDF' }),
          row('Página anterior / próxima', '←', '→'),
          row('Uma / duas páginas', '1', '2'),
          row('Zoom', '−', '+'),
          row('Página inteira', '0'),
          row('Marca-texto', 'H'),
          row('Nota adesiva', 'N'),
          row('Painel de anotações', 'A'),
          row('Miniaturas', 'T'),
          row('Tela cheia', 'F'),
        ),
        h('div', { class: 'modal-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: close }, 'Fechar')),
      ),
    );
  }
  function focusSearch() {
    if (narrow()) app.classList.add('side-open');
    else if (!prefs.side) toggleSide();
    searchInput.focus();
    searchInput.select();
  }
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      return focusSearch();
    }
    if (isTyping(e) || document.querySelector('dialog[open]')) return;
    if ((e.key === ' ' || e.key === 'Enter') && e.target.closest?.('button, a, [role="link"], [role="button"], select')) return;
    if (e.key === 'Escape' && popEl) return closePops();
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '/') {
      e.preventDefault();
      return focusSearch();
    }
    if (e.key === '?') return showKeys();
    if (e.shiftKey && (e.key === 'N' || e.key === 'P') && current) {
      const nb = neighbors(current);
      const t = e.key === 'N' ? nb.next : nb.prev;
      e.preventDefault();
      if (t) go(t);
      return;
    }
    if (e.key === 'b' || e.key === 'B') return toggleSide();
    if (view?.key?.(e)) e.preventDefault();
  });

  // ------------------------------------------------------------------ início
  window.addEventListener('pagehide', () => {
    Store.writeLocal.flush();
    if (Folder.state === 'ready') Folder.schedule.flush();
  });
  if (!ui.open.size) {
    const last = Store.d.last && M.byPath.get(Store.d.last.path);
    const d = last?.disc || M.discs[0];
    if (d) ui.open.add(d.id);
    if (last) ui.open.add(last.aula.id);
  }
  function boot() {
    app.style.visibility = '';
    renderSeg();
    renderStore();
    renderTree();
    Folder.init()
      .catch(() => {})
      .finally(() => {
        renderStore();
        route();
      });
  }
  // Página aberta da pasta com a extensão instalada: abre a versão da extensão, que já tem acesso à pasta
  // (sem escolher nada). Sem a extensão (outro computador), segue aqui mesmo. "?local" força ficar aqui.
  if (!HOST && location.protocol === 'file:' && RAW.ext && RAW.folderId && !new URLSearchParams(location.search).has('local')) {
    app.style.visibility = 'hidden';
    let settled = false;
    const stay = () => {
      if (settled) return;
      settled = true;
      boot();
    };
    const probe = new Image();
    probe.onload = () => {
      if (settled) return;
      settled = true;
      location.replace(`chrome-extension://${RAW.ext}/app/watch.html?f=${encodeURIComponent(RAW.folderId)}${location.hash}`);
    };
    probe.onerror = stay;
    setTimeout(stay, 1500);
    probe.src = `chrome-extension://${RAW.ext}/icons/icon-16.png`;
  } else boot();
})();
