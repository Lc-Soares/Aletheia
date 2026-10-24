# Desenvolvimento local

Roda web e API juntos, na mesma origem, sem `firebase-tools`.

1. Terminal 1 (API). As variáveis vêm do seu ambiente; a lista completa está em `docs/api.md`, "Configuração" (atualize o `api/.env.example` com `FETCHER_URL`, `FETCHER_AUDIENCE` e `EXIFTOOLS_API_KEY`, sem valor):
   `GOOGLE_CLIENT_ID=<id do cliente OAuth> PORT=8080 FETCHER_URL=http://localhost:8081 FETCHER_AUDIENCE=http://localhost:8081 EXIFTOOLS_API_KEY=<sua chave> npm start -w api`

   `EXIFTOOLS_API_KEY` é obrigatória: sem ela a API não sobe. Defina a chave na sessão do terminal, sem gravar em arquivo do repositório e sem colar em issue ou chat. `/healthz` e `/api/me` funcionam sem o fetcher no ar. Para `/api/check`, ver "API com o fetcher local".
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

O caminho de `--arquivo` é relativo a `fetcher/`. O arquivo tem uma URL por linha, e linhas vazias ou começadas por `#` são ignoradas.

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

1. **Uma vez:** credenciais padrão do gcloud com impersonação da conta de serviço da API. Confira as opções na documentação atual do gcloud.
   `gcloud auth application-default login --impersonate-service-account=<conta de serviço da API>`

   Sua conta precisa do papel `roles/iam.serviceAccountTokenCreator` **nessa** conta de serviço. Com isso, o `GoogleAuth` emite ID tokens da conta de serviço da API. No `google-auth-library` 11.3.1, `Impersonated.fetchIdToken` pede o e-mail no token por padrão (`includeEmail: true`), e o fetcher exige `email`.
2. **Terminal 1 (fetcher):** `PORT=8081 FETCHER_AUDIENCE=http://localhost:8081 API_SERVICE_ACCOUNT_EMAIL=<conta de serviço da API> npm start -w fetcher`
3. **Terminal 2 (API):** o comando do passo 1 do início deste arquivo, com `FETCHER_URL=http://localhost:8081` e `FETCHER_AUDIENCE=http://localhost:8081`.
4. **Terminal 3:** `npm run dev -w web`.
5. **Chamada:** entre em `http://localhost:5000`, copie o ID token do cabeçalho `Authorization` da requisição `/api/me` (DevTools, aba Rede) e chame:
   `curl -s -X POST http://localhost:5000/api/check -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{"url":"https://example.com/"}'`

   O token do usuário dura 1 hora. Não cole o token em lugar nenhum além do terminal.

Conferências rápidas:
- `{"url":"http://127.0.0.1/"}` precisa responder 422 com "Não foi possível acessar este endereço." (a mesma mensagem de um domínio inexistente);
- a 11ª checagem na mesma hora responde 429;
- os logs dos dois serviços não podem ter a URL, só `domainHash`;
- cada mídia baixada traz `metadata`. Um `config_error` no campo `exif` do log da API indica que a ExifTools recusou a chave.

Com `EXIFTOOLS_API_KEY` real, cada mídia baixada vai para a ExifTools de verdade, com custo e cota desconhecidos.

O fetcher faz requisições reais a partir da sua máquina (ver o aviso do `try-fetch`). Se o token de serviço não puder ser emitido (sem impersonação ou sem o papel), a API responde 502 e registra `fetcher_token` no log. Se o fetcher recusar o token, a API responde 502 e registra `fetcher_unauthorized`.

## Conferir a ExifTools com um arquivo: `try-exiftools`

Script de desenvolvimento (`api/scripts/try-exiftools.ts`) que envia **um arquivo local** à ExifTools real pelo **mesmo cliente de produção** (`createExifToolsClient`):
- endereço fixo e limites padrão;
- só multipart com o campo `file` e nome genérico;
- chave só no cabeçalho `X-API-Key`.

Não há opção, flag nem variável que mude destino, limites ou proteção. Serve para conferir se os nomes de tags da lista permitida (GPS, XMP, Composite, `contentCredentials`) batem com o que a ExifTools devolve de verdade.

```
EXIFTOOLS_API_KEY=<sua chave> npm run try-exiftools -w api -- <caminho do arquivo>
```

O caminho é relativo a `api/`. Formatos aceitos: os mesmos que o fetcher baixa (`.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.avif`, `.heic`, `.heif`, `.tif`, `.tiff`, `.mp4`, `.webm`, `.mov`), até 15 MiB.

> **Aviso:** o arquivo **sai da sua máquina e vai para a ExifTools**, um serviço de terceiros que guarda resultados (recuperáveis por UUID). Use **só arquivos próprios**, nunca fotos de outras pessoas. Uma foto pode conter localização e autoria. A chave vem só da variável `EXIFTOOLS_API_KEY` do terminal: o script não lê nenhum arquivo de ambiente e nunca imprime a chave.

Saída, em texto:
- nome do arquivo, content-type, tamanho e os 12 primeiros caracteres do SHA-256;
- o status da ExifTools (`ok`, `unavailable`, `unsupported`, `too_large`, `invalid` ou `config_error`);
- com `ok`, os **sinais da lista permitida**: o mesmo objeto `signals` que a API devolve;
- com `ok`, os **nomes** dos grupos e tags da resposta bruta, **sem valores**. Uma linha por caminho, por exemplo `metadata.GPS: GPSLatitude, GPSLongitude`. Listas de objetos aparecem como `caminho[]`, por exemplo `contentCredentials.checks[]: code, outcome`.

Garantias, todas com teste em `api/scripts/try-exiftools.test.ts`:
- **nunca imprime:** valores brutos (coordenadas, nomes de autor, números de série), a chave, os bytes;
- **higiene do terminal:** nomes de tags e sinais passam pela mesma higienização do `try-fetch` (sem ANSI, controles e caracteres de formato Unicode);
- **só a chave e o arquivo do argumento:** do ambiente, o script lê apenas `EXIFTOOLS_API_KEY`, e só pelo ponto de entrada: `main` não recebe nada além da chave. Do disco, lê apenas o arquivo passado como argumento. Isso é verificado por comportamento, não por varredura do código: um ambiente falso com sentinelas e um leitor de arquivos injetado registram cada acesso, e os testes exigem que a chave chegue à ExifTools só no `X-API-Key` e que nenhuma sentinela apareça na saída;
- **sem rastro:** não grava nada em disco e termina sozinho;
- **isolamento:** fica fora da imagem Docker (`.dockerignore` remove `api/scripts`), e nenhum módulo de produção o importa.

Código de saída: 0 quando rodou, mesmo que a ExifTools tenha falhado (o status aparece na saída); 2 para uso errado, chave ausente, extensão não suportada, arquivo ilegível ou acima de 15 MiB.

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
