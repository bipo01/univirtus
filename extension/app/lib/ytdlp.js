// Scripts de duplo clique que baixam os vídeos do YouTube/Vimeo das aulas com o yt-dlp
// (https://github.com/yt-dlp/yt-dlp). O navegador não consegue baixar esses vídeos de forma
// confiável; o yt-dlp consegue. Na primeira vez o script prepara as ferramentas, de fontes oficiais:
//   - yt-dlp  (github.com/yt-dlp/yt-dlp)
//   - deno    (github.com/denoland/deno) — o YouTube exige um runtime JavaScript para liberar os formatos
//   - ffmpeg  (Mac: ffmpeg.martin-riedl.de, indicado em ffmpeg.org; Windows: github.com/yt-dlp/FFmpeg-Builds)
//             — junta vídeo e áudio; sem ele cai para um arquivo único de qualidade menor.
// Tudo fica numa pasta própria do usuário ("AVA Downloader"), sem instalar nada no sistema.
//
// Cada item: { base: 'Curso/Disciplina/Aula 01 - X/YouTube - Título', url, playlist }
// (caminho relativo à pasta onde o script fica, sem extensão).

export const MAC_SCRIPT = 'Baixar vídeos do YouTube (Mac).command';
export const WIN_SCRIPT = 'Baixar vídeos do YouTube (Windows).bat';

// H.264 primeiro: toca em qualquer player (AV1/VP9 não abrem no QuickTime antigo nem no player do Windows).
const FORMAT_FFMPEG = 'bv*[vcodec^=avc1]+ba[ext=m4a]/bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b';
const FORMAT_SINGLE = 'b[ext=mp4]/b';
const COMMON = '--merge-output-format mp4 --no-mtime --retries 10 --fragment-retries 10';

/** Modelo de saída do yt-dlp: "%" literal precisa virar "%%". */
function outputTemplate(item) {
  const base = item.base.replace(/%/g, '%%');
  return item.playlist ? `${base}/%(playlist_index)02d - %(title)s.%(ext)s` : `${base}.%(ext)s`;
}

const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function buildMacScript(items) {
  const lines = items.map((it) => `baixar ${sh(it.url)} ${sh(outputTemplate(it))} ${sh(it.base)}${it.playlist ? ' playlist' : ''}`);
  return `#!/bin/bash
# AVA Downloader — baixa os vídeos do YouTube das suas aulas, cada um na pasta da aula.
# Usa o yt-dlp (https://github.com/yt-dlp/yt-dlp). Pode rodar de novo: o que já foi baixado é pulado.
cd "$(dirname "$0")" || exit 1
FERRAMENTAS="$HOME/Library/Application Support/AVA Downloader"
mkdir -p "$FERRAMENTAS"
export PATH="$FERRAMENTAS:/opt/homebrew/bin:/usr/local/bin:$PATH"
clear
echo "AVA Downloader — vídeos do YouTube (${items.length})"
echo

fechar() {
  read -r -p "Aperte Enter para fechar." _
  exit "$1"
}

# baixa um .zip, extrai só o executável pedido para a pasta de ferramentas
instalar_zip() { # nome url executável
  echo "Baixando o $1 (só na primeira vez)…"
  local tmp
  tmp="$(mktemp -d)"
  if curl -fL --progress-bar -o "$tmp/f.zip" "$2" && unzip -oq "$tmp/f.zip" -d "$tmp/x"; then
    find "$tmp/x" -type f -name "$3" -exec cp {} "$FERRAMENTAS/$3" \\;
    chmod +x "$FERRAMENTAS/$3" 2>/dev/null
  fi
  rm -rf "$tmp"
}

if [ "$(uname -m)" = "arm64" ]; then DENO_ARCH=aarch64-apple-darwin; FFMPEG_ARCH=arm64; else DENO_ARCH=x86_64-apple-darwin; FFMPEG_ARCH=amd64; fi

if ! command -v yt-dlp >/dev/null 2>&1; then
  echo "Baixando o yt-dlp (só na primeira vez)…"
  if ! curl -fL --progress-bar -o "$FERRAMENTAS/yt-dlp.tmp" "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos"; then
    echo "Não foi possível baixar o yt-dlp. Confira a internet e tente de novo."
    fechar 1
  fi
  mv "$FERRAMENTAS/yt-dlp.tmp" "$FERRAMENTAS/yt-dlp"
  chmod +x "$FERRAMENTAS/yt-dlp"
fi
command -v deno >/dev/null 2>&1 || instalar_zip deno "https://github.com/denoland/deno/releases/latest/download/deno-$DENO_ARCH.zip" deno
command -v ffmpeg >/dev/null 2>&1 || instalar_zip ffmpeg "https://ffmpeg.martin-riedl.de/redirect/latest/macos/$FFMPEG_ARCH/snapshot/ffmpeg.zip" ffmpeg
xattr -dr com.apple.quarantine "$FERRAMENTAS" 2>/dev/null
yt-dlp -U >/dev/null 2>&1 || true

if command -v ffmpeg >/dev/null 2>&1; then
  FORMATO="${FORMAT_FFMPEG}"
else
  FORMATO="${FORMAT_SINGLE}"
  echo "Aviso: o ffmpeg não pôde ser preparado; alguns vídeos virão em qualidade menor."
fi
echo

FALHAS=0
baixar() { # url modelo nome [playlist]
  echo "▶ $3"
  if [ "$4" = "playlist" ]; then
    yt-dlp -f "$FORMATO" ${COMMON} -o "$2" "$1" || FALHAS=$((FALHAS + 1))
  else
    yt-dlp -f "$FORMATO" ${COMMON} --no-playlist -o "$2" "$1" || FALHAS=$((FALHAS + 1))
  fi
  echo
}

${lines.join('\n')}

if [ "$FALHAS" -gt 0 ]; then
  echo "Terminou, mas $FALHAS vídeo(s) não foram baixados (podem ser privados ou ter sido removidos)."
  fechar 1
fi
echo "Pronto! Todos os vídeos do YouTube foram baixados."
fechar 0
`;
}

const bat = (s) => String(s).replace(/%/g, '%%').replace(/"/g, '');
const ps = (cmd) => `powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; ${cmd}"`;

export function buildWindowsScript(items) {
  const lines = items.flatMap((it) => [
    `echo ^> ${bat(it.base.replace(/\//g, '\\')).replace(/[&|<>^()]/g, ' ')}`,
    `yt-dlp -f "%FORMATO%" %OPCOES%${it.playlist ? '' : ' --no-playlist'} -o "${bat(outputTemplate(it).replace(/\//g, '\\'))}" "${bat(it.url)}"`,
    'if errorlevel 1 set /a FALHAS+=1',
    'echo.',
  ]);
  // Arquivo .bat precisa de CRLF. As primeiras linhas são só ASCII (antes do chcp 65001).
  // Dentro de blocos ( ... ) não pode haver parênteses soltos: as mensagens evitam "(" e ")".
  return [
    '@echo off',
    'chcp 65001 >nul',
    'setlocal',
    'title AVA Downloader - videos do YouTube',
    'cd /d "%~dp0"',
    `echo AVA Downloader — vídeos do YouTube: ${items.length}`,
    'echo.',
    'set "FERRAMENTAS=%LOCALAPPDATA%\\AVA Downloader"',
    'if not exist "%FERRAMENTAS%" mkdir "%FERRAMENTAS%"',
    'set "PATH=%FERRAMENTAS%;%PATH%"',
    'where yt-dlp >nul 2>nul',
    'if errorlevel 1 (',
    '  echo Baixando o yt-dlp, so na primeira vez...',
    `  ${ps("Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' -OutFile '%FERRAMENTAS%\\yt-dlp.exe'")}`,
    ')',
    'where yt-dlp >nul 2>nul',
    'if errorlevel 1 (',
    '  echo Nao foi possivel baixar o yt-dlp. Confira a internet e tente de novo.',
    '  pause',
    '  exit /b 1',
    ')',
    'where deno >nul 2>nul',
    'if errorlevel 1 (',
    '  echo Baixando o deno, necessario para o YouTube, so na primeira vez...',
    `  ${ps("$z=Join-Path $env:TEMP 'ava-deno.zip'; Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip' -OutFile $z; Expand-Archive -Force $z '%FERRAMENTAS%'; Remove-Item -Force $z")}`,
    ')',
    'where ffmpeg >nul 2>nul',
    'if errorlevel 1 (',
    '  echo Baixando o ffmpeg para a melhor qualidade, cerca de 200 MB, so na primeira vez...',
    `  ${ps("$z=Join-Path $env:TEMP 'ava-ffmpeg.zip'; $d=Join-Path $env:TEMP 'ava-ffmpeg'; Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip' -OutFile $z; Expand-Archive -Force $z $d; Get-ChildItem $d -Recurse -Include ffmpeg.exe,ffprobe.exe | Copy-Item -Destination '%FERRAMENTAS%'; Remove-Item -Recurse -Force $z,$d")}`,
    ')',
    'yt-dlp -U >nul 2>&1',
    `set "FORMATO=${FORMAT_SINGLE}"`,
    'where ffmpeg >nul 2>nul',
    `if not errorlevel 1 set "FORMATO=${FORMAT_FFMPEG}"`,
    `set "OPCOES=${COMMON}"`,
    'set FALHAS=0',
    'echo.',
    ...lines,
    'if %FALHAS% GTR 0 (',
    '  echo Terminou, mas %FALHAS% video^(s^) nao foram baixados ^(podem ser privados ou ter sido removidos^).',
    ') else (',
    '  echo Pronto! Todos os videos do YouTube foram baixados.',
    ')',
    'pause',
    '',
  ].join('\r\n');
}
