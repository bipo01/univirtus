/* Junta duas cópias dos dados do aluno (outra aba, outro computador, %storage%/dados.json).
 * Script clássico: embutido na página antes do player.js e testado no Node (tests/player.test.mjs).
 * - Progresso de cada item: posição/página pelo `at` mais novo; "concluída" pelo `dAt` mais novo,
 *   para uma posição salva depois não apagar a marcação feita em outro lugar.
 * - Destaques e notas: por id, o registro com `at` mais novo vence; apagados viram lápide `{id, del, at}`.
 * - Campos de versões futuras são mantidos. */
var AvaMerge = (() => {
  'use strict';
  const VERSION = 1;
  const PROGRESS = ['done', 'doneAt', 'dAt'];

  function mergeItem(a, b) {
    if (!a) return b;
    if (!b) return a;
    const out = (b.at || 0) > (a.at || 0) ? { ...a, ...b } : { ...b, ...a };
    const da = a.dAt || 0;
    const db = b.dAt || 0;
    if (da !== db) {
      const src = db > da ? b : a;
      for (const k of PROGRESS) {
        if (k in src) out[k] = src[k];
        else delete out[k];
      }
    }
    return out;
  }

  function mergeData(a, b) {
    a = a || {};
    b = b || {};
    const out = { ...b, ...a, v: Math.max(a.v || VERSION, b.v || VERSION), items: { ...(a.items || {}) }, hl: {}, notes: {}, last: a.last || null };
    if (b.last && (!out.last || b.last.at > out.last.at)) out.last = b.last;
    for (const [k, v] of Object.entries(b.items || {})) out.items[k] = mergeItem(out.items[k], v);
    for (const kind of ['hl', 'notes']) {
      const keys = new Set([...Object.keys(a[kind] || {}), ...Object.keys(b[kind] || {})]);
      for (const k of keys) {
        const m = new Map();
        for (const x of [...(a[kind]?.[k] || []), ...(b[kind]?.[k] || [])]) {
          const cur = m.get(x.id);
          if (!cur || (x.at || 0) > (cur.at || 0)) m.set(x.id, x);
        }
        out[kind][k] = [...m.values()];
      }
    }
    return out;
  }

  return { VERSION, mergeData, mergeItem };
})();
