// Roda dentro do AVA. Duas funções:
// 1) Ponte para a API: a página da extensão pede "ava:api" e este script faz a chamada aqui,
//    com o cookie da sessão e o cabeçalho X-time que o próprio AVA usa (fica no sessionStorage da aba).
// 2) Botão flutuante "Baixar aulas", que abre a extensão.

(() => {
  if (window.__avaDownloaderLoaded) return;
  window.__avaDownloaderLoaded = true;

  const API_BASE = 'https://univirtus.uninter.com/ava/';
  const HIDE_KEY = 'avaDownloaderHidden';

  const alive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  };

  function readUser() {
    try {
      const u = JSON.parse(sessionStorage.getItem('user') || 'null');
      return u && u.time ? u : null;
    } catch {
      return null;
    }
  }

  function firstName(nome) {
    const s = String(nome || '').trim().split(/\s+/)[0] || '';
    return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : null;
  }

  // Só caminhos relativos da API do AVA: nada de URLs arbitrárias.
  const SAFE_PATH = /^(sistema|ava|repositorio|atv)\/[^\s]*$/;

  async function callApi({ path, form }) {
    if (typeof path !== 'string' || !SAFE_PATH.test(path) || path.includes('..')) return { ok: false, status: 400, error: 'Caminho inválido' };
    const user = readUser();
    if (!user) return { ok: false, status: 401, error: 'Sem sessão no AVA' };
    const headers = { 'X-time': user.time, Accept: 'application/json, text/plain, */*' };
    let body;
    if (form && typeof form === 'object') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      body = new URLSearchParams(form).toString();
    }
    const res = await fetch(API_BASE + path, { method: body ? 'POST' : 'GET', credentials: 'include', headers, body });
    const text = await res.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* respostas em texto (rotas antigas) */
    }
    return { ok: res.ok, status: res.status, data };
  }

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return undefined;
    if (msg?.type === 'ava:ping') {
      const user = readUser();
      reply({ ok: true, logged: Boolean(user), nome: firstName(user?.nome), session: user?.time || null });
      return undefined;
    }
    if (msg?.type === 'ava:api') {
      callApi(msg).then(reply, (err) => reply({ ok: false, status: 0, error: String(err?.message || err) }));
      return true;
    }
    return undefined;
  });

  // ---------- Botão flutuante ----------
  const host = document.createElement('div');
  host.id = 'ava-downloader-root';
  host.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:2147483000;display:none';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .wrap { position: relative; font: 600 14px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
      button.main {
        display: flex; align-items: center; gap: 10px; height: 48px; padding: 0 20px 0 16px; border: 0; border-radius: 999px;
        color: #fff; cursor: pointer; letter-spacing: .01em; font: inherit;
        background: linear-gradient(135deg, #4c6ef5 0%, #7048e8 100%);
        box-shadow: 0 10px 30px -8px rgba(76, 110, 245, .65), 0 2px 6px rgba(15, 23, 42, .18);
        transition: transform .18s ease, box-shadow .18s ease;
      }
      button.main:hover { transform: translateY(-2px); box-shadow: 0 16px 36px -10px rgba(76, 110, 245, .75), 0 3px 8px rgba(15, 23, 42, .2); }
      button.main:focus-visible { outline: 3px solid #fab005; outline-offset: 3px; }
      .ico { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; background: rgba(255,255,255,.18); }
      button.close {
        position: absolute; top: -8px; right: -8px; width: 22px; height: 22px; border-radius: 50%; border: 0; cursor: pointer;
        background: #1f2937; color: #fff; font: 700 13px/22px sans-serif; opacity: 0; transition: opacity .15s; padding: 0;
      }
      .wrap:hover button.close, button.close:focus-visible { opacity: 1; }
      @media (prefers-reduced-motion: reduce) { button.main { transition: none; } }
    </style>
    <div class="wrap">
      <button class="main" type="button" title="Baixar videoaulas e materiais de uma vez">
        <span class="ico" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>
        </span>
        Baixar aulas
      </button>
      <button class="close" type="button" aria-label="Esconder botão até recarregar a página">×</button>
    </div>`;

  shadow.querySelector('button.main').addEventListener('click', () => {
    if (!alive()) {
      host.remove();
      return;
    }
    chrome.runtime.sendMessage({ type: 'open-app' }).catch(() => {});
  });
  shadow.querySelector('button.close').addEventListener('click', () => {
    sessionStorage.setItem(HIDE_KEY, '1');
    host.style.display = 'none';
  });

  const update = () => {
    if (!alive()) {
      clearInterval(timer);
      host.remove();
      return;
    }
    const show = Boolean(readUser()) && sessionStorage.getItem(HIDE_KEY) !== '1';
    host.style.display = show ? 'block' : 'none';
  };
  (document.body || document.documentElement).appendChild(host);
  const timer = setInterval(update, 1500);
  update();
})();
