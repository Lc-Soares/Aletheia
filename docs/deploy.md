# Deploy

Guia do primeiro deploy fechado (para a equipe testar), feito à mão e em etapas. A automação por GitHub Actions vem depois, quando cada peça estiver entendida. Os comandos são para o **Git Bash**, em **uma linha** (a quebra com `\` falhou ao colar no Windows). Nenhum ID real aparece aqui: os comandos usam `${PROJECT_ID}`.

Defina em cada janela nova:

```
PROJECT_ID=$(gcloud config get-value project)
```

Rode `echo $PROJECT_ID` e confira que mostra o ID real do projeto.

## Situação (25/10/2026)

| Etapa | O que faz | Situação |
| --- | --- | --- |
| 0 | Firebase no projeto existente | Feita |
| 1 | APIs, contas de serviço, segredo e orçamento | Feita, sem erro |
| 2 | Artifact Registry e imagens | Escrita, por executar (27/10/2026) |
| 3 | Deploy do fetcher (privado) e da API (pública) | Por escrever |
| 4 | Firebase Hosting e rewrite de `/api/**` | Por escrever |
| 5 | Origens OAuth de produção e modo de teste | Por escrever |

## Decisões

- **Primeiro deploy manual**, sem automação. Depois, GitHub Actions.
- **Crédito de teste do Google Cloud** (US$ 300) com faturamento ativo. O alerta de orçamento só avisa; quem limita o custo é o `--max-instances`.
- **Região:** preferência por `southamerica-east1`. O suporte do rewrite do Firebase Hosting a essa região **não foi verificado** (a página oficial não pôde ser lida por completo). Se o Hosting recusar com erro de região, usar `us-central1` e refazer o deploy da API.
- **Nome do site de Hosting:** padrão `<ID_DO_PROJETO>.web.app`. Um site adicional com nome mais limpo é opcional e se decide na Etapa 4.
- **CLI do Firebase:** necessária na Etapa 4 (o `gcloud` sozinho não faz o deploy do Hosting). A forma de instalar, com versão fixada e verificação de idade, será decidida então. Não instalar com `npm install -g` sem versão.

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

**1.4. Alerta de orçamento (console).** Faturamento, Orçamentos e alertas, criar orçamento. Sugestão: US$ 10, alertas em 50%, 90% e 100%, com e-mail. O orçamento só avisa, não corta o gasto.

## Etapa 2: Artifact Registry e imagens

Situação: o passo 2.1 (repositório de imagens) foi executado pelo desenvolvedor em 27/10/2026, sem erro. Os passos 2.2 a 2.5 aguardam o merge de deploy/cloudbuild.yaml.

Pré-requisitos: a Etapa 1 concluída e o arquivo `deploy/cloudbuild.yaml` na `master`. As imagens são as mesmas que o CI constrói (`docker build -f <serviço>/Dockerfile .`), mas aqui são construídas no Cloud Build e publicadas no Artifact Registry. O CI só constrói, não publica.

**2.1. Criar o repositório de imagens (uma vez).** Ele deve ficar na mesma região do Cloud Run:

```
gcloud artifacts repositories create aletheia --repository-format=docker --location=southamerica-east1 --description="Imagens do Aletheia"
```

Conferir:

```
gcloud artifacts repositories list --location=southamerica-east1
```

Se o Firebase Hosting recusar a região (ver "Decisões"), criar outro repositório em `us-central1` e refazer o build apontando `_IMAGE` para ele.

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

**Se der erro de permissão.** Em projetos novos, o Cloud Build usa por padrão a conta de serviço padrão do Compute Engine (mudança de maio e junho de 2024 na documentação oficial), e ela pode não ter permissão para ler o código enviado, gravar logs ou publicar a imagem. Não conceda papéis amplos por tentativa: copie só o trecho do erro (sem IDs reais). Ele diz qual conta e qual permissão faltam, e a correção é decidida com esse texto.

**Pendências desta etapa:** as imagens base `node:24-slim` dos dois Dockerfiles e a imagem do builder `gcr.io/cloud-builders/docker` ainda não estão fixadas por digest (há um `TODO` nos Dockerfiles). Fixar antes do lançamento (`docs/pendencias.md`).

## O que ainda não foi verificado

- Suporte do rewrite do Firebase Hosting a `southamerica-east1`.
- Se o cabeçalho `Authorization` passa intacto pelo rewrite (`docs/pendencias.md`, checklist do primeiro deploy).
- O corte de 60 s do Hosting (`docs/api.md`, "Capacidade e implantação").
- A forma e a versão de instalação da CLI do Firebase.
