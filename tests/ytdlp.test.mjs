import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildMacScript, buildWindowsScript, MAC_SCRIPT, WIN_SCRIPT } from '../extension/app/lib/ytdlp.js';
import { ZipTarget, DirectoryTarget, DownloadJob, mergeExternos } from '../extension/app/lib/downloader.js';
import { memoryDir, nodeFileHandle } from './helpers.mjs';

const items = [
  { base: "Curso/Ética e Política/Aula 01 - O que é 100% justo/YouTube - D'Artagnan \"fala\"", url: 'https://www.youtube.com/watch?v=abc&t=10', playlist: false },
  { base: 'Curso/Disc/Aula 02 - X/YouTube - Lista', url: 'https://www.youtube.com/playlist?list=PL1', playlist: true },
];

test('script do Mac: sintaxe válida e chamadas exatas ao yt-dlp (acentos, aspas, % e playlist)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-yt-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(dir, 'calls.txt');
  // yt-dlp falso: registra cada argumento numa linha e separa as chamadas.
  fs.writeFileSync(path.join(bin, 'yt-dlp'), `#!/bin/bash\nif [ "$1" = "-U" ]; then exit 0; fi\nfor a in "$@"; do printf '%s\\n' "$a" >> ${JSON.stringify(log)}; done\necho '---' >> ${JSON.stringify(log)}\n`, { mode: 0o755 });
  // deno e ffmpeg "instalados": o teste não baixa nada da internet.
  for (const tool of ['deno', 'ffmpeg']) fs.writeFileSync(path.join(bin, tool), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const script = path.join(dir, MAC_SCRIPT);
  fs.writeFileSync(script, buildMacScript(items));
  execFileSync('bash', ['-n', script]);
  const out = execFileSync('bash', [script], { env: { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin`, TERM: 'dumb' }, input: '\n' }).toString();
  assert.match(out, /Pronto! Todos os vídeos do YouTube foram baixados/);
  const calls = fs.readFileSync(log, 'utf8').split('---\n').filter(Boolean).map((c) => c.trim().split('\n'));
  assert.equal(calls.length, 2);
  const [a, b] = calls;
  assert.ok(a.includes('--no-playlist'));
  assert.equal(a[a.indexOf('-o') + 1], "Curso/Ética e Política/Aula 01 - O que é 100%% justo/YouTube - D'Artagnan \"fala\".%(ext)s");
  assert.equal(a.at(-1), 'https://www.youtube.com/watch?v=abc&t=10');
  assert.equal(a[a.indexOf('-f') + 1], 'bv*[vcodec^=avc1]+ba[ext=m4a]/bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b', 'com ffmpeg: junta vídeo e áudio');
  assert.ok(fs.existsSync(path.join(home, 'Library/Application Support/AVA Downloader')), 'ferramentas ficam na pasta do usuário');
  assert.ok(!b.includes('--no-playlist'));
  assert.equal(b[b.indexOf('-o') + 1], 'Curso/Disc/Aula 02 - X/YouTube - Lista/%(playlist_index)02d - %(title)s.%(ext)s');
});

test('script do Windows: CRLF, % dobrado para o cmd, caminhos com barra invertida', () => {
  const bat = buildWindowsScript(items);
  assert.ok(bat.includes('\r\n') && !/[^\r]\n/.test(bat), 'só CRLF');
  assert.match(bat.split('\r\n')[0], /^@echo off$/);
  // "100%" vira "100%%" para o yt-dlp e cada % é dobrado de novo para o cmd.
  assert.ok(bat.includes('-o "Curso\\Ética e Política\\Aula 01 - O que é 100%%%% justo\\YouTube - D\'Artagnan fala.%%(ext)s"'));
  assert.ok(bat.includes('"https://www.youtube.com/watch?v=abc&t=10"'));
  assert.ok(bat.includes('%%(playlist_index)02d'));
  // Nada de "call" (faria uma segunda expansão de %).
  assert.ok(!/^\s*call\b/im.test(bat));
});

const index = [{ nome: 'Curso', disciplinas: [{ nome: 'Disc', grupos: [{ nome: 'Aula 1', dir: 'Curso/Disc/Aula 01 - X', links: [], itens: [{ path: 'Curso/Disc/Aula 01 - X/YouTube - V.mp4', base: 'Curso/Disc/Aula 01 - X/YouTube - V', url: 'https://youtu.be/v', kind: 'youtube', titulo: 'V', playlist: false }] }] }] }];

test('ZIP com YouTube: script do Mac sai executável (ditto) e o índice lista o vídeo com link online', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ava-ytz-')), 'a.zip');
  await new DownloadJob({ entries: [], target: new ZipTarget(nodeFileHandle(file), { index }) }).start();
  const out = path.join(path.dirname(file), 'x');
  execFileSync('ditto', ['-x', '-k', file, out]);
  const mode = fs.statSync(path.join(out, MAC_SCRIPT)).mode;
  assert.ok(mode & 0o100, 'executável');
  assert.ok(fs.existsSync(path.join(out, WIN_SCRIPT)));
  const html = fs.readFileSync(path.join(out, 'Assistir aulas.html'), 'utf8');
  assert.ok(html.includes('"u":"https://youtu.be/v"'));
  execFileSync('python3', ['-I', '-c', 'import sys,zipfile;assert zipfile.ZipFile(sys.argv[1]).testzip() is None', file]);
});

test('Pasta com YouTube: grava os dois scripts e o índice mantém o vídeo ainda não baixado', async () => {
  const root = memoryDir();
  await new DownloadJob({ entries: [], target: new DirectoryTarget(root, { index }) }).start();
  const base = root.children.get('Aulas Uninter');
  assert.ok(base.children.has(MAC_SCRIPT) && base.children.has(WIN_SCRIPT));
  const html = new TextDecoder().decode(base.children.get('Assistir aulas.html').data);
  assert.ok(html.includes('"u":"https://youtu.be/v"'));
  const merged = mergeExternos([], index);
  assert.equal(merged[0].disciplinas[0].grupos[0].itens[0].kind, 'youtube');
});
