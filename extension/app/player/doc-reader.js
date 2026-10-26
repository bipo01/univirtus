/* Leitor de .doc (Word 97–2003, binário) para a prévia no player: texto, negrito/itálico/sublinhado,
 * tamanho da letra, alinhamento e tabelas. Imagens e objetos não aparecem.
 * Script clássico (embutido na página antes do player.js; testado no Node em tests/player.test.mjs).
 * Formatos: [MS-CFB] (contêiner) e [MS-DOC] (FIB, CLX/peças, FKPs de parágrafo e caractere). */
var AvaDoc = (() => {
  'use strict';
  const END = 0xfffffffa;

  function cfb(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (u8.length < 512 || dv.getUint32(0, true) !== 0xe011cfd0 || dv.getUint32(4, true) !== 0xe11ab1a1) throw new Error('Este arquivo não é um .doc do Word.');
    const secSize = 1 << dv.getUint16(30, true);
    const miniSize = 1 << dv.getUint16(32, true);
    const dirStart = dv.getUint32(48, true);
    const miniCutoff = dv.getUint32(56, true);
    const miniFatStart = dv.getUint32(60, true);
    const difatStart = dv.getUint32(68, true);
    const nDifat = dv.getUint32(72, true);
    const off = (s) => (s + 1) * secSize;
    const u32 = (o) => (o + 4 <= u8.length ? dv.getUint32(o, true) : END);

    const difat = [];
    for (let i = 0; i < 109; i++) {
      const v = u32(76 + i * 4);
      if (v < END) difat.push(v);
    }
    const per = secSize / 4;
    let d = difatStart;
    for (let k = 0; k < nDifat && d < END; k++) {
      for (let i = 0; i < per - 1; i++) {
        const v = u32(off(d) + i * 4);
        if (v < END) difat.push(v);
      }
      d = u32(off(d) + (per - 1) * 4);
    }
    const fat = new Uint32Array(difat.length * per);
    difat.forEach((s, i) => {
      for (let j = 0; j < per; j++) fat[i * per + j] = u32(off(s) + j * 4);
    });
    const chain = (start, table) => {
      const out = [];
      const seen = new Set();
      for (let s = start; s < END && s < table.length && !seen.has(s); s = table[s]) {
        seen.add(s);
        out.push(s);
      }
      return out;
    };
    const gather = (secs, size, src, unit, base) => {
      const buf = new Uint8Array(secs.length * unit);
      secs.forEach((s, i) => buf.set(src.subarray(base(s), base(s) + unit), i * unit));
      return size == null ? buf : buf.subarray(0, size);
    };
    const big = (start, size) => gather(chain(start, fat), size, u8, secSize, off);

    const dir = big(dirStart);
    const entries = [];
    for (let i = 0; i + 128 <= dir.length; i += 128) {
      const e = new DataView(dir.buffer, dir.byteOffset + i, 128);
      const len = Math.min(64, e.getUint16(64, true));
      let name = '';
      for (let j = 0; j < len / 2 - 1; j++) name += String.fromCharCode(e.getUint16(j * 2, true));
      entries.push({ name, type: dir[i + 66], start: e.getUint32(116, true), size: e.getUint32(120, true) });
    }
    const root = entries[0];
    const mini = root ? big(root.start, root.size) : new Uint8Array(0);
    const mf = miniFatStart < END ? big(miniFatStart) : new Uint8Array(0);
    const mfv = new DataView(mf.buffer, mf.byteOffset, mf.byteLength);
    const miniFat = new Uint32Array(mf.length >> 2);
    for (let i = 0; i < miniFat.length; i++) miniFat[i] = mfv.getUint32(i * 4, true);

    return (name) => {
      const e = entries.find((x) => x.type === 2 && x.name === name);
      if (!e) return null;
      if (e.size < miniCutoff) return gather(chain(e.start, miniFat), e.size, mini, miniSize, (s) => s * miniSize);
      return big(e.start, e.size);
    };
  }

  /** Lista de [sprm, operando] de um grpprl. */
  function sprms(buf) {
    const out = [];
    let i = 0;
    while (i + 2 <= buf.length) {
      const sprm = buf[i] | (buf[i + 1] << 8);
      i += 2;
      let len;
      switch (sprm >> 13) {
        case 0:
        case 1:
          len = 1;
          break;
        case 2:
        case 4:
        case 5:
          len = 2;
          break;
        case 3:
          len = 4;
          break;
        case 7:
          len = 3;
          break;
        default:
          len = sprm === 0xd608 || sprm === 0xd606 ? 2 + ((buf[i] | (buf[i + 1] << 8)) - 1) : 1 + buf[i];
      }
      if (i + len > buf.length) break;
      out.push([sprm, buf.subarray(i, i + len)]);
      i += len;
    }
    return out;
  }
  const on = (v) => v === 1 || v === 0x81;

  /** Runs de propriedades por posição (FC) a partir de uma PlcBte (parágrafo ou caractere). */
  function fkpRuns(wd, table, fc, lcb, papx) {
    const runs = [];
    if (!lcb) return runs;
    const tv = new DataView(table.buffer, table.byteOffset, table.byteLength);
    const n = (lcb - 4) / 8;
    for (let k = 0; k < n; k++) {
      const pn = tv.getUint32(fc + (n + 1) * 4 + k * 4, true) & 0x3fffff;
      const page = wd.subarray(pn * 512, pn * 512 + 512);
      if (page.length < 512) continue;
      const pv = new DataView(page.buffer, page.byteOffset, 512);
      const crun = page[511];
      for (let i = 0; i < crun; i++) {
        const start = pv.getUint32(i * 4, true);
        const end = pv.getUint32((i + 1) * 4, true);
        const bOff = papx ? page[4 * (crun + 1) + 13 * i] : page[4 * (crun + 1) + i];
        const props = {};
        if (bOff) {
          const o = bOff * 2;
          let grp;
          if (papx) {
            const cb = page[o];
            grp = cb ? page.subarray(o + 1, o + 1 + 2 * cb - 1) : page.subarray(o + 2, o + 2 + 2 * page[o + 1]);
            grp = grp.subarray(2); // istd
          } else grp = page.subarray(o + 1, o + 1 + page[o]);
          for (const [s, op] of sprms(grp)) {
            const v = op[0];
            if (papx) {
              if (s === 0x2416) props.inTable = v !== 0;
              else if (s === 0x2417) props.ttp = v !== 0;
              else if (s === 0x6649) props.itap = op[0] | (op[1] << 8);
              else if (s === 0x244c) props.ttp = v !== 0;
              else if (s === 0x2461 || s === 0x2403) props.jc = v;
            } else if (s === 0x0835) props.b = on(v);
            else if (s === 0x0836) props.i = on(v);
            else if (s === 0x2a3e) props.u = v !== 0;
            else if (s === 0x0837) props.s = on(v);
            else if (s === 0x4a43) props.size = (op[0] | (op[1] << 8)) / 2;
            else if (s === 0x0855) props.spec = on(v);
          }
        }
        runs.push({ start, end, props });
      }
    }
    return runs.sort((a, b) => a.start - b.start);
  }
  function lookup(runs, fc) {
    let lo = 0;
    let hi = runs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = runs[mid];
      if (fc < r.start) hi = mid - 1;
      else if (fc >= r.end) lo = mid + 1;
      else return r.props;
    }
    return {};
  }

  /**
   * @returns {{ blocks: Array<{type:'p', align, runs:[{text,b,i,u,s,size}]} | {type:'table', rows: Array<Array<Array<p>>>}> }}
   */
  function parse(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const stream = cfb(u8);
    const wd = stream('WordDocument');
    if (!wd || wd.length < 0x200) throw new Error('Este arquivo não é um .doc do Word.');
    const w = new DataView(wd.buffer, wd.byteOffset, wd.byteLength);
    if (w.getUint16(0, true) !== 0xa5ec) throw new Error('Versão do Word não suportada (anterior ao Word 97).');
    const flags = w.getUint16(0x0a, true);
    if (flags & 0x0100) throw new Error('Este documento tem senha.');
    const table = stream(flags & 0x0200 ? '1Table' : '0Table');
    if (!table) throw new Error('Documento incompleto.');
    const tv = new DataView(table.buffer, table.byteOffset, table.byteLength);

    let p = 32;
    p += 2 + w.getUint16(p, true) * 2;
    const lw = p + 2;
    p += 2 + w.getUint16(p, true) * 4;
    const ccpText = w.getInt32(lw + 12, true);
    const fcl = p + 2;
    const pair = (i) => [w.getUint32(fcl + i * 8, true), w.getUint32(fcl + i * 8 + 4, true)];
    const [fcClx, lcbClx] = pair(33);
    if (!lcbClx || fcClx >= table.length) throw new Error('Documento sem texto.');

    // Peças de texto (CLX): onde cada trecho do texto está e se é 8 bits (cp1252) ou UTF-16.
    let q = fcClx;
    while (table[q] === 0x01) q += 3 + tv.getUint16(q + 1, true);
    if (table[q] !== 0x02) throw new Error('Documento sem texto.');
    const lcb = tv.getUint32(q + 1, true);
    q += 5;
    const n = (lcb - 4) / 12;
    const cp1252 = new TextDecoder('windows-1252');
    const utf16 = new TextDecoder('utf-16le');
    const utf8 = new TextDecoder('utf-8', { fatal: true });
    let text = '';
    const fcs = [];
    for (let k = 0; k < n && text.length < ccpText; k++) {
      const cp0 = tv.getUint32(q + k * 4, true);
      const cp1 = tv.getUint32(q + (k + 1) * 4, true);
      const raw = tv.getUint32(q + (n + 1) * 4 + k * 8 + 2, true);
      const compressed = (raw & 0x40000000) !== 0;
      const fc = compressed ? (raw & 0x3fffffff) / 2 : raw;
      const count = Math.min(cp1 - cp0, ccpText - text.length);
      const bytes = wd.subarray(fc, fc + count * (compressed ? 1 : 2));
      if (!compressed) {
        text += utf16.decode(bytes);
        for (let i = 0; i < count; i++) fcs.push(fc + i * 2);
        continue;
      }
      // O Word grava 8 bits em cp1252; o TextEdit/Pages gravam UTF-8 no mesmo lugar. UTF-8 válido com acento é UTF-8.
      let u = null;
      if (bytes.some((b) => b >= 0x80)) {
        try {
          u = utf8.decode(bytes);
        } catch {
          u = null;
        }
      }
      if (u == null) {
        text += cp1252.decode(bytes);
        for (let i = 0; i < count; i++) fcs.push(fc + i);
      } else {
        text += u;
        for (let i = 0; i < bytes.length; i++) {
          const b = bytes[i];
          if ((b & 0xc0) === 0x80) continue;
          fcs.push(fc + i);
          if (b >= 0xf0) fcs.push(fc + i); // fora do BMP: dois code units no JS
        }
      }
    }

    const [fcPap, lcbPap] = pair(13);
    const [fcChp, lcbChp] = pair(12);
    const paps = fkpRuns(wd, table, fcPap, lcbPap, true);
    const chps = fkpRuns(wd, table, fcChp, lcbChp, false);
    const ALIGN = ['left', 'center', 'right', 'justify'];

    const blocks = [];
    let runs = [];
    let rowCells = [];
    let cell = [];
    let tableBlock = null;
    let field = []; // pilha: true = dentro das instruções do campo (não mostra)
    const push = (ch, props) => {
      const last = runs[runs.length - 1];
      const key = `${props.b ? 1 : 0}${props.i ? 1 : 0}${props.u ? 1 : 0}${props.s ? 1 : 0}${props.size || 0}`;
      if (last && last.key === key) last.text += ch;
      else runs.push({ key, text: ch, b: props.b, i: props.i, u: props.u, s: props.s, size: props.size });
    };
    const endPara = (pap) => {
      const para = { type: 'p', align: ALIGN[pap.jc] || 'left', runs: runs.map(({ key, ...r }) => r) };
      runs = [];
      return para;
    };
    const closeTable = () => {
      if (tableBlock && tableBlock.rows.length) blocks.push(tableBlock);
      tableBlock = null;
    };

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const c = ch.charCodeAt(0);
      if (c === 0x13) {
        field.push(true);
        continue;
      }
      if (c === 0x14) {
        if (field.length) field[field.length - 1] = false;
        continue;
      }
      if (c === 0x15) {
        field.pop();
        continue;
      }
      if (c === 0x0d || c === 0x07) {
        const pap = lookup(paps, fcs[i]);
        const inTable = pap.inTable || pap.itap > 0 || (c === 0x07 && !paps.length);
        if (c === 0x07 && (pap.ttp || (!paps.length && !runs.length && cell.length === 0 && rowCells.length))) {
          // Fim de linha da tabela.
          runs = [];
          tableBlock ||= { type: 'table', rows: [] };
          tableBlock.rows.push(rowCells);
          rowCells = [];
          cell = [];
          continue;
        }
        const para = endPara(pap);
        if (inTable) {
          cell.push(para);
          if (c === 0x07) {
            rowCells.push(cell);
            cell = [];
          }
        } else {
          if (rowCells.length || cell.length) {
            tableBlock ||= { type: 'table', rows: [] };
            if (cell.length) rowCells.push(cell);
            if (rowCells.length) tableBlock.rows.push(rowCells);
            rowCells = [];
            cell = [];
          }
          closeTable();
          blocks.push(para);
        }
        continue;
      }
      if (field.some(Boolean)) continue;
      const props = lookup(chps, fcs[i]);
      if (c === 0x0b) push('\n', props);
      else if (c === 0x09) push('\t', props);
      else if (c === 0x0c) {
        if (runs.length) blocks.push(endPara({}));
        closeTable();
        blocks.push({ type: 'break' });
      } else if (c === 0x1e) push('-', props);
      else if (c === 0x1f) continue;
      else if (c < 0x20 || (props.spec && (c === 0x01 || c === 0x08 || c === 0x02 || c === 0x05))) continue;
      else push(ch, props);
    }
    if (runs.length) blocks.push(endPara({}));
    if (rowCells.length) {
      tableBlock ||= { type: 'table', rows: [] };
      tableBlock.rows.push(rowCells);
    }
    closeTable();
    return { blocks };
  }

  return { parse };
})();
