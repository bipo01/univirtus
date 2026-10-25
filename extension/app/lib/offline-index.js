// Gera "Assistir aulas.html": uma página offline, sem internet, que lista tudo o que foi
// baixado e toca os vídeos/áudios direto da pasta (abre com duplo clique no navegador).

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const relHref = (path) => path.split('/').map(encodeURIComponent).join('/');

const KIND_LABEL = { video: 'Vídeo', completo: 'Aula completa', audio: 'Áudio', libras: 'Libras', material: 'Material' };
const KIND_ORDER = { completo: 0, video: 1, libras: 2, audio: 3, material: 4 };
const byKind = (a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9);

/**
 * @param index   plan.index
 * @param isOk    (entry) => boolean — só lista o que realmente está na pasta/ZIP
 */
export function buildOfflineIndex(index, { isOk = () => true, geradoEm = new Date() } = {}) {
  const data = index
    .map((curso) => ({
      n: curso.nome,
      d: curso.disciplinas
        .map((disc) => ({
          n: disc.nome,
          g: disc.grupos
            .map((g) => ({
              n: g.nome,
              i: g.itens
                .filter(isOk)
                .sort(byKind)
                .map((e) => ({ t: e.titulo, k: e.kind, h: relHref(e.path) })),
              l: (g.links || []).map((l) => ({ t: l.titulo, h: l.url })),
            }))
            .filter((g) => g.i.length || g.l.length),
        }))
        .filter((d) => d.g.length),
    }))
    .filter((c) => c.d.length);

  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const quando = geradoEm.toLocaleString('pt-BR', { dateStyle: 'long', timeStyle: 'short' });

  return `<!doctype html>
<html lang="pt-BR" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Minhas aulas</title>
<style>
:root{--bg:#f6f7fb;--panel:#fff;--text:#141827;--muted:#5d6479;--line:#e4e7ef;--brand:#3b5bdb;--brand-soft:#e8edff;--accent:#f08c00}
:root[data-theme=dark]{color-scheme:dark;--bg:#0e1118;--panel:#161a24;--text:#e8ebf3;--muted:#98a0b5;--line:#252b39;--brand:#7c9bff;--brand-soft:#1d2540}
#theme{border:1px solid var(--line);background:var(--bg);color:var(--text);border-radius:10px;height:40px;padding:0 12px;cursor:pointer;font:inherit}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text)}
header{padding:20px 24px;border-bottom:1px solid var(--line);background:var(--panel);display:flex;gap:16px;align-items:center;flex-wrap:wrap}
h1{font-size:20px;margin:0}header p{margin:0;color:var(--muted);font-size:13px}
input{flex:1;min-width:200px;max-width:420px;margin-left:auto;padding:10px 14px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--text);font:inherit}
main{display:grid;grid-template-columns:minmax(280px,420px) 1fr;gap:0;height:calc(100vh - 77px)}
nav{overflow:auto;border-right:1px solid var(--line);padding:12px}
section{padding:24px;overflow:auto}
details{border-radius:12px;margin:4px 0}summary{cursor:pointer;padding:8px 10px;border-radius:10px;font-weight:600;list-style:none}
summary:hover{background:var(--brand-soft)}summary::before{content:"▸";display:inline-block;width:1.2em;transition:transform .15s}details[open]>summary::before{transform:rotate(90deg)}
.disc>summary{font-size:15px}.grp{margin-left:14px}.grp>summary{font-weight:500;color:var(--muted)}
ul{list-style:none;margin:0 0 6px 28px;padding:0}li a{display:flex;gap:8px;padding:6px 10px;border-radius:8px;color:var(--text);text-decoration:none;font-size:14px}
li a:hover,li a.on{background:var(--brand-soft);color:var(--brand)}li a small{margin-left:auto;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.curso{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--accent);margin:12px 10px 4px}
.player{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:16px;max-width:1100px}
video,audio{width:100%;border-radius:12px;background:#000;max-height:70vh}audio{background:none}
.now h2{margin:12px 4px 2px;font-size:18px}.now p{margin:0 4px;color:var(--muted)}
.empty{color:var(--muted);text-align:center;margin-top:20vh}
@media (max-width:800px){main{grid-template-columns:1fr;height:auto}nav{border-right:0;border-bottom:1px solid var(--line);max-height:50vh}}
</style>
</head>
<body>
<header><div><h1>Minhas aulas</h1><p>Baixado em ${esc(quando)} · funciona sem internet</p></div>
<input id="q" type="search" placeholder="Buscar aula ou tema…" aria-label="Buscar"><button id="theme" type="button"></button></header>
<main><nav id="nav"></nav><section id="view"><p class="empty">Escolha uma aula na lista para começar.</p></section></main>
<script>
const DATA=${json};const LBL=${JSON.stringify(KIND_LABEL)};
const nav=document.getElementById('nav'),view=document.getElementById('view'),q=document.getElementById('q');
const h=(t,a={},...c)=>{const e=document.createElement(t);for(const k in a)k==='text'?e.textContent=a[k]:e.setAttribute(k,a[k]);e.append(...c);return e};
function render(f){nav.textContent='';const n=(f||'').normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').toLowerCase();const m=s=>!n||String(s).normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').toLowerCase().includes(n);
for(const c of DATA){if(DATA.length>1)nav.append(h('div',{class:'curso',text:c.n}));for(const d of c.d){const dd=h('details',{class:'disc'});dd.append(h('summary',{text:d.n}));let any=false;
for(const g of d.g){const gg=h('details',{class:'grp'});gg.append(h('summary',{text:g.n}));const ul=h('ul');
for(const it of g.i){if(!(m(d.n)||m(g.n)||m(it.t)))continue;const a=h('a',{href:it.h,'data-k':it.k},h('span',{text:it.t}),h('small',{text:LBL[it.k]||''}));a.onclick=ev=>{if(it.k==='material')return;ev.preventDefault();play(it,g,d,a)};ul.append(h('li',{},a));any=true}
for(const l of g.l){if(!(m(d.n)||m(g.n)||m(l.t)))continue;ul.append(h('li',{},h('a',{href:l.h,target:'_blank',rel:'noopener'},h('span',{text:'↗ '+l.t}),h('small',{text:'link'}))));any=true}
if(ul.children.length){gg.append(ul);dd.append(gg);if(n)gg.open=true}}if(any){if(n)dd.open=true;nav.append(dd)}}}}
function play(it,g,d,a){document.querySelectorAll('a.on').forEach(x=>x.classList.remove('on'));a.classList.add('on');view.textContent='';
const media=h(it.k==='audio'?'audio':'video',{controls:'',autoplay:'',src:it.h});view.append(h('div',{class:'player'},media,h('div',{class:'now'},h('h2',{text:it.t}),h('p',{text:d.n+' · '+g.n}))));
media.onended=()=>{const all=[...document.querySelectorAll('nav a[data-k]')].filter(x=>x.dataset.k!=='material');const i=all.indexOf(a);if(all[i+1])all[i+1].click()}}
const th=document.getElementById('theme');function setTheme(t){document.documentElement.dataset.theme=t;th.textContent=t==='dark'?'☀ Modo claro':'☾ Modo escuro';try{localStorage.setItem('ava-theme',t)}catch(e){}}
let saved='light';try{saved=localStorage.getItem('ava-theme')==='dark'?'dark':'light'}catch(e){}setTheme(saved);th.onclick=()=>setTheme(document.documentElement.dataset.theme==='dark'?'light':'dark');
q.oninput=()=>render(q.value);render('');
</script>
</body>
</html>
`;
}
