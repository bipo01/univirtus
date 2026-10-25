// Nomes de arquivos e pastas seguros para Windows, macOS e Linux.
// Os nomes precisam ser determinísticos: o modo "Pasta" usa o caminho para
// pular arquivos que já foram baixados numa execução anterior.

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Remove caracteres proibidos, espaços repetidos e pontos finais; limita o tamanho. */
export function safeName(input, max = 90) {
  let s = String(input ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  if (!s) s = 'Sem título';
  if (RESERVED.test(s)) s = `_${s}`;
  const chars = Array.from(s);
  if (chars.length > max) s = chars.slice(0, max).join('').trim().replace(/[. ]+$/g, '');
  return s;
}

/** Igual a safeName, mas preserva a extensão (".mp4", ".pdf"...). */
export function safeFileName(base, ext, max = 110) {
  const e = ext ? `.${String(ext).replace(/^\.+/, '').toLowerCase()}` : '';
  return safeName(base, Math.max(10, max - e.length)) + e;
}

/** Separa "arquivo.pdf" em ["arquivo", "pdf"]. */
export function splitExt(fileName) {
  const s = String(fileName ?? '');
  const m = /^(.*?)\.([A-Za-z0-9]{1,6})$/.exec(s);
  return m ? [m[1], m[2]] : [s, ''];
}

export const pad = (n, width = 2) => String(n).padStart(width, '0');

/** Garante nomes únicos dentro de uma mesma pasta: "x.mp4", "x (2).mp4"... */
export function createUniquer() {
  const used = new Map();
  return (path) => {
    const key = path.toLowerCase();
    if (!used.has(key)) {
      used.set(key, 1);
      return path;
    }
    let n = used.get(key);
    const slash = path.lastIndexOf('/');
    const dir = path.slice(0, slash + 1);
    const [base, ext] = splitExt(path.slice(slash + 1));
    let candidate;
    do {
      n += 1;
      candidate = `${dir}${base} (${n})${ext ? `.${ext}` : ''}`;
    } while (used.has(candidate.toLowerCase()));
    used.set(key, n);
    used.set(candidate.toLowerCase(), 1);
    return candidate;
  };
}

const SMALL_WORDS = new Set(['a', 'à', 'ao', 'as', 'com', 'da', 'das', 'de', 'do', 'dos', 'e', 'em', 'na', 'nas', 'no', 'nos', 'o', 'os', 'ou', 'para', 'por']);

/** "BACHARELADO EM FILOSOFIA" → "Bacharelado em Filosofia". Textos que já têm minúsculas ficam como estão. */
export function prettyCase(input) {
  const s = String(input ?? '').trim();
  if (!s || s !== s.toUpperCase() || !/[A-ZÀ-Ý]/.test(s)) return s;
  return s
    .toLowerCase()
    .split(/(\s+|-)/)
    .map((w, i) => {
      if (!w.trim() || w === '-') return w;
      if (i > 0 && SMALL_WORDS.has(w)) return w;
      if (/^(i|ii|iii|iv|v|vi|vii|viii|ix|x)$/.test(w)) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join('');
}

/** Texto comparável para busca: minúsculo e sem acentos. */
export function fold(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}
