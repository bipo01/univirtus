// Escritor de ZIP "store" (sem compressão — MP4/MP3/PDF já são comprimidos) com ZIP64,
// pensado para gravar direto no disco e em paralelo:
//
// - Arquivos de tamanho conhecido recebem uma "vaga" fixa (cabeçalho + dados) logo no início;
//   cada download escreve na sua própria posição, ao mesmo tempo que os outros.
// - O cabeçalho local de cada arquivo é gravado no fim (quando o CRC já é conhecido).
// - Arquivos de tamanho desconhecido e os gerados (índice, relatório) vão para o fim, um por vez.
// - O diretório central (com ZIP64 quando passa de 4 GB / 65535 arquivos) fecha o arquivo.
//
// O "sink" só precisa de write(position, Uint8Array) — o mesmo código roda no navegador
// (FileSystemWritableFileStream) e nos testes (fs do Node).

import { crc32, crc32Zeros } from './crc32.js';

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
const FLAG_UTF8 = 0x0800;
const encoder = new TextEncoder();

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export class ZipEntry {
  constructor(path, offset, size, { date, zip64, unixMode = 0 }) {
    this.unixMode = unixMode;
    this.path = path;
    this.name = encoder.encode(path);
    if (this.name.length > MAX16) throw new Error(`Caminho longo demais: ${path}`);
    this.offset = offset;
    this.size = size;
    this.zip64Local = zip64 || size >= MAX32;
    this.headerLength = 30 + this.name.length + (this.zip64Local ? 20 : 0);
    this.dataOffset = offset + this.headerLength;
    this.crc = 0;
    this.written = 0;
    this.dos = dosDateTime(date);
    this.done = false;
  }

  localHeader() {
    const buf = new Uint8Array(this.headerLength);
    const v = new DataView(buf.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, this.zip64Local ? 45 : 20, true);
    v.setUint16(6, FLAG_UTF8, true);
    v.setUint16(8, 0, true); // store
    v.setUint16(10, this.dos.time, true);
    v.setUint16(12, this.dos.date, true);
    v.setUint32(14, this.crc, true);
    v.setUint32(18, this.zip64Local ? MAX32 : this.size, true);
    v.setUint32(22, this.zip64Local ? MAX32 : this.size, true);
    v.setUint16(26, this.name.length, true);
    v.setUint16(28, this.zip64Local ? 20 : 0, true);
    buf.set(this.name, 30);
    if (this.zip64Local) {
      const x = 30 + this.name.length;
      v.setUint16(x, 0x0001, true);
      v.setUint16(x + 2, 16, true);
      v.setBigUint64(x + 4, BigInt(this.size), true);
      v.setBigUint64(x + 12, BigInt(this.size), true);
    }
    return buf;
  }

  centralHeader(forceZip64) {
    const bigSize = forceZip64 || this.size >= MAX32;
    const bigOffset = forceZip64 || this.offset >= MAX32;
    const extraLen = bigSize || bigOffset ? 4 + (bigSize ? 16 : 0) + (bigOffset ? 8 : 0) : 0;
    const buf = new Uint8Array(46 + this.name.length + extraLen);
    const v = new DataView(buf.buffer);
    const needs64 = extraLen > 0 || this.zip64Local;
    v.setUint32(0, 0x02014b50, true);
    // Versão 4.5. Sistema "MS-DOS" com atributos 0 = arquivo comum em qualquer SO; "Unix" só quando
    // a entrada precisa de permissão (ex.: script executável), com o modo nos 16 bits altos.
    v.setUint16(4, this.unixMode ? (3 << 8) | 45 : 45, true);
    v.setUint16(6, needs64 ? 45 : 20, true);
    v.setUint16(8, FLAG_UTF8, true);
    v.setUint16(10, 0, true);
    v.setUint16(12, this.dos.time, true);
    v.setUint16(14, this.dos.date, true);
    v.setUint32(16, this.crc, true);
    v.setUint32(20, bigSize ? MAX32 : this.size, true);
    v.setUint32(24, bigSize ? MAX32 : this.size, true);
    v.setUint16(28, this.name.length, true);
    v.setUint16(30, extraLen, true);
    v.setUint16(32, 0, true);
    v.setUint16(34, 0, true);
    v.setUint16(36, 0, true);
    v.setUint32(38, this.unixMode ? (this.unixMode << 16) >>> 0 : 0, true);
    v.setUint32(42, bigOffset ? MAX32 : this.offset, true);
    buf.set(this.name, 46);
    if (extraLen) {
      let x = 46 + this.name.length;
      v.setUint16(x, 0x0001, true);
      v.setUint16(x + 2, extraLen - 4, true);
      x += 4;
      if (bigSize) {
        v.setBigUint64(x, BigInt(this.size), true);
        v.setBigUint64(x + 8, BigInt(this.size), true);
        x += 16;
      }
      if (bigOffset) v.setBigUint64(x, BigInt(this.offset), true);
    }
    return buf;
  }
}

export class ZipWriter {
  /**
   * @param sink { write(position:number, data:Uint8Array): Promise<void> }
   */
  constructor(sink, { date = new Date(), forceZip64 = false } = {}) {
    this.sink = sink;
    this.date = date;
    this.forceZip64 = forceZip64;
    this.entries = [];
    this.end = 0; // próximo byte livre
    this.tailBusy = false;
    this.finished = false;
  }

  /** Reserva espaço para um arquivo de tamanho conhecido. Pode ser chamado para vários antes de escrever. */
  reserve(path, size) {
    if (this.tailBusy) throw new Error('Há um arquivo de tamanho desconhecido sendo gravado.');
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Tamanho inválido para ${path}`);
    const entry = new ZipEntry(path, this.end, size, { date: this.date, zip64: this.forceZip64 });
    this.end = entry.dataOffset + size;
    this.entries.push(entry);
    return entry;
  }

  /** Grava um pedaço dos dados de uma entrada (reservada ou anexada), na posição correta. */
  async write(entry, bytes) {
    const limit = entry.appending ? MAX32 - 1 : entry.size;
    if (entry.written + bytes.length > limit) throw new Error(`Dados além do tamanho previsto em ${entry.path}`);
    await this.sink.write(entry.dataOffset + entry.written, bytes);
    entry.crc = crc32(bytes, entry.crc);
    entry.written += bytes.length;
  }

  /** Volta a entrada para o início (por ex. quando o servidor não aceita continuar o download). */
  rewind(entry) {
    entry.written = 0;
    entry.crc = 0;
  }

  /** Fecha a entrada. Se faltaram bytes (falha definitiva), completa com zeros para manter o ZIP válido. */
  async close(entry) {
    if (entry.done) return;
    if (entry.written < entry.size) {
      const missing = entry.size - entry.written;
      entry.crc = crc32Zeros(missing, entry.crc);
      // O intervalo pode estar no meio do arquivo (já estendido por outras entradas): grava os zeros explicitamente.
      const block = new Uint8Array(Math.min(missing, 1 << 20));
      let pos = entry.dataOffset + entry.written;
      let left = missing;
      while (left > 0) {
        const n = Math.min(left, block.length);
        await this.sink.write(pos, n === block.length ? block : block.subarray(0, n));
        pos += n;
        left -= n;
      }
      entry.incomplete = true;
      entry.written = entry.size;
    }
    await this.sink.write(entry.offset, entry.localHeader());
    entry.done = true;
  }

  /** Começa um arquivo de tamanho desconhecido no fim do ZIP (um por vez; use write/rewind e depois endAppend). */
  beginAppend(path, { unixMode = 0 } = {}) {
    if (this.tailBusy) throw new Error('Já existe um arquivo sendo anexado.');
    this.tailBusy = true;
    const entry = new ZipEntry(path, this.end, 0, { date: this.date, zip64: this.forceZip64, unixMode });
    entry.appending = true;
    return entry;
  }

  async endAppend(entry) {
    entry.size = entry.written;
    entry.appending = false;
    await this.sink.write(entry.offset, entry.localHeader());
    entry.done = true;
    this.end = entry.dataOffset + entry.size;
    this.entries.push(entry);
    this.tailBusy = false;
    return entry;
  }

  /** Descarta o arquivo anexado: o espaço é reaproveitado pelo próximo. */
  abortAppend(entry) {
    entry.appending = false;
    this.tailBusy = false;
  }

  /** Atalho para gravar um arquivo pequeno já em memória no fim do ZIP. */
  async appendBytes(path, bytes, opts) {
    const entry = this.beginAppend(path, opts);
    try {
      if (bytes.length) await this.write(entry, bytes);
      return await this.endAppend(entry);
    } catch (err) {
      this.abortAppend(entry);
      throw err;
    }
  }

  /** Escreve o diretório central. Entradas reservadas e não fechadas são completadas com zeros. */
  async finish() {
    if (this.finished) return this.end;
    for (const e of this.entries) if (!e.done) await this.close(e);
    const cdOffset = this.end;
    const parts = this.entries.map((e) => e.centralHeader(this.forceZip64));
    const cdSize = parts.reduce((s, p) => s + p.length, 0);
    const count = this.entries.length;
    const zip64 = this.forceZip64 || count >= MAX16 || cdOffset >= MAX32 || cdSize >= MAX32 || this.entries.some((e) => e.size >= MAX32 || e.offset >= MAX32);

    const tail = [];
    if (zip64) {
      const rec = new Uint8Array(56);
      const v = new DataView(rec.buffer);
      v.setUint32(0, 0x06064b50, true);
      v.setBigUint64(4, 44n, true);
      v.setUint16(12, 45, true);
      v.setUint16(14, 45, true);
      v.setUint32(16, 0, true);
      v.setUint32(20, 0, true);
      v.setBigUint64(24, BigInt(count), true);
      v.setBigUint64(32, BigInt(count), true);
      v.setBigUint64(40, BigInt(cdSize), true);
      v.setBigUint64(48, BigInt(cdOffset), true);
      const loc = new Uint8Array(20);
      const l = new DataView(loc.buffer);
      l.setUint32(0, 0x07064b50, true);
      l.setUint32(4, 0, true);
      l.setBigUint64(8, BigInt(cdOffset + cdSize), true);
      l.setUint32(16, 1, true);
      tail.push(rec, loc);
    }
    const eocd = new Uint8Array(22);
    const d = new DataView(eocd.buffer);
    d.setUint32(0, 0x06054b50, true);
    d.setUint16(8, zip64 ? MAX16 : count, true);
    d.setUint16(10, zip64 ? MAX16 : count, true);
    d.setUint32(12, zip64 ? MAX32 : cdSize, true);
    d.setUint32(16, zip64 ? MAX32 : cdOffset, true);
    tail.push(eocd);

    const all = new Uint8Array(cdSize + tail.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of [...parts, ...tail]) {
      all.set(p, o);
      o += p.length;
    }
    await this.sink.write(cdOffset, all);
    this.finished = true;
    this.end = cdOffset + all.length;
    return this.end;
  }
}
