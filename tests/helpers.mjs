import fs from 'node:fs';

/** Simula um CDN com suporte a HEAD e Range; permite injetar falhas por URL. */
export function fakeCdn(files, { failOnce = new Map(), ignoreRange = false, delay = 0, chunkDelay = 0 } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', range: opts.headers?.Range || null });
    if (delay) await new Promise((r) => setTimeout(r, delay));
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const body = files.get(url);
    if (!body) return new Response('not found', { status: 404 });
    if (opts.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': String(body.length) } });
    let start = 0;
    let status = 200;
    const headers = { 'content-length': String(body.length) };
    const m = /bytes=(\d+)-(\d*)/.exec(opts.headers?.Range || '');
    if (m && !ignoreRange) {
      start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : body.length - 1;
      status = 206;
      headers['content-range'] = `bytes ${start}-${end}/${body.length}`;
      headers['content-length'] = String(end - start + 1);
      const slice = body.subarray(start, end + 1);
      return streamResponse(slice, status, headers, failOnce, url, opts.signal, chunkDelay);
    }
    return streamResponse(body.subarray(start), status, headers, failOnce, url, opts.signal, chunkDelay);
  };
  return { fetchImpl, calls };
}

function streamResponse(bytes, status, headers, failOnce, url, signal, chunkDelay = 0) {
  let sent = 0;
  const failAt = failOnce.get(url);
  const stream = new ReadableStream({
    async pull(controller) {
      if (chunkDelay) await new Promise((r) => setTimeout(r, chunkDelay));
      if (signal?.aborted) {
        controller.error(new DOMException('Aborted', 'AbortError'));
        return;
      }
      if (failAt != null && sent >= failAt) {
        failOnce.delete(url);
        controller.error(new TypeError('Failed to fetch'));
        return;
      }
      const n = Math.min(64 * 1024, bytes.length - sent, failAt != null ? failAt - sent || 1 : Infinity);
      if (n <= 0 || sent >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(sent, sent + n));
      sent += n;
    },
  });
  return new Response(stream, { status, headers });
}

export function randomBytes(n, seed = 1) {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

/** FileSystemFileHandle mínimo em cima de um arquivo real (para validar o ZIP com ferramentas de verdade). */
export function nodeFileHandle(path) {
  return {
    async createWritable() {
      const fd = fs.openSync(path, 'w');
      return {
        async write({ type = 'write', position, data, size }) {
          if (type === 'truncate') fs.ftruncateSync(fd, size);
          else fs.writeSync(fd, data, 0, data.length, position);
        },
        async close() {
          fs.closeSync(fd);
        },
        async abort() {
          fs.closeSync(fd);
          fs.rmSync(path, { force: true });
        },
      };
    },
  };
}

/** FileSystemDirectoryHandle em memória, com o subconjunto de API que a extensão usa. */
export function memoryDir(name = 'root') {
  const children = new Map();
  const dir = {
    kind: 'directory',
    name,
    children,
    async getDirectoryHandle(n, { create = false } = {}) {
      let c = children.get(n);
      if (!c) {
        if (!create) throw Object.assign(new Error('nf'), { name: 'NotFoundError' });
        c = memoryDir(n);
        children.set(n, c);
      }
      if (c.kind !== 'directory') throw Object.assign(new Error('tm'), { name: 'TypeMismatchError' });
      return c;
    },
    async getFileHandle(n, { create = false } = {}) {
      let c = children.get(n);
      if (!c) {
        if (!create) throw Object.assign(new Error('nf'), { name: 'NotFoundError' });
        c = memoryFile(n);
        children.set(n, c);
      }
      if (c.kind !== 'file') throw Object.assign(new Error('tm'), { name: 'TypeMismatchError' });
      return c;
    },
    async removeEntry(n) {
      if (!children.delete(n)) throw Object.assign(new Error('nf'), { name: 'NotFoundError' });
    },
    async *entries() {
      for (const [k, v] of children) yield [k, v];
    },
  };
  return dir;
}

function memoryFile(name) {
  const file = {
    kind: 'file',
    name,
    data: new Uint8Array(0),
    async getFile() {
      return { size: file.data.length };
    },
    async createWritable() {
      let buf = [];
      let len = 0;
      return {
        async write(bytes) {
          buf.push(bytes);
          len += bytes.length;
        },
        async truncate(n) {
          if (n !== 0) throw new Error('only 0');
          buf = [];
          len = 0;
        },
        async close() {
          const out = new Uint8Array(len);
          let o = 0;
          for (const b of buf) {
            out.set(b, o);
            o += b.length;
          }
          file.data = out;
        },
        async abort() {},
      };
    },
  };
  return file;
}
