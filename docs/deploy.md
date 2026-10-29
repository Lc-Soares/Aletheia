# Deploy

Guia do primeiro deploy fechado (para a equipe testar), feito à mão e em etapas. A automação por GitHub Actions vem depois, quando cada peça estiver entendida. Os comandos são para o **Git Bash**, em **uma linha** (a quebra com `\` falhou ao colar no Windows). Nenhum ID real aparece aqui: os comandos usam `${PROJECT_ID}`.

Defina em cada janela nova:

```
PROJECT_ID=$(gcloud config get-value project)
```

Rode `echo $PROJECT_ID` e confira que mostra o ID real do projeto.

## Situação (28/10/2026)

| Etapa | O que faz | Situação |
| --- | --- | --- |
| 0 | Firebase no projeto existente | Feita |
| 1 | APIs, contas de serviço, segredo e orçamento | Feita |
| 2 | Artifact Registry e imagens | Feita (27/10/2026) |
| 3 | Deploy do fetcher (privado) e da API (pública) | Feita (27/10/2026) |
| 4 | Firebase Hosting e rewrite de `/api/**` | Feita (27/10/2026) |
| 5 | Origens OAuth de produção e modo de teste | Feita (28/10/2026) |

## Decisões

- **Primeiro deploy manual**, sem automação. Depois, GitHub Actions.
- **Crédito de teste do Google Cloud** (US$ 300) com faturamento ativo. O alerta de orçamento só avisa; quem limita o custo é o `--max-instances`.
- **Região:** `southamerica-east1` para o Cloud Run e o Artifact Registry. O rewrite do Firebase Hosting para essa região **funcionou** no primeiro deploy (Etapa 4), sem o erro de região; o plano B (`us-central1`) não foi necessário.
- **Nome do site de Hosting:** padrão `<ID_DO_PROJETO>.web.app`. Decidido: manter o site padrão; um site adicional com nome mais limpo fica opcional para depois.
- **CLI do Firebase:** usada com `npx firebase-tools@15.34.0` a partir da raiz do repositório, para valer o `.npmrc` (versão com pelo menos 7 dias de publicação; a 15.34.1 tinha 6 dias em 27/10/2026). Sem `npm install -g`. Reavaliar a versão na próxima vez que a CLI for usada. Não aceitar o recurso opcional "Gemini in Firebase" no login (decisão de privacidade; o deploy não depende dele).

## Etapa 0: Firebase no projeto existente

Feita pelo console, sem comandos.

1. No console do Firebase, adicionar projeto **selecionando o projeto existente do Google Cloud** (não criar outro).
2. **Desligar o Google Analytics** quando perguntar.
3. Aceitar o plano Blaze (exigido pelo Cloud Run; usa o faturamento e o crédito de teste).

O assistente "Configurar o Firebase Hosting" do console serve para quem usa a CLI: pode ser fechado.

## Etapa 1: APIs, contas de serviço, segredo e orçamento

**1.1. Habilitar as APIs:**

```
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com iam.googleapis.com iamcredentials.googleapis.com
```

Conferir (devem aparecer as seis):

```
gcloud services list --enabled --format="value(config.name)" | grep -E "^(run|artifactregistry|cloudbuild|secretmanager|iam|iamcredentials)\.googleapis\.com$"
```

**1.2. Contas de serviço.** A da API já existia (criada para os testes locais). Conferir e criar a do fetcher, **sem nenhum papel**:

```
gcloud iam service-accounts list --format="value(email)"
```

```
gcloud iam service-accounts create aletheia-fetcher --display-name="Aletheia fetcher (sem papeis)"
```

Não conceder papel algum à conta do fetcher: é a regra de segurança dele (`docs/fetcher.md`, regra 4).

**1.3. Segredo da ExifTools no Secret Manager.** Com o `secrets.sh` carregado (ver `docs/desenvolvimento-local.md`, "Segredos locais"), criar o segredo sem imprimir a chave:

```
printf %s "$EXIFTOOLS_API_KEY" | gcloud secrets create exiftools-api-key --data-file=-
```

Conceder leitura só à conta da API, só nesse segredo:

```
gcloud secrets add-iam-policy-binding exiftools-api-key --member="serviceAccount:aletheia-api@${PROJECT_ID}.iam.gserviceaccount.com" --role="roles/secretmanager.secretAccessor"
```

Conferir com `gcloud secrets list` e, para a variável local, só o tamanho (`echo ${#EXIFTOOLS_API_KEY}`), nunca o valor. Nunca rodar `gcloud secrets versions access` em tela compartilhada. O `secrets.sh` continua necessário para os testes locais e fica **fora do repositório**.

**Conferir o tamanho do segredo na nuvem.** No primeiro deploy, o segredo foi gravado com um valor de tamanho diferente do da chave (a ExifTools respondeu "indisponível" em todas as mídias, e o log mostrou `exif: {unavailable: N}` e não `config_error`). A causa provável é um valor com caracteres inválidos para cabeçalho HTTP, que faz o `fetch` falhar antes de enviar; não foi verificada. Depois de criar o segredo, compare os tamanhos (os dois comandos imprimem só um número, nunca o valor):

```
gcloud secrets versions access latest --secret=exiftools-api-key | wc -c
```

```
echo ${#EXIFTOOLS_API_KEY}
```

Os dois devem ser iguais. Se forem diferentes, crie uma versão nova a partir da variável local, confira o tamanho dela e aponte a API para o número da versão (ver Etapa 3, passo 3.6, "Trocar a versão do segredo"):

```
printf %s "$EXIFTOOLS_API_KEY" | gcloud secrets versions add exiftools-api-key --data-file=-
```

Depois que a versão nova funcionar, desative a errada (`gcloud secrets versions disable <número> --secret=exiftools-api-key`).

**1.4. Alerta de orçamento (console).** Faturamento, Orçamentos e alertas, criar orçamento. Sugestão: US$ 10, alertas em 50%, 90% e 100%, com e-mail. O orçamento só avisa, não corta o gasto.

## Etapa 2: Artifact Registry e imagens

Situação: feita em 27/10/2026. As duas imagens (`api` e `fetcher`) foram publicadas, com o código curto do commit como etiqueta.

Pré-requisitos: a Etapa 1 concluída e o arquivo `deploy/cloudbuild.yaml` na `master`. As imagens são as mesmas que o CI constrói (`docker build -f <serviço>/Dockerfile .`), mas aqui são construídas no Cloud Build e publicadas no Artifact Registry. O CI só constrói, não publica.

**2.1. Criar o repositório de imagens (uma vez).** Ele deve ficar na mesma região do Cloud Run:

```
gcloud artifacts repositories create aletheia --repository-format=docker --location=southamerica-east1 --description="Imagens do Aletheia"
```

Conferir:

```
gcloud artifacts repositories list --location=southamerica-east1
```

**2.2. Preparar a pasta.** A partir da raiz do repositório, na `master` atualizada e sem alterações pendentes:

```
git switch master
```

```
git pull --ff-only
```

```
git status --short
```

O último comando deve ficar **vazio**. Confira também que não há arquivo de segredo na pasta; este comando não deve mostrar nada:

```
ls -A | grep -i secret
```

O `gcloud builds submit` envia o conteúdo da pasta (menos o que o `.gitignore` ignora) para um bucket do projeto, e o `.gitignore` não cobre um `secrets.sh` solto na raiz. O `secrets.sh` deve ficar **fora** do repositório.

**2.3. Construir a imagem do fetcher.** A etiqueta é o código curto do commit, o que permite voltar a uma versão anterior:

```
TAG=$(git rev-parse --short HEAD)
```

```
gcloud builds submit --config=deploy/cloudbuild.yaml --substitutions=_SERVICE=fetcher,_IMAGE=southamerica-east1-docker.pkg.dev/${PROJECT_ID}/aletheia/fetcher:${TAG} .
```

O primeiro build pode criar um bucket de apoio no projeto e leva alguns minutos. Deve terminar em `SUCCESS`.

**2.4. Construir a imagem da API**, com o mesmo `TAG`:

```
gcloud builds submit --config=deploy/cloudbuild.yaml --substitutions=_SERVICE=api,_IMAGE=southamerica-east1-docker.pkg.dev/${PROJECT_ID}/aletheia/api:${TAG} .
```

**2.5. Conferir** que as duas imagens estão no repositório:

```
gcloud artifacts docker images list southamerica-east1-docker.pkg.dev/${PROJECT_ID}/aletheia
```

**Se der erro de permissão.** Em projetos novos, o Cloud Build usa por padrão a conta de serviço padrão do Compute Engine (mudança de maio e junho de 2024 na documentação oficial). No primeiro build ocorreu um 403 (`storage.objects.get` no bucket `<ID_DO_PROJETO>_cloudbuild`). Resolveram, nesta ordem, **três permissões estreitas** para essa conta (os papéis foram os que resolveram na execução; a sintaxe dos comandos abaixo foi reescrita nesta documentação e não colada da execução):

```
PROJECT_NUMBER=$(gcloud projects describe ${PROJECT_ID} --format="value(projectNumber)")
```

```
BUILD_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
```

```
gcloud storage buckets add-iam-policy-binding gs://${PROJECT_ID}_cloudbuild --member="serviceAccount:${BUILD_SA}" --role="roles/storage.objectViewer"
```

```
gcloud artifacts repositories add-iam-policy-binding aletheia --location=southamerica-east1 --member="serviceAccount:${BUILD_SA}" --role="roles/artifactregistry.writer"
```

```
gcloud projects add-iam-policy-binding ${PROJECT_ID} --member="serviceAccount:${BUILD_SA}" --role="roles/logging.logWriter" --condition=None
```

Não conceda papéis mais amplos por tentativa. Se aparecer outro erro, copie só o trecho (sem IDs reais): ele diz a conta e a permissão que faltam.

**Pendências desta etapa:** as imagens base `node:24-slim` dos dois Dockerfiles e a imagem do builder `gcr.io/cloud-builders/docker` ainda não estão fixadas por digest (há um `TODO` nos Dockerfiles). Fixar antes do lançamento (`docs/pendencias.md`).

## Etapa 3: deploy do fetcher (privado) e da API (pública)

Feita em 27/10/2026. As regras vêm de `docs/fetcher.md` (implantação) e `docs/api.md` (capacidade). Defina em cada janela nova (além do `PROJECT_ID`):

```
REGION=southamerica-east1
```

```
FETCHER_SA="aletheia-fetcher@${PROJECT_ID}.iam.gserviceaccount.com"
```

```
API_SA="aletheia-api@${PROJECT_ID}.iam.gserviceaccount.com"
```

```
TAG=<código curto do commit usado no build da Etapa 2>
```

**3.1. Fetcher.** Privado (`--no-allow-unauthenticated`), conta própria sem papéis, concorrência 2, 1 GiB. O endereço dele só existe depois do primeiro deploy, então o `FETCHER_AUDIENCE` entra provisório e é corrigido no 3.3:

```
gcloud run deploy aletheia-fetcher --image=southamerica-east1-docker.pkg.dev/${PROJECT_ID}/aletheia/fetcher:${TAG} --region=${REGION} --service-account=${FETCHER_SA} --no-allow-unauthenticated --concurrency=2 --memory=1Gi --max-instances=2 --set-env-vars=FETCHER_AUDIENCE=https://placeholder.invalid,API_SERVICE_ACCOUNT_EMAIL=${API_SA}
```

**3.2. Ler o endereço real do fetcher:**

```
FETCHER_URL=$(gcloud run services describe aletheia-fetcher --region=${REGION} --format="value(status.url)")
```

**3.3. Corrigir o `FETCHER_AUDIENCE`:**

```
gcloud run services update aletheia-fetcher --region=${REGION} --update-env-vars=FETCHER_AUDIENCE=${FETCHER_URL}
```

**3.4. Autorizar só a conta da API a chamar o fetcher:**

```
gcloud run services add-iam-policy-binding aletheia-fetcher --region=${REGION} --member="serviceAccount:${API_SA}" --role="roles/run.invoker"
```

**3.5. Conferir que o fetcher é privado.** Sem token, qualquer caminho deve dar **403**:

```
curl -s -o /dev/null -w "%{http_code}\n" ${FETCHER_URL}/
```

Confira também a política de acesso: deve listar só a conta da API como `roles/run.invoker`, e **não** pode aparecer `allUsers`:

```
gcloud run services get-iam-policy aletheia-fetcher --region=${REGION}
```

Não use `/healthz` neste teste: no Cloud Run ele devolveu uma página 404 do próprio Google (não do nosso aplicativo), o que indica que o caminho é interceptado antes de chegar ao serviço (hipótese forte, sem confirmação na documentação oficial). Um 404 ali não diz nada sobre o serviço ser privado.

**3.6. API.** Pública (ela autentica o usuário por conta própria), 1 GiB, concorrência 4, no máximo 2 instâncias, prazo de 60 s. A chave da ExifTools vem do Secret Manager; o Client ID vem do `secrets.sh` (confira que `echo ${#GOOGLE_CLIENT_ID}` mostra um número maior que zero; depois do `source`, confira também `echo $FETCHER_URL`, porque o `secrets.sh` pode definir essa variável para o teste local):

```
gcloud run deploy aletheia-api --image=southamerica-east1-docker.pkg.dev/${PROJECT_ID}/aletheia/api:${TAG} --region=${REGION} --service-account=${API_SA} --allow-unauthenticated --concurrency=4 --memory=1Gi --max-instances=2 --timeout=60 --set-env-vars=GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID},FETCHER_URL=${FETCHER_URL},FETCHER_AUDIENCE=${FETCHER_URL} --set-secrets=EXIFTOOLS_API_KEY=exiftools-api-key:latest
```

**Trocar a versão do segredo.** Para apontar a API para uma versão específica (o que também força uma revisão nova, que lê o segredo de novo):

```
gcloud run services update aletheia-api --region=${REGION} --set-secrets=EXIFTOOLS_API_KEY=exiftools-api-key:<número da versão>
```

**3.7. Conferências básicas da API:**

```
API_URL=$(gcloud run services describe aletheia-api --region=${REGION} --format="value(status.url)")
```

Sem token, deve dar **401**:

```
curl -s -o /dev/null -w "%{http_code}\n" ${API_URL}/api/me
```

**3.8. Teste ponta a ponta.** Suba a API e o web locais (ver `docs/desenvolvimento-local.md`), entre em `localhost:5000` e copie o ID token do cabeçalho `Authorization` da requisição `/api/me` (nunca cole o token em chat, issue ou commit). O token dura cerca de 1 hora:

```
curl -s -w "\nHTTP %{http_code} em %{time_total}s\n" -X POST ${API_URL}/api/check -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{"url":"https://example.com/"}'
```

Esperado: `HTTP 200`. Se falhar, veja os registros (sem URL, token nem e-mail; o campo `outcome` diz o motivo, e `exif` traz a contagem por status da ExifTools):

```
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=aletheia-api" --limit=10 --freshness=15m --format="json(jsonPayload.outcome,jsonPayload.exif)"
```

Resultado do primeiro deploy (27/10/2026): `HTTP 200` em cerca de 4,5 s na primeira chamada de uma instância nova, e em cerca de 5,7 s numa página com imagens. Isso **verificou** que o token emitido pelo servidor de metadados do Cloud Run é aceito pelo fetcher (claims `email` e `email_verified`) e que a API alcança o fetcher privado. Com uma página real (BBC), o fetcher baixou 8 mídias e a ExifTools respondeu `ok` para as 8 depois da correção do segredo (ver Etapa 1.3).

## Etapa 4: Firebase Hosting com rewrite de `/api/**`

Feita em 27/10/2026. Os comandos rodam na raiz do repositório, na `master` atualizada e sem alterações pendentes. Como o repositório não tem `.firebaserc`, todos levam `--project`. A CLI roda com `npx firebase-tools@15.34.0` (ver "Decisões"). O `npm` precisa ser 11.10 ou superior (exigência do `min-release-age` do `.npmrc`).

**4.1. Login** (abre o navegador; use a conta dona do projeto; no recurso opcional "Gemini in Firebase", responda **não**):

```
npx firebase-tools@15.34.0 login
```

**4.2. Conferir que a CLI enxerga o projeto:**

```
npx firebase-tools@15.34.0 projects:list
```

**4.3. Conferir o site de Hosting.** Deve existir um site padrão `<ID_DO_PROJETO>.web.app`:

```
npx firebase-tools@15.34.0 hosting:sites:list --project ${PROJECT_ID}
```

**4.4. Deploy.** Publica só `web/public`, com o rewrite e os cabeçalhos do `firebase.json`. No fim imprime o endereço (`Hosting URL`):

```
npx firebase-tools@15.34.0 deploy --only hosting --project ${PROJECT_ID}
```

```
HOST_URL=https://<endereço impresso>
```

**4.5. A página sobe e os cabeçalhos estão presentes:**

```
curl -sI ${HOST_URL}/ | grep -i -E "^(HTTP|content-security-policy|strict-transport-security|cross-origin-opener-policy|x-content-type-options|referrer-policy)"
```

Esperado: `200` e os cinco cabeçalhos. O `curl` do Git Bash pode negociar `HTTP/1.1`; isso não importa. O Hosting aplica o próprio `Strict-Transport-Security` (`max-age=31556926; includeSubDomains; preload`) no lugar do valor do `firebase.json`.

**4.6. O rewrite chega na API.** Sem token, **401**:

```
curl -s -o /dev/null -w "%{http_code}\n" ${HOST_URL}/api/me
```

**4.7. O cabeçalho `Authorization` passa pelo rewrite.** Com um token novo (como no 3.8), **200**:

```
curl -s -w "\nHTTP %{http_code}\n" ${HOST_URL}/api/me -H "Authorization: Bearer <token>"
```

**4.8. Limpeza.** A CLI cria `.firebase/` (cache local) e, em caso de erro, `firebase-debug.log`; ambos estão no `.gitignore`. Confira `git status --short`.

Resultado do primeiro deploy: página 200 com os cinco cabeçalhos; `/api/me` sem token 401; com token 200. Isso **verificou** que o rewrite do Hosting aceita a região `southamerica-east1`, alcança a API e preserva o `Authorization`. O corte de 60 s do Hosting **continua não medido**.

## Etapa 5: login no navegador pelo endereço de produção

Feita em 28/10/2026, pelo console do Google Cloud, sem comandos. Os nomes dos menus mudaram nos últimos anos; use os atuais.

1. **Origem autorizada.** No cliente OAuth do app web (o mesmo cujo Client ID está em `web/public/config.js`), em "Origens JavaScript autorizadas", adicione exatamente `https://<ID_DO_PROJETO>.web.app` (sem barra no final e sem caminho; o endereço real é o impresso no 4.4). Mantenha `http://localhost` e `http://localhost:5000`. Não são usadas "URIs de redirecionamento". A mudança pode levar de alguns minutos a algumas horas.
2. **Modo de teste.** Na tela de consentimento, o status deve ser "Em teste". Em "Usuários de teste", adicione os e-mails Google de quem vai testar. Só esses e-mails entram (limite de 100).
3. **Teste no navegador, em aba anônima, pelo endereço de produção:** login, "Verificar sessão" ("Sessão ativa"), relatório de uma página real, aba Rede só com o próprio domínio e `accounts.google.com`, download do JSON, e uma conta fora da lista de teste **bloqueada** pelo Google.

Resultado (28/10/2026): todos os itens passaram. O relatório de uma página real gerou 8 mídias analisadas (as demais, "Fora do limite"), com os sinais vazios, como esperado para imagens de CDN que removem metadados. Isso **não valida** os caminhos com sinal (localização, autoria, C2PA): ver `docs/pendencias.md`.

## Como retomar

Para quem volta ao projeto (ou a uma conversa nova):

- A fonte de verdade é este repositório (`docs/`). Cópias antigas em outros lugares (por exemplo, documentos de arquitetura e de política copiados para ferramentas externas) podem estar desatualizadas.
- Em cada janela do Git Bash, defina `PROJECT_ID`, `REGION`, `TAG`, `FETCHER_SA` e `API_SA` (Etapa 3), e `FETCHER_URL`, `API_URL` e `HOST_URL` (leia pelos comandos `describe` / pelo deploy). Carregue o `secrets.sh` (fora do repositório) só para testes locais e para criar o segredo.
- Serviços no ar (região `southamerica-east1`): `aletheia-fetcher` (privado), `aletheia-api` (público, atrás do Hosting), site do Hosting `<ID_DO_PROJETO>.web.app`. Imagens em `southamerica-east1-docker.pkg.dev/${PROJECT_ID}/aletheia/{api,fetcher}:<TAG>`.
- Publicar uma versão nova, em ordem: (1) `master` atualizada, `git status --short` vazio; (2) novo `TAG` e builds da Etapa 2; (3) `gcloud run deploy` de cada serviço com a imagem nova; (4) `deploy --only hosting` se o `web/` mudou; (5) repetir os testes 3.5, 3.7 e 4.6. **A verificar na primeira atualização:** que o `gcloud run deploy` com só `--image` preserva as demais configurações do serviço; na dúvida, repita todas as flags da Etapa 3.
- O que ainda não foi verificado e o que falta estão em "O que ainda não foi verificado" abaixo e em `docs/pendencias.md`.

## O que ainda não foi verificado

- O corte de 60 s do Hosting (`docs/api.md`, "Capacidade e implantação"): só se mede com uma checagem longa.
- A latência da checagem completa **pelo Hosting** (a medição de 4,5 s e 5,7 s foi direta na API).
- Se o `gcloud run deploy` só com `--image` preserva as demais configurações (ver "Como retomar").
- Se a CLI do Firebase funciona sempre com `ignore-scripts=true` (funcionou no primeiro deploy).
- Por que o Hosting substitui o `Strict-Transport-Security` do `firebase.json` pelo próprio valor.
- Que `/healthz` é interceptado pelo Cloud Run (hipótese forte, sem confirmação oficial).
- Os caminhos com sinal da ExifTools: localização, autoria e C2PA (ver `docs/pendencias.md`).
