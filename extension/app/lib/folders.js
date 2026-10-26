// Pastas de aulas que a extensão já conhece (escolhidas ao baixar ou ao atualizar a página).
// Guardar o handle aqui deixa a página "Assistir aulas" abrir pela extensão sem pedir a pasta de novo.

const DB = 'ava-folders';
let dbP = null;

function db() {
  dbP ??= new Promise((ok, ko) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('folders', { keyPath: 'id' });
    r.onsuccess = () => ok(r.result);
    r.onerror = () => ko(r.error);
  }).catch((err) => {
    dbP = null;
    throw err;
  });
  return dbP;
}

function tx(mode, fn) {
  return db().then(
    (d) =>
      new Promise((ok, ko) => {
        const t = d.transaction('folders', mode);
        const req = fn(t.objectStore('folders'));
        t.oncomplete = () => ok(req?.result);
        t.onerror = () => ko(t.error);
        t.onabort = () => ko(t.error);
      }),
  );
}

/** @param handle FileSystemDirectoryHandle da pasta das aulas (onde está "Assistir aulas.html") */
export function rememberFolder(id, handle) {
  return tx('readwrite', (s) => s.put({ id, name: handle.name, handle, at: Date.now() }));
}

export function getFolder(id) {
  return tx('readonly', (s) => s.get(id));
}

export async function listFolders() {
  const all = (await tx('readonly', (s) => s.getAll())) || [];
  return all.sort((a, b) => b.at - a.at);
}
