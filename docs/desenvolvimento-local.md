# Desenvolvimento local

Roda web e API juntos, na mesma origem, sem `firebase-tools`.

1. Terminal 1 (API). As variáveis vêm do seu ambiente; os nomes estão em `api/.env.example`:
   `GOOGLE_CLIENT_ID=<id do cliente OAuth> PORT=8080 npm start -w api`
2. Terminal 2 (web + proxy): `npm run dev -w web`
3. Abra `http://localhost:5000`.

O proxy (`web/dev-proxy.mjs`) serve `web/public`, encaminha `/api/**` para a API (porta `API_PORT`, padrão 8080) e aplica os cabeçalhos do `firebase.json`, inclusive a CSP. Escuta só em 127.0.0.1. A porta do proxy muda com `DEV_PORT`.

## Testes

O `npm run test` de cada workspace passa por `test-support/run-tests.js`, que roda o `node --test` com o guarda de unhandled rejection e **reprova quando nenhum teste passou de verdade**: glob vazio, total 0, todos pulados, ou um arquivo `*.test.*` sem nenhum `test()`. Sem isso, o `node --test` sai com 0 nesses casos. A contagem vem de `test-support/count-reporter.js`, e a decisão, de `test-support/verdict.js`. As fixtures de `test-support/fixtures/` só rodam pelos testes do próprio runner (`fetcher/src/test-guard.test.ts`).

**Versão mínima do Node: 24** (`engines` do `package.json`; o CI usa `node-version: 24`). O runner foi validado no Node 24.22.1 local; no CI e no Codespace, ele é validado pelos mesmos testes. O `count-reporter` depende do formato dos eventos do `node:test`:
- `test:pass`/`test:fail` com `data.name`, `data.file`, `data.details.type`, `skip` e `todo`;
- um evento com o nome do próprio arquivo quando o arquivo não tem nenhum teste.

**Risco:** uma versão futura do Node pode mudar esse formato. O runner foi feito para falhar fechado: sem eventos de teste, sem a linha de contagem ou sem o resumo do spec, ele reprova em vez de aprovar. Mas um formato novo pode fazer o invólucro do arquivo deixar de ser reconhecido, e então um arquivo sem testes voltaria a passar despercebido. Ao trocar a versão do Node, rode `npm run check`; os testes de `fetcher/src/test-guard.test.ts` usam o `node:test` de verdade e acusam a mudança.

## Fetcher

O fetcher ainda não é chamado pela API (isso entra na Fase 4). Para subir só ele:

`PORT=8081 FETCHER_AUDIENCE=http://localhost:8081 API_SERVICE_ACCOUNT_EMAIL=<conta de serviço da API> npm start -w fetcher`

Toda chamada a `POST /fetch` exige um ID token do Google emitido para essa conta de serviço, com `aud` igual a `FETCHER_AUDIENCE` e com os campos `email` e `email_verified`. Para obter o token localmente, use a impersonação do gcloud e confira na documentação do gcloud as opções de audiência e de inclusão do e-mail. Os testes automatizados não precisam disso, porque usam tokens assinados com chave gerada na hora. Contrato, limites e regras de implantação: `docs/fetcher.md`.

O fetcher acessa a internet de verdade quando roda localmente. Ele bloqueia destinos internos (inclusive `localhost`), então não serve para testar páginas da sua própria máquina.

## Origens a autorizar no cliente OAuth (Google Cloud Console)

Em "Origens JavaScript autorizadas", adicione (a documentação do GIS pede as duas para desenvolvimento local):

- `http://localhost`
- `http://localhost:5000` (ou a porta de `DEV_PORT`)

Em produção, apenas a origem exata do Firebase Hosting (`https://<projeto>.web.app`).

## Renovação do ID token

A documentação do Google Identity Services diz que o ID token dura 1 hora, que um token expirado não significa usuário deslogado e que a sessão é responsabilidade do app. Ela não descreve uma chamada de "renovar". O front, ao receber 401, chama `google.accounts.id.prompt()` e usa o novo credential entregue ao callback (o Google devolve sem interação se o usuário já consentiu). Se o prompt não for exibido ou for dispensado, a tela pede novo login. Esse comportamento ainda não foi validado com o Google real.
