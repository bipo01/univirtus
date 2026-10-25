# AGENTS.md — AVA Downloader

Extensão Chrome MV3 que baixa em lote as videoaulas e materiais do AVA Univirtus (Uninter) para um ZIP ou uma pasta organizada. Público: alunos não programadores, então a interface e os textos são em **português do Brasil**, simples e diretos.

## Estrutura
- `extension/` — a extensão carregada no Chrome. **Sem build, sem dependências** (ES modules puros). Não introduza bundler/npm deps sem necessidade real.
  - `manifest.json` — MV3, Chrome ≥ 116 (`runtime.getContexts`). Permissões: `scripting`, `storage`, `power` + hosts do AVA e CDNs.
  - `background.js` — abre/foca a página `app/app.html?tab=<aba do AVA>`.
  - `content/content.js` — roda no AVA: ponte `ava:api`/`ava:ping` e botão flutuante (Shadow DOM).
  - `app/` — interface (`app.html/css/js`) e núcleo em `app/lib/` (testável em Node).
- `tests/*.test.mjs` — `node:test`. `tests/helpers.mjs` simula CDN (HEAD/Range/falhas) e FileSystem handles.
- `tools/preview/` — preview da interface com `chrome.*` simulado e dados **fictícios**; `tools/make-icons.py` gera os PNGs.

## Comandos
- `npm test` — todos os testes (um deles cria um ZIP esparso > 4 GB; `SKIP_BIG=1` pula).
- `npm run preview` → `http://127.0.0.1:8765/app/preview.html` (`?logged=0` mostra a tela de login). Os seletores de arquivo gravam no OPFS; `window.__exportOpfs(nome)` manda o resultado para `/tmp/ava-preview-*`.
- `npm run icons` — regenera `extension/icons/*.png`.
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
- Mídia: `vod.grupouninter.com.br/*.mp4` é pública, com CORS `*` e `Accept-Ranges`. Áudio = mesmo caminho em `aud.grupouninter.com.br/*.mp3`. Libras = `L` antes do nome do arquivo (nem toda aula tem; 404 = não existe).

## Regras
- Nunca faça commit de dados reais de alunos (nomes, RU, CPF, ids de sessão). Fixtures e preview usam dados fictícios. O `index.json` das rotas traz CPF de professor: não guarde nem exiba.
- Nomes de arquivo são determinísticos (`plan.js`/`naming.js`): o modo Pasta pula arquivos que já existem com o mesmo tamanho. Mudar o esquema de nomes faz o usuário baixar tudo de novo; só mude com motivo.
- ZIP: entradas de tamanho conhecido têm posição reservada e são gravadas em paralelo; o cabeçalho local é gravado no fim com o CRC. Falha definitiva completa com zeros e vai para `LEIA-ME - arquivos com erro.txt`, para o ZIP continuar válido. Toda mudança em `zip.js` precisa passar nos testes com Python, `unzip -t` e `ditto`.
- Erros nunca viram sucesso silencioso: 401 → tela de login; falhas por arquivo aparecem na interface e no relatório.
- Não faça chamadas em massa sem limite ao AVA: a página limita a 10 simultâneas.
