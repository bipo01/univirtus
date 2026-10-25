/** Executa fn para cada item com no máximo `limit` em paralelo. Mantém a ordem dos resultados. */
export async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes, { approx = false } = {}) {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < UNITS.length - 1) {
    v /= 1024;
    u += 1;
  }
  const digits = u === 0 ? 0 : v >= 100 ? 0 : v >= 10 ? 1 : 2;
  const text = `${v.toLocaleString('pt-BR', { maximumFractionDigits: digits, minimumFractionDigits: u >= 3 ? 1 : 0 })} ${UNITS[u]}`;
  return approx ? `≈ ${text}` : text;
}

export function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min${s % 60 && m < 10 ? ` ${s % 60} s` : ''}`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

export function plural(n, one, many) {
  return `${n.toLocaleString('pt-BR')} ${n === 1 ? one : many}`;
}
