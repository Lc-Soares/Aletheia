# Desenvolvimento local

Roda web e API juntos, na mesma origem, sem `firebase-tools`.

Todos os comandos deste arquivo são para o **Git Bash** (no Windows, nunca o PowerShell: a forma `VAR=valor comando` não funciona lá).

1. Terminal 1 (API). As variáveis vêm do seu ambiente; a lista completa está em `docs/api.md`, "Configuração". Para guardar os valores, ver "Segredos locais" e "`api/.env.example`", abaixo:
   `GOOGLE_CLIENT_ID=<id do cliente OAuth> PORT=8080 FETCHER_URL=http://localhost:8081 FETCHER_AUDIENCE=http://localhost:8081 EXIFTOOLS_API_KEY=<sua chave> npm start -w api`

   `EXIFTOOLS_API_KEY` é obrigatória: sem ela a API não sobe. Para testar só o login (`/api/me`), qualquer valor serve. `/healthz` e `/api/me` funcionam sem o fetcher no ar. Para `/api/check`, ver "API com o fetcher local".
2. Terminal 2 (web + proxy): `npm run dev -w web`
3. Abra `http://localhost:5000`.

O proxy (`web/dev-proxy.mjs`) serve `web/public`, encaminha `/api/**` para a API (porta `API_PORT`, padrão 8080) e aplica os cabeçalhos do `firebase.json`, inclusive a CSP. Escuta só em 127.0.0.1. A porta do proxy muda com `DEV_PORT`.

## Testes

O `npm run test` de cada workspace passa por `test-support/run-tests.js`, que roda o `node --test` com o guarda de unhandled rejection e **reprova quando nenhum teste passou de verdade**: glob vazio, total 0, todos pulados, ou um arquivo `*.test.*` sem nenhum `test()`. Sem isso, o `node --test` sai com 0 nesses casos. A contagem vem de `test-support/count-reporter.js`, e a decisão, de `test-support/verdict.js`. As fixtures de `test-support/fixtures/` só rodam pelos testes do próprio runner (`fetcher/src/test-guard.test.ts`).

**Versão mínima do Node: 24** (`engines` do `package.json`; o CI usa `node-version: 24`). O runner foi validado no Node 24.22.1 local; no CI e no Codespace, ele é validado pelos mesmos testes. O `count-reporter` depende do formato dos eventos do `node:test`:
- `test:pass`/`test:fail` com `data.name`, `data.file`, `data.details.type`, `skip` e `todo`;
- um evento com o nome do próprio arquivo quando o arquivo não tem nenhum teste.

**Risco:** uma versão futura do Node pode mudar esse formato. O runner foi feito para falhar fechado.

O que já reprova em vez de aprovar:
- nenhum evento de teste, linha de contagem ausente ou resumo do spec ausente ou zerado;
- **qualquer evento de teste sem `data.file`** (ou com `data.file` vazio). Ele aparece como "Formato de eventos do node:test não reconhecido". Sem o arquivo não dá para reconhecer o invólucro, então o runner não conta às cegas.

O que ainda não cobre:
- se o Node continuar mandando `data.file` mas mudar o **nome** do evento do arquivo vazio (hoje é o caminho do arquivo relativo ao diretório atual), o invólucro deixa de ser reconhecido e conta como um teste que passou. Um arquivo sem testes voltaria a passar despercebido;
- se o Node mudar o significado de `skip`/`todo` ou de `details.type`, as contagens de "passou" e de suítes podem ficar erradas sem que o formato pareça desconhecido.

Ao trocar a versão do Node, rode `npm run check`. Os testes de `fetcher/src/test-guard.test.ts` usam o `node:test` de verdade com as fixtures, com as contagens exatas, e acusam essas mudanças.

## Fetcher

A API chama o fetcher em `POST /api/check` (ver "API com o fetcher local", abaixo). Para subir só o fetcher:

`PORT=8081 FETCHER_AUDIENCE=http://localhost:8081 API_SERVICE_ACCOUNT_EMAIL=<conta de serviço da API> npm start -w fetcher`

Toda chamada a `POST /fetch` exige um ID token do Google emitido para essa conta de serviço, com `aud` igual a `FETCHER_AUDIENCE` e com os campos `email` e `email_verified`. Para obter o token localmente, use a impersonação do gcloud e confira na documentação do gcloud as opções de audiência e de inclusão do e-mail. Os testes automatizados não precisam disso, porque usam tokens assinados com chave gerada na hora. Contrato, limites e regras de implantação: `docs/fetcher.md`.

O fetcher acessa a internet de verdade quando roda localmente. Ele bloqueia destinos internos (inclusive `localhost`), então não serve para testar páginas da sua própria máquina.

### Testar páginas reais: `try-fetch`

Script de desenvolvimento (`fetcher/scripts/try-fetch.ts`) que roda o `fetchPage` contra páginas reais, **com as mesmas dependências de produção** (`createProductionDeps()`): DNS real, política de IP pública, transporte fixado no IP, extrator em worker e todos os limites padrão. Não há opção, flag nem variável de ambiente que desligue ou relaxe proteção. Ele não sobe o servidor e não precisa de token.

```
npm run try-fetch -w fetcher -- https://example.com/
npm run try-fetch -w fetcher -- --arquivo scripts/lista-exemplo.txt
```

O caminho relativo de `--arquivo` vale a partir de `fetcher/`, porque o `npm run -w fetcher` roda o script com o diretório de trabalho em `fetcher/`. Caminho absoluto também funciona; no Windows, use barras normais (`C:/Users/...`). O arquivo tem uma URL por linha, e linhas vazias ou começadas por `#` são ignoradas.

> **Aviso:** o script faz **requisições reais a partir da máquina de quem roda** (o IP, a rede e o DNS são os seus). Use só com **páginas públicas**. O resultado pode variar com a rede, o DNS, CDNs, bloqueio de User-Agent e desafios anti-bot, e não reproduz o Cloud Run.

Saída, em texto:
- URL final, título, manchete;
- quantas mídias foram listadas, em quantos grupos, quantas foram selecionadas, tentadas e baixadas;
- o sinal "a página possivelmente depende de JavaScript", quando houver, marcado como heurística;
- uma linha por grupo, em ordem de ranking, com a pontuação (`score`, para calibrar os pesos) e a situação do representante: baixada (content-type, tamanho e os 12 primeiros caracteres do SHA-256), erro (categoria e, em `upstream_status`, o código HTTP) ou ignorada (motivo), mais quantas variantes ficaram de fora;
- tempos por fase (página, extração, mídias) e total.

Um erro HTTP da página aparece como `erro: upstream_status (HTTP 403)`. Com `--arquivo`, as URLs rodam uma de cada vez e há um resumo no fim: quantas deram certo, quantas vezes cada categoria de erro apareceu (na página e nas mídias) e quantas mídias foram ignoradas por motivo. Regras de seleção e motivos: `docs/fetcher.md`, "Seleção de mídias (heurística)".

Formato, com a fixture `newsArticleFixture` de `fetcher/src/testing.ts` e rede simulada (não é um site real; os tempos aparecem zerados porque o relógio foi fixado):

```
URL: https://noticias.example/materia
  URL final: https://noticias.example/materia
  título: Matéria de exemplo
  manchete: Manchete inventada
  mídias: 24 listadas em 10 grupos, 3 selecionadas, 3 tentadas, 3 baixadas
    grupo 1 · pontuação 100 · baixada  image/jpeg  1 bytes  sha256 2d711642b726  image  https://cdn.example/og/capa-1200.jpg
    grupo 2 · pontuação 20 · baixada  image/jpeg  1 bytes  sha256 a1fce4363854  image  https://noticias.example/fotos/principal-1600.jpg  (+7 variantes)
    grupo 3 · pontuação 20 · baixada  image/avif  1 bytes  sha256 594e519ae499  image  https://noticias.example/fotos/segunda-1600.avif  (+7 variantes)
    grupo 4 · pontuação 20 · ignorada: formato não analisável (SVG)  image  https://noticias.example/graficos/evolucao.svg
    grupo 5 · pontuação -10 · ignorada: pontuação negativa: sinais de elemento secundário da página  image  https://noticias.example/fotos/relacionada.jpg
    grupo 6 · pontuação -70 · ignorada: ícone ou elemento de interface  image  https://noticias.example/assets/marca.png
    ...
  tempos: página 0 ms · extração 0 ms · mídias 0 ms · total 0 ms
```

Garantias, todas com teste em `fetcher/scripts/try-fetch.test.ts`:
- nunca imprime os bytes das mídias;
- não grava nada em disco nem em log; só lê o arquivo de `--arquivo`;
- título, manchete, URLs e content-types vêm de terceiros e são higienizados antes de ir para o terminal (sem sequências ANSI, sem controles C0/C1 e sem caracteres de formato Unicode, como o U+202E, que inverte o texto);
- termina sozinho depois do resumo, sem deixar worker nem resolvedor abertos;
- fica fora da imagem Docker (`.dockerignore` remove `fetcher/scripts`), e nenhum módulo de produção o importa.

Requer **Node 24.2 ou superior**, por causa de `import.meta.main`. Código de saída: 0 quando rodou, mesmo que alguma página tenha falhado (a falha aparece no resultado); 2 para uso errado.

**`scripts/lista-exemplo.txt`** traz quatro URLs que **precisam** sair `blocked`, sem abrir nenhuma conexão. Serve para conferir as proteções na sua máquina:

| URL | Resultado esperado | Por quê |
| --- | --- | --- |
| `http://localhost/` | `blocked` | Nome bloqueado pela política de URL (`localhost` e nomes sem ponto), antes de qualquer DNS. |
| `http://127.0.0.1/` | `blocked` | IP literal de loopback IPv4 (127/8); o DNS nem é consultado. |
| `http://169.254.169.254/` | `blocked` | Servidor de metadados do Google Cloud (link-local 169.254/16). |
| `http://[::1]/` | `blocked` | Loopback IPv6, fora da lista de permissão 2000::/3. |

Se qualquer uma delas sair diferente de `blocked`, é regressão de segurança: pare e investigue.

## API com o fetcher local

Roda `POST /api/check` de ponta a ponta na sua máquina, com o fetcher de verdade. **Não existe atalho de desenvolvimento no código:** a API sempre obtém um ID token real do Google, e o fetcher sempre o valida (assinatura, `aud`, `email_verified` e e-mail da conta de serviço). A única diferença é o `http://localhost` em `FETCHER_URL` e `FETCHER_AUDIENCE`, que a config aceita só para `localhost`, a mesma regra do fetcher. Em produção, esse endereço simplesmente não conectaria.

Lições do primeiro teste real (24/10/2026):
- **Git Bash, não PowerShell.** Comandos do gcloud em **uma linha só**: a quebra de linha com `\` falhou ao colar no Git Bash do Windows.
- **Sempre o ID real do projeto**, nunca o texto de exemplo. Defina a variável em cada janela que for usá-la:
  `PROJECT_ID=$(gcloud config get-value project)`

### Preparação (uma vez), nesta ordem

1. Habilitar as APIs: `gcloud services enable iamcredentials.googleapis.com iam.googleapis.com`
2. Criar a conta de serviço da API (a `<conta de serviço da API>` tem a forma `<nome>@<ID_DO_PROJETO>.iam.gserviceaccount.com`).
3. Dar a você o papel `roles/iam.serviceAccountTokenCreator` **nessa** conta de serviço.
4. Credenciais padrão com impersonação:
   `gcloud auth application-default login --impersonate-service-account=<conta de serviço da API>`

Com isso, o `GoogleAuth` emite ID tokens da conta de serviço da API. No `google-auth-library` 11.3.1, `Impersonated.fetchIdToken` pede o e-mail no token por padrão (`includeEmail: true`), e o fetcher exige `email`. Confira as opções na documentação atual do gcloud.

**Como conferir sem expor segredo:**
- `grep -o 'serviceAccounts/[^:"]*' <caminho do application_default_credentials.json>` deve mostrar a conta com o ID real do projeto. O arquivo traz `"type"` duas vezes, o que é normal: `authorized_user` dentro e `impersonated_service_account` no arquivo;
- `gcloud auth print-identity-token --impersonate-service-account=<conta de serviço da API> --audiences=http://localhost:8081 --include-email > /dev/null && echo TOKEN_OK` testa a conta e a permissão, mas **não** prova que o arquivo de credenciais lido pela API está certo.

**Depois de refazer o login do gcloud, reinicie a API** (e o fetcher, se mudar `API_SERVICE_ACCOUNT_EMAIL`): o processo carrega as credenciais ao subir.

### Subir e chamar

1. **Terminal 1 (fetcher):** `PORT=8081 FETCHER_AUDIENCE=http://localhost:8081 API_SERVICE_ACCOUNT_EMAIL=<conta de serviço da API> npm start -w fetcher`
2. **Terminal 2 (API):** o comando do passo 1 do início deste arquivo, com `FETCHER_URL=http://localhost:8081` e `FETCHER_AUDIENCE=http://localhost:8081`.
3. **Terminal 3:** `npm run dev -w web`.
4. **Chamada:** entre em `http://localhost:5000`, copie o ID token do cabeçalho `Authorization` da requisição `/api/me` (DevTools, aba Rede) e chame:
   `curl -s -X POST http://localhost:5000/api/check -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{"url":"https://example.com/"}'`

   O token do usuário dura 1 hora. Não cole o token em lugar nenhum além do terminal. Guarde os `.json` de resposta fora do repositório.

O fetcher faz requisições reais a partir da sua máquina (ver o aviso do `try-fetch`). Com `EXIFTOOLS_API_KEY` real, cada mídia baixada vai para a ExifTools de verdade, com custo e cota desconhecidos.

**Primeira chamada lenta:** localmente, a primeira chamada de cada processo da API levou cerca de 15 s, inclusive quando falhou; as seguintes, cerca de 150 ms. A causa provável é a primeira obtenção do token por impersonação. **Não investigado.** Ver a recomendação para o deploy em `docs/api.md`, "Chamada ao fetcher".

### Diagnóstico (campo `outcome` do log da API)

| Sintoma | Significado |
| --- | --- |
| `fetcher_token` | A API não conseguiu emitir o token de serviço: credenciais ausentes, apontando para a conta errada, sem o papel `roles/iam.serviceAccountTokenCreator`, ou IAM Credentials API desabilitada. |
| `fetcher_unauthorized` | O fetcher recusou o token: `API_SERVICE_ACCOUNT_EMAIL` (no fetcher) ou `aud` (`FETCHER_AUDIENCE` nos dois) diferentes. |
| `fetcher_network` | O fetcher está fora do ar. A resposta é 502 `internal`, não 422. |
| 502 sem nenhuma requisição no log do fetcher | A falha aconteceu antes de chegar ao fetcher (normalmente `fetcher_token`). |
| `config_error` no campo `exif` | A ExifTools recusou a chave. |

### Roteiro manual (validado em 24/10/2026)

| Teste | Resultado esperado |
| --- | --- |
| Página pública | 200, com mídias, downloads e `metadata`, sem bytes |
| `http://127.0.0.1/`, `http://169.254.169.254/` e um domínio inexistente | 422 com respostas **byte a byte iguais** ("Não foi possível acessar este endereço."); só o log interno distingue `fetch_blocked` de `fetch_network` |
| Site que responde 403 | 422 `upstream_status` com `httpStatus: 403` |
| Sem token ou com token lixo | 401 |
| `GET /api/check` | 405 com `Allow: POST` |
| Corpos inválidos | 400, sem gastar cota |
| 11 checagens válidas na mesma hora | As 10 primeiras passam e a 11ª dá 429. Reiniciar a API zera o contador |
| Fetcher parado | 502 `internal` |
| Logs dos dois serviços | Sem URL, token nem e-mail; só `domainHash` |

### Segredos locais

- Guarde a chave da ExifTools e o Client ID num arquivo **fora do repositório** (por exemplo `secrets.sh`, com linhas `export NOME="valor"`, sem espaço em volta do `=`) e carregue com `source <caminho>/secrets.sh` em cada janela. Nunca no `api/.env.example`.
- Para conferir se a variável foi carregada, veja só o tamanho, nunca o valor: `echo ${#EXIFTOOLS_API_KEY}`.
- Para revogar a impersonação local: `gcloud auth application-default revoke`.

### `api/.env.example`

Traz só os nomes das variáveis (`GOOGLE_CLIENT_ID`, `FETCHER_URL`, `FETCHER_AUDIENCE`, `EXIFTOOLS_API_KEY`), sem valores. Quem o mantém é o desenvolvedor; o agente não toca em arquivos `.env*`.

**Decisão tomada:** o `api/.env.example` é versionado como modelo, só com os nomes e sem valores. O `.gitignore` tem `!.env.example` depois da regra `.env.*`, que antes também o ignorava.

## Conferir a ExifTools com um arquivo: `try-exiftools`

Script de desenvolvimento (`api/scripts/try-exiftools.ts`) que envia **um arquivo local** à ExifTools real pelo **mesmo cliente de produção** (`createExifToolsClient`):
- endereço fixo e limites padrão;
- só multipart com o campo `file` e nome genérico;
- chave só no cabeçalho `X-API-Key`.

Não há opção, flag nem variável que mude destino, limites ou proteção. Serve para conferir se os nomes de tags da lista permitida (GPS, XMP, Composite, `contentCredentials`) batem com o que a ExifTools devolve de verdade.

Com o `secrets.sh` já carregado (ver "Segredos locais"):

```
npm run try-exiftools -w api -- <caminho do arquivo>
```

O caminho é relativo a `api/`; caminho absoluto também funciona (no Windows, com barras normais: `C:/Users/...`). Formatos aceitos: os mesmos que o fetcher baixa (`.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.avif`, `.heic`, `.heif`, `.tif`, `.tiff`, `.mp4`, `.webm`, `.mov`), até 15 MiB.

> **Aviso:** o arquivo **sai da sua máquina e vai para a ExifTools**, um serviço de terceiros que guarda resultados (recuperáveis por UUID). Use **só arquivos próprios**, nunca fotos de outras pessoas. Uma foto pode conter localização e autoria. A chave vem só da variável `EXIFTOOLS_API_KEY` do terminal: o script não lê nenhum arquivo de ambiente e nunca imprime a chave.

Saída, em texto:
- nome do arquivo, content-type, tamanho e os 12 primeiros caracteres do SHA-256;
- o status da ExifTools (`ok`, `unavailable`, `unsupported`, `too_large`, `invalid` ou `config_error`);
- com `ok`, os **sinais da lista permitida**: o mesmo objeto `signals` que a API devolve;
- com `ok`, os **nomes** dos grupos e tags da resposta bruta, **sem valores**. Uma linha por caminho, por exemplo `metadata.GPS: GPSLatitude, GPSLongitude`. Listas de objetos aparecem como `caminho[]`, por exemplo `contentCredentials.checks[]: code, outcome`.

Garantias, todas com teste em `api/scripts/try-exiftools.test.ts`:
- **nunca imprime:** valores brutos (coordenadas, nomes de autor, números de série), a chave, os bytes;
- **higiene do terminal:** nomes de tags e sinais passam pela mesma higienização do `try-fetch` (sem ANSI, controles e caracteres de formato Unicode);
- **só a chave e o arquivo do argumento:** do ambiente, o script lê apenas `EXIFTOOLS_API_KEY`, e só pelo ponto de entrada: `main` não recebe nada além da chave. Do disco, lê apenas o arquivo passado como argumento. Isso é verificado por comportamento, não por varredura do código: um ambiente falso com sentinelas e um leitor de arquivos injetado registram cada acesso, e os testes exigem que a chave chegue à ExifTools só no `X-API-Key` e que nenhuma sentinela apareça na saída. **Limite:** a garantia vale para o comportamento de `main` e de `scriptEnv`, que recebem o ambiente falso. Uma leitura direta de `process.env` dentro de `scriptEnv` não passa por esse ambiente: só é vista por um teste de alarme (exatamente uma ocorrência de `process.env` no arquivo), que não pega `process["env"]`;
- **sem rastro:** não grava nada em disco e termina sozinho;
- **isolamento:** fica fora da imagem Docker (`.dockerignore` remove `api/scripts`), e nenhum módulo de produção o importa.

Código de saída: 0 quando rodou, mesmo que a ExifTools tenha falhado (o status aparece na saída); 2 para uso errado, chave ausente, extensão não suportada, arquivo ilegível ou acima de 15 MiB.

### Teste manual dos sinais

- Fotos de bancos de imagem (como o Unsplash) vêm **sem EXIF**, e mensageiros e redes sociais também removem os metadados. Um resultado sem sinais nessas fotos é o esperado, não um erro.
- Para testar os sinais, use um arquivo com **metadados conhecidos** (um JPEG sintético com EXIF, GPS e XMP serve) e compare o resultado com o esperado. Resultado do teste de 24/10/2026: `docs/api.md`, "Teste real da ExifTools".
- **Primeiro teste real completo** (24/10/2026): `/api/check` numa página da BBC analisou 8 de 8 mídias em cerca de 20 s no total, dos quais cerca de 15 s foram da obtenção do primeiro token de serviço local (ver "Primeira chamada lenta").

## Origens a autorizar no cliente OAuth (Google Cloud Console)

Em "Origens JavaScript autorizadas", adicione (a documentação do GIS pede as duas para desenvolvimento local):

- `http://localhost`
- `http://localhost:5000` (ou a porta de `DEV_PORT`)

Em produção, apenas a origem exata do Firebase Hosting (`https://<projeto>.web.app`).

## Renovação do ID token

A documentação do Google Identity Services diz que o ID token dura 1 hora, que um token expirado não significa usuário deslogado e que a sessão é responsabilidade do app. Ela não descreve uma chamada de "renovar". O front, ao receber 401, chama `google.accounts.id.prompt()` e usa o novo credential entregue ao callback (o Google devolve sem interação se o usuário já consentiu). Se o prompt não for exibido ou for dispensado, a tela pede novo login. Esse comportamento ainda não foi validado com o Google real.

**Teste manual com o botão "Verificar sessão"** (aparece depois do login). O botão repete `GET /api/me` pelo mesmo fluxo de renovação, com no máximo uma renovação por clique e prazo de 15 s.
1. Clique logo depois do login: o esperado é "Sessão ativa" e "Token expira às HH:MM". O horário vem do `exp` do token, lido sem verificar a assinatura; é só informação de tela.
2. Clique depois de mais de 1 hora: "Token renovado" ou "Sessão expirada, entre novamente". As duas respostas são válidas, conforme o Google permita ou não a renovação silenciosa (cooldown do One Tap, FedCM, cookies de terceiros bloqueados).

O console do navegador mostra o início, o sucesso ou a falha da renovação (`console.info`), sem token nem e-mail. **Esse comportamento só se valida no navegador, com o Google real**: os testes automatizados usam uma renovação falsa.

## Testar a interface

Roteiro manual do formulário e do relatório (`web/public`). Os testes automatizados cobrem a lógica com um DOM falso; o que depende do navegador, do Google e da CSP real só se confere aqui. Suba tudo como em "API com o fetcher local" (fetcher, API e `npm run dev -w web`) e abra `http://localhost:5000`. Use só valores seus: nada de token, e-mail ou ID de projeto em issue, commit ou chat.

| # | Passo | Resultado esperado |
| --- | --- | --- |
| 1 | **Login** com o Google | "Conectado como `<seu e-mail>`"; aparecem "Verificar sessão" e o painel "Verificar um link" |
| 2 | **Link público** (por exemplo `https://example.com/`) e "Verificar" | Botão desabilitado e "Analisando... pode levar até 1 minuto" durante a análise. Depois, o foco vai para "Relatório de sinais"; no topo, o aviso fixo e os avisos da API; mídias agrupadas (uma linha por imagem, "+N variantes"); URL da mídia só como texto, sem miniatura |
| 3 | **Link bloqueado**: `http://127.0.0.1/` | "Não foi possível acessar este endereço.", com o foco na mensagem e nenhum relatório. O texto é o mesmo de um domínio inexistente |
| 4 | **Site que responde 403** (um endereço público que recuse robôs) | "O site respondeu com erro (HTTP 403)." |
| 5 | **11ª checagem na mesma hora**: dez checagens válidas e mais uma | A 11ª mostra a mensagem do limite do plano ("... Tente novamente em N minutos."). Reiniciar a API zera o contador |
| 6 | **Sessão expirada**: espere mais de 1 hora e clique em "Verificar" | Ou o relatório sai normalmente (token renovado), ou o formulário some, o botão de login volta e aparece "Sessão expirada, entre novamente". Entrar de novo limpa essa mensagem (e o texto do painel "Verificar sessão") |
| 7 | **JSON baixado**: "Baixar JSON" depois de um relatório | Arquivo `aletheia-relatorio-AAAAMMDD-HHMMSS.json`, sem domínio no nome. Abra e confira: `schemaVersion` 1, data e hora, URL analisada, avisos, grupos de mídia. Nenhuma coordenada, endereço ou nome de autor |
| 8 | **Celular**: modo de dispositivo do DevTools, 375 px | Sem rolagem horizontal; URLs e hashes longos quebram; margem lateral de 16 px |
| 9 | **Teclado**: só Tab, Enter e Shift+Tab | Todo controle é alcançável, o foco é visível, e Enter no campo envia |
| 10 | **COOP**: recarregue `http://localhost:5000` pelo `dev-proxy`, abra DevTools > Rede e clique no documento | **Critério:** a resposta traz `Cross-Origin-Opener-Policy: same-origin-allow-popups`; o login funciona; "Verificar sessão" funciona. As mensagens do console (abaixo) são só observação |

**COOP e o console (observação, não critério).** Antes do cabeçalho, o console mostrou duas vezes "Cross-Origin-Opener-Policy policy would block the window.postMessage call", vindo do script do Google Identity. O COOP `same-origin-allow-popups` segue o guia do Google; **não se sabe se ele muda essas mensagens**. No passo 10, registre aqui se mudaram ou não. Se persistirem, a anotação é "observado, origem provável: política do próprio Google, não verificada".

**Resultado do teste manual do COOP:** ainda não registrado (a conferir no navegador, com o login real do Google).

**Console do navegador.** Esperado, vindo do script do Google e não do Aletheia: o aviso `GSI_LOGGER` (ver "Renovação do ID token") e uma violação de CSP "Applying inline style" apontando para `accounts.google.com/gsi/client` (observada em 24/10/2026; a CSP não foi relaxada por causa dela). Qualquer outra violação de CSP, ou qualquer URL, token ou e-mail no console, é bug.

**Requisição lenta.** O navegador desiste em 65 s ("A análise demorou demais. Tente novamente."), o servidor corta em 50 s e o Hosting em 60 s. O `dev-proxy` não corta nem altera o prazo: uma resposta da API que demorou 70 s (mais que os 65 s do navegador) passou inteira, com status 200 e o mesmo corpo (verificado em 24/10/2026; o servidor Node do proxy não define `timeout`, e o `requestTimeout` de 300 s vale só para receber a requisição). Então, localmente, quem corta é o navegador, aos 65 s. Para ver a mensagem, faça a API demorar de propósito.

**O que já foi verificado no navegador** (24/10/2026, Chrome, CSP do `firebase.json` aplicada pelo `dev-proxy`, sem o login do Google): o relatório renderiza sem violar a CSP; o download por Blob funciona e grava o JSON; uma imagem de terceiro é bloqueada pela CSP (controle positivo); em 375 px não há rolagem horizontal. O fluxo completo com login, 401 e renovação reais **não** foi exercitado.
