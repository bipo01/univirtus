# AGENTS.md — AVA Downloader

Extensão Chrome MV3 que baixa em lote as videoaulas e materiais do AVA Univirtus (Uninter) para um ZIP ou uma pasta organizada. Público: alunos não programadores, então a interface e os textos são em **português do Brasil**, simples e diretos.

## Estrutura
- `extension/` — a extensão carregada no Chrome. **Sem build, sem dependências** (ES modules puros). Não introduza bundler/npm deps sem necessidade real.
  - `manifest.json` — MV3, Chrome ≥ 116 (`runtime.getContexts`). Permissões: `scripting`, `storage`, `power` + hosts do AVA e CDNs.
  - `background.js` — abre/foca a página `app/app.html?tab=<aba do AVA>`.
  - `content/content.js` — roda no AVA: ponte `ava:api`/`ava:ping` e botão flutuante (Shadow DOM).
  - `app/` — interface (`app.html/css/js`) e núcleo em `app/lib/` (testável em Node).
  - `app/player/` — player (`player.js`, `player.css`, `merge.js`, `doc-reader.js`). O `offline-index.js` embute em "Assistir aulas.html"; `app/watch.html` + `watch.js` rodam o mesmo player dentro da extensão.
  - `vendor/` — pdf.js 3.11.174 (UMD, Apache-2.0), JSZip 3.10.1 + docx-preview 0.3.5 (prévia de .docx). Copiados para `%storage%/app/<mesmo caminho>` junto com a página.
- `tests/*.test.mjs` — `node:test`. `tests/helpers.mjs` simula CDN (HEAD/Range/falhas) e FileSystem handles.
- `tools/preview/` — preview da interface com `chrome.*` simulado e dados **fictícios**; `tools/make-icons.py` gera os PNGs.

## Comandos
- `npm test` — todos os testes (um deles cria um ZIP esparso > 4 GB; `SKIP_BIG=1` pula).
- `npm run preview` → `http://127.0.0.1:8765/app/preview.html` (`?logged=0` mostra a tela de login). Os seletores de arquivo gravam no OPFS; `window.__exportOpfs(nome)` manda o resultado para `/tmp/ava-preview-*`.
- `npm run icons` — regenera `extension/icons/*.png`.
- `node tools/preview/player-sample.mjs` → pasta fictícia em `tools/preview/out/player-sample/Aulas Uninter` (vídeos de 4 s, PDFs com texto) com a página gerada; abra no Chrome por `file://`.
- Validar ZIP: `python3 -I -c "import zipfile,sys;print(zipfile.ZipFile(sys.argv[1]).testzip())" arq.zip`, `unzip -tq`, `ditto -x -k` (o `unzip` do macOS não entende nomes UTF-8; use `ditto` para extrair).

## API do AVA (verificada em out/2026)
Base `https://univirtus.uninter.com/ava/`. Autenticação: **cookie de sessão + cabeçalho `X-time`** (`JSON.parse(sessionStorage.user).time`, por aba). Sem os dois → 401. Por isso as chamadas rodam no content script da aba do AVA, nunca direto da página da extensão.
1. `sistema/Curso/0/EscolaUsuario/true/?emCurso=true|false` → `cursos[]` (false = encerrados).
2. `ava/SalaVirtual/{idCurso}/CursoUsuarioPermissao/true/?emCurso=…&idUsuarioCurso=…` → `salaVirtuais[]` (disciplinas; `cId` é o id criptografado).
3. `sistema/UsuarioSalaVirtualOferta/{idSala}/Atual` → oferta do aluno (`idSalaVirtualOferta`, `idSalaVirtualOfertaAproveitamento`, `idSalaVirtualOfertaPai`).
4. `ava/SalaVirtualEstrutura/0/TipoOfertaCriptografado/{1|2}?id={cId decodificado}&idSalaVirtualOferta=…` → aulas (1) / material complementar (2).
5. `ava/SalaVirtualAtividade/{idEstrutura}/EstruturaOferta/{idOferta}?idSalaVirtualOfertaPai=null&…&buscarItemAprendizagem=true&ocultarAtividadeSemItem=true` → atividades com itens (`classificacaoTipo`: `rota`, `video`, `arquivo`, `link`, `linkInterno`).
6. Rota: `POST repositorio/SistemaRepositorioRemoto/` com `url=<fonte>` (proxy do AVA; o `index.json` não é público). Fonte: `?c=X` → `https://conteudosdigitais.uninter.com/materiais/aulas/X/index.json`; senão acrescenta `action=getvideos&value=all`. Respostas: JSON com `aula.midia{n:{titulo,url}}` + `video_completo`, ou texto `resultvideos\n<urls>` (rotas antigas: `…-A02.mp4` é a aula inteira, `…-A02-P01.mp4` as partes), ou HTML com `<video>`.
7. Arquivo: `repositorio/SistemaRepositorio/{id}` → nome original; o download é `urlRecurso` (`SistemaRepositorioPublico?id=…`, público, redireciona para `univirtuscdn.uninter.com` assinado).
- "Aula completa" (`video_completo`, `…-A01.mp4`) é a mesma gravação dos temas (`…-A01-P01…P08.mp4`) num arquivo só: a soma dos tamanhos das partes bate com a completa (diferença ≈ 0,05%, só contêiner).
- YouTube (verificado em out/2026): a página do vídeo traz `VISITOR_DATA`; `POST youtubei/v1/player` com o cliente `VISIONOS` (+ `X-Goog-Visitor-Id`) devolve `hlsManifestUrl` sem o desafio JS (as URLs DASH diretas exigem o parâmetro `n` cifrado; o cliente `android_vr` dá 403). Variantes H.264 até 1080p em MPEG-TS só de vídeo + áudio AAC em ADTS (com ID3) em lista separada. `youtube.js` baixa os segmentos e `media/*.js` remonta um MP4 progressivo sem recodificar (validado com ffmpeg e AVFoundation). Na extensão, o Origin `chrome-extension://` leva 403 na API do player: a regra DNR de sessão em `yt-rule.js` troca o Origin só para `www.youtube.com/youtubei/` iniciado pela própria extensão. O MP4 é montado no OPFS (`ava-tmp/`, limpo ao abrir) e depois copiado para o ZIP/pasta. Vimeo e playlists continuam como links.
- O YouTube às vezes responde "Este vídeo não está disponível" ou "confirme que não é um robô" e libera no pedido seguinte: só motivos explícitos (privado, removido, idade, direitos autorais) são definitivos; o resto é repetido pelo `DownloadJob.retrying` com VISITOR_DATA novo. Sincronia A/V: vídeo (DTS do TS) e áudio (PRIV `transportStreamTimestamp` do ID3) usam o mesmo relógio de 90 kHz; quem começa depois ganha uma entrada vazia no `elst`.
- O cliente/versão do YouTube pode mudar: se `resolveYouTube` começar a falhar, compare com `yt-dlp -v --print-traffic --extractor-args youtube:player_client=visionos` e ajuste `CLIENT` em `youtube.js`.
- Mídia: `vod.grupouninter.com.br/*.mp4` é pública, com CORS `*` e `Accept-Ranges`. Áudio = mesmo caminho em `aud.grupouninter.com.br/*.mp3`. Libras = `L` antes do nome do arquivo (nem toda aula tem; 404 = não existe).

## Regras
- Nunca faça commit de dados reais de alunos (nomes, RU, CPF, ids de sessão). Fixtures e preview usam dados fictícios. O `index.json` das rotas traz CPF de professor: não guarde nem exiba.
- Windows: caminho relativo ≤ 190 caracteres (`LIMITS` em `plan.js`: curso 36, disciplina 44, Curso/Disciplina/Aula ≤ 110, arquivo 64), sobrando ~70 para a pasta escolhida dentro do limite de 260 do Explorador. Teste em `catalog.test.mjs`.
- "Vídeos por tema" e "Aula completa" são exclusivos (radio; `types.video`/`types.completo`); a página sempre abre em "Aula completa" (pedido do usuário; `loadPrefs` força, a troca não persiste); aula sem versão completa usa os temas (`usaTemas`/`usaCompleta` em `plan.js`).
- Nomes de arquivo são determinísticos (`plan.js`/`naming.js`): o modo Pasta pula arquivos que já existem com o mesmo tamanho. Mudar o esquema de nomes faz o usuário baixar tudo de novo; só mude com motivo.
- ZIP: entradas de tamanho conhecido têm posição reservada e são gravadas em paralelo; o cabeçalho local é gravado no fim com o CRC. Falha definitiva completa com zeros e vai para `LEIA-ME - arquivos com erro.txt`, para o ZIP continuar válido. Toda mudança em `zip.js` precisa passar nos testes com Python, `unzip -t` e `ditto`.
- Download interrompido (`lib/resume.js`): lista, destino (handle) e progresso ficam no IndexedDB `ava-downloader` enquanto baixa; cada download segura a trava `ava-job-<id>`, então só registro sem trava é oferecido ao abrir. O registro é apagado quando o download termina na página (pronto, cancelado ou erro). Pasta retoma pulando o que já existe; ZIP recomeça (o Chrome só grava o arquivo no `close()`).
- Erros nunca viram sucesso silencioso: 401 → tela de login; falhas por arquivo aparecem na interface e no relatório.
- Não faça chamadas em massa sem limite ao AVA: a página limita a 10 simultâneas.

## Página "Assistir aulas.html" (player offline)
- **Com a extensão instalada, nada para escolher:** a extensão guarda o handle da pasta (IndexedDB `ava-folders`, `lib/folders.js`) quando baixa em Pasta ou quando o aluno usa "Atualizar numa pasta já baixada". A página da pasta leva `ext` (id da extensão) e `folderId` nos dados; ao abrir por `file://` ela testa `chrome-extension://<ext>/icons/icon-16.png` (web_accessible_resources só para `file:///*`) e, se a extensão responde, vai para `app/watch.html?f=<folderId>`. Lá o player roda com `window.AVA_HOST` (lista montada por `scanTree` na hora, vídeos/arquivos lidos pelo handle como blob). Se o Chrome não tiver a permissão guardada, a tela pede um clique ("Abrir minhas aulas" → `requestPermission`; o Chrome oferece "Permitir em todas as visitas"). `?local` na página da pasta força o modo `file://`. O `folderId` é mantido entre regenerações (`readPlayerData`).
- Sem a extensão (outro computador), abre por `file://` (duplo clique), sem internet e sem módulos ES (o Chrome bloqueia `type=module` e `fetch` em `file://`). Os dados vão em `<script type="application/json" id="ava-data">` (`playerData`: caminho real `p` é a chave de tudo); o player é um script clássico. Nada de `</script` no `player.js` (há teste).
- Progresso, destaques e notas: `localStorage` (`ava-player:<pasta>`) sempre; e `%storage%/dados.json` na pasta das aulas depois que o aluno escolhe a pasta (`showDirectoryPicker`; o handle fica no IndexedDB `ava-player`, e o Chrome pede permissão de novo a cada visita). Gravação junta com o disco antes (registros com `at`, apagados viram lápide `del`) e gera `%storage%/Minhas anotações.md`.
- PDF: só com a pasta conectada (é o único jeito de ler os bytes em `file://`). pdf.js carrega de `%storage%/app/pdf.min.js` por `<script>`; o worker vem de um Blob lido pela pasta (se falhar, o pdf.js roda na página). Sempre `isEvalSupported: false` (CVE-2024-4367). Destaques guardam retângulos normalizados (0–1) por página.
- Word: `.docx` pelo docx-preview (fiel: imagens, tabelas, cores); `.doc` (Word 97–2003) pelo `doc-reader.js` próprio ([MS-CFB] + [MS-DOC]: peças do CLX, FKPs de parágrafo/caractere → texto, negrito/itálico/sublinhado, tamanho, alinhamento, tabelas; sem imagens). Também aceita UTF-8 nas peças de 8 bits (arquivos do TextEdit/Pages). Fixture: `tests/fixtures/doc/ficha.doc` (gerada com `textutil`).
- Outros materiais (pptx, xlsx…) não têm link: clicar num `file://` não renderizável faz o Chrome baixar uma cópia. A página mostra o caminho para abrir pelo sistema.
- `%storage%` é ignorado pelo `scanTree`. A extensão nunca apaga nem sobrescreve `dados.json`; só reescreve a página, `%storage%/app/*` e `LEIA-ME.txt`.
- "Atualizar numa pasta já baixada" (Mais opções → `rebuildPlayerPage`): regera só a página a partir dos arquivos; links e URLs do YouTube saem da página anterior (`readPlayerData` lê o formato novo e o antigo `const DATA=`).
