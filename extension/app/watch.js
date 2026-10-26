// "Assistir aulas" aberta pela extensão: usa a pasta que a extensão já conhece (escolhida ao baixar
// ou ao atualizar a página), então não pede para escolher nada. Monta a lista a partir dos arquivos
// da pasta e carrega o mesmo player da página offline, no modo "extensão" (window.AVA_HOST).

import { FOLDER_NAME, INDEX_FILE, scanTree } from './lib/downloader.js';
import { getFolder, listFolders, rememberFolder } from './lib/folders.js';
import { icon } from './lib/icons.js';
import { playerData, readPlayerData } from './lib/offline-index.js';

const app = document.getElementById('app');
const wantedId = new URLSearchParams(location.search).get('f');

function screen({ ic = 'folder', title, text, button, onclick, busy = false }) {
  app.innerHTML = `<div class="gate"><div class="dv-msg">
    <div class="big">${busy ? '<div class="spin"></div>' : icon(ic, 34)}</div>
    <h3></h3><p></p>
    ${button ? '<button class="btn primary lg" type="button"></button>' : ''}
  </div></div>`;
  app.querySelector('h3').textContent = title;
  app.querySelector('p').textContent = text || '';
  const b = app.querySelector('button');
  if (b) {
    b.textContent = button;
    b.onclick = async () => {
      b.disabled = true;
      try {
        await onclick();
      } finally {
        b.disabled = false;
      }
    };
  }
}

async function hasFile(dir, name) {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

async function start(rec) {
  screen({ title: 'Abrindo suas aulas…', busy: true });
  const handle = rec.handle;
  let previous = null;
  let geradoEm = new Date();
  try {
    const f = await (await handle.getFileHandle(INDEX_FILE)).getFile();
    geradoEm = new Date(f.lastModified);
    previous = readPlayerData(await f.text());
  } catch {
    /* página ainda não existe nesta pasta */
  }
  let index;
  try {
    index = await scanTree(handle, [], previous);
  } catch (err) {
    if (err?.name === 'NotAllowedError') return askPermission(rec);
    return screen({ ic: 'alert', title: 'Não consegui ler a pasta das aulas', text: `${err?.message || err}. Ela pode ter sido movida ou apagada.`, button: 'Escolher a pasta', onclick: pick });
  }
  if (!index.length) return screen({ ic: 'alert', title: 'Nenhuma aula nesta pasta', text: `A pasta “${handle.name}” não tem aulas baixadas.`, button: 'Escolher outra pasta', onclick: pick });
  rememberFolder(rec.id, handle).catch(() => {});
  document.title = 'Minhas aulas';
  window.AVA_HOST = { data: playerData(index, { geradoEm, ext: chrome.runtime.id, folderId: rec.id }), handle, folderId: rec.id, vendor: '../vendor' };
  app.replaceChildren();
  const s = document.createElement('script');
  s.src = 'player/player.js';
  document.body.append(s);
}

function askPermission(rec) {
  screen({
    ic: 'folder',
    title: 'Suas aulas estão prontas',
    text: `O Chrome pede uma confirmação para a página usar a pasta “${rec.name}”. Escolha “Permitir em todas as visitas” e ele não pergunta mais.`,
    button: 'Abrir minhas aulas',
    onclick: async () => {
      let p = 'denied';
      try {
        p = await rec.handle.requestPermission({ mode: 'readwrite' });
      } catch {
        /* pasta sumiu */
      }
      if (p === 'granted') return start(rec);
      screen({ ic: 'alert', title: 'Sem acesso à pasta', text: 'Sem a permissão, a página não consegue mostrar as aulas nem salvar seu progresso.', button: 'Tentar de novo', onclick: () => askPermission(rec) });
    },
  });
}

/** Só quando a extensão não conhece a pasta (outro computador, extensão reinstalada). */
async function pick() {
  let dir;
  try {
    dir = await window.showDirectoryPicker({ id: 'ava-pasta', mode: 'readwrite', startIn: 'downloads' });
  } catch (err) {
    if (err?.name !== 'AbortError') screen({ ic: 'alert', title: 'Não consegui abrir a pasta', text: String(err?.message || err), button: 'Tentar de novo', onclick: pick });
    return;
  }
  if (!(await hasFile(dir, INDEX_FILE))) {
    const inner = await dir.getDirectoryHandle(FOLDER_NAME).catch(() => null);
    if (inner && (await hasFile(inner, INDEX_FILE))) dir = inner;
    else return screen({ ic: 'alert', title: 'Essa não é a pasta das aulas', text: `Escolha a pasta onde está o arquivo “${INDEX_FILE}” (por exemplo, “${FOLDER_NAME}”).`, button: 'Escolher de novo', onclick: pick });
  }
  let id = wantedId;
  try {
    id = readPlayerData(await (await (await dir.getFileHandle(INDEX_FILE)).getFile()).text()).folderId || id;
  } catch {
    /* sem id na página antiga */
  }
  id ||= crypto.randomUUID();
  await rememberFolder(id, dir);
  history.replaceState(null, '', `?f=${encodeURIComponent(id)}${location.hash}`);
  start({ id, name: dir.name, handle: dir });
}

(async () => {
  let rec = wantedId ? await getFolder(wantedId).catch(() => null) : null;
  if (!rec && !wantedId) rec = (await listFolders().catch(() => []))[0] || null;
  if (!rec)
    return screen({
      title: 'Onde estão suas aulas?',
      text: 'Esta extensão ainda não conhece esta pasta. Escolha a pasta das aulas uma vez e ela fica lembrada.',
      button: 'Escolher a pasta das aulas',
      onclick: pick,
    });
  let p = 'prompt';
  try {
    p = await rec.handle.queryPermission({ mode: 'readwrite' });
  } catch {
    /* handle inválido */
  }
  if (p === 'granted') start(rec);
  else askPermission(rec);
})();
