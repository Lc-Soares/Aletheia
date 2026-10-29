# Pendências

Lista única do que falta, atualizada em **28/10/2026**, após o primeiro deploy fechado. Cada item aponta para a doc que trata do assunto, quando ela existe; os detalhes ficam lá, não aqui.

## Interface (`web/`)

- **Renovação do token:** migrar o callback do `prompt()` para não depender dos métodos de status do One Tap, que estão marcados como obsoletos com o FedCM (aviso `GSI_LOGGER` no console). Ver `docs/desenvolvimento-local.md`, "Renovação do ID token".
- **Nomes de autor ou de local:** se um dia passarem a ser exibidos, oferecer a opção de ocultar antes de mostrar (hoje a interface mostra só "contém localização" e "contém autoria declarada", sem valores).

## Próximas fases

- **PDF do relatório**, gerado no navegador (`docs/arquitetura.md`). O JSON e a interface do relatório já existem.
- **Fase 5**, uma de cada vez, com PR e teste próprios, nesta ordem:
  - 5a. ClaimReview em JSON-LD na própria página (sem chave);
  - 5b. Fact Check Tools (`claims.search`), com chave de API restrita a essa API. **Decidir antes de onde vem o texto da afirmação** (a página? o título?);
  - 5c. Web Risk, com conta de serviço e faturamento. **Ler os termos de uso comercial/sem fins lucrativos antes**;
  - 5d. Cloud Vision (Web Detection), pago. **Definir cota e alerta de orçamento antes.**
- **Fase 6:** lançamento limitado (`docs/arquitetura.md`, plano de fases).

## Validação pendente

- **C2PA com arquivo real. Não bloqueante para o primeiro deploy.** Para arquivos sem C2PA, o relatório vale como "não vimos assinatura". O caminho com C2PA real continua **não validado**, inclusive na interface, que só foi testada com fixtures sintéticas. O repositório `c2pa-org/public-testfiles` estava sem arquivos em 24/10/2026. Gerar uma imagem com Content Credentials ou achar outro conjunto de arquivos. O que falta verificar na ExifTools: `docs/api.md`, "Teste real da ExifTools".

## Segurança e operação

- **Limite por IP.** Adiado porque o `X-Forwarded-For` é parcialmente forjável atrás do Hosting e porque guardar IP afeta a política de privacidade (`docs/fetcher.md`, requisito 2).
- **Captcha, cota e alerta de orçamento** (`docs/arquitetura.md`).
- **DNS real não testado** (`docs/fetcher.md`, "Resolução de DNS").
- **Fetcher:**
  - extração em nível de token, uma melhoria possível (`docs/fetcher.md`);
  - tentar a variante seguinte quando a maior passa do limite;
  - mídia dentro de `<noscript>` (`docs/fetcher.md`, "Decisões abertas").
- **Dívida técnica:** criar um workspace compartilhado para o código duplicado entre API e fetcher (`docs/fetcher.md`, "Dívida técnica").
- **Geocodificação pela ExifTools:** saber se ela usa um terceiro para gerar `address`/`addressPlusCode`. Revisão jurídica (`docs/arquitetura.md`; nota 9 de `docs/politica-privacidade.md`).
- **Caminhos com sinal da ExifTools não exercitados.** Os testes reais só trouxeram imagens de CDN sem metadados (todos os sinais vazios). Falta uma página HTML de teste, controlada pela equipe, com uma imagem com EXIF e GPS, uma com autoria e uma com C2PA. O fetcher analisa páginas HTML, então uma URL direta de imagem provavelmente não serve para esse teste (confirmar em `fetcher/src/safe-fetch.ts`). Ver `docs/deploy.md`, Etapa 5.
- **Seleção de mídias.** Imagens genéricas do site ocupam vagas das 8 analisadas: um `grey-placeholder.png` de 501 bytes e um `poster-1024x576.png` de metadados apareceram como grupo 1. Avaliar ignorar imagens minúsculas ou conhecidas como genéricas (`docs/fetcher.md`).
- **Rota de saúde.** `/healthz` devolve 404 do Cloud Run quando chamado de fora (hipótese: caminho interceptado). Se for preciso um teste de saúde externo, renomear para `/health`. Sem urgência (`docs/deploy.md`, 3.5).
- **HSTS.** O Hosting aplica o próprio valor; a linha de `Strict-Transport-Security` do `firebase.json` provavelmente não tem efeito. Avaliar remover (`docs/deploy.md`, 4.5).
- **Nome do arquivo do relatório JSON** usa horário UTC (cosmético).
- **Dependência transitiva deprecada** `node-domexception` (via `fetch-blob@3.2.0`, em produção, no `package-lock.json`); sem vulnerabilidade apontada; a auditoria do CI continua valendo. Rastrear qual pacote nosso a puxa.
- **CLI do Firebase:** reavaliar a versão (15.34.0 em 27/10/2026) na próxima vez que for usada. Avisos de pacotes deprecados da própria CLI (`glob`, `uuid`, `json-ptr`) não estão no nosso lockfile (`docs/deploy.md`, "Decisões").
- **Corte de 60 s do Hosting** e latência pelo Hosting: medir com uma checagem longa (`docs/api.md`, "Capacidade e implantação"; `docs/deploy.md`, 4.7).

## Deploy

- **Guia passo a passo de implantação** em `docs/deploy.md`: Etapas 0 a 5 executadas (27 e 28/10/2026); o primeiro deploy fechado está no ar. O guia segue a documentação oficial atual, o checklist abaixo e as regras de implantação de `docs/fetcher.md` e `docs/api.md`.
- **Automação do deploy por GitHub Actions.** Hoje o CI só roda `npm run check`, a auditoria de dependências e o build das imagens, sem push nem deploy.
- **Orçamento com alerta:** criado (Etapa 1.4). Revisar o valor antes de abrir ao público (`docs/arquitetura.md`, abuso e custo).
- **Cópias externas desatualizadas** (documentos de arquitetura e de política de privacidade em outras ferramentas): este repositório é a fonte; refazer as cópias depois que as docs se estabilizarem, ou descartá-las.

## Checklist do primeiro deploy

- [x] Claims `email` e `email_verified` no ID token emitido pelo servidor de metadados do Cloud Run (`docs/fetcher.md`). A impersonação local já foi verificada. (Verificado no deploy, 27/10/2026: `docs/deploy.md`, 3.8.)
- [ ] `--ingress internal` e VPC: avaliar custo e complexidade (`docs/fetcher.md`).
- [x] O rewrite do Firebase Hosting preserva o cabeçalho `Authorization` até a API. (Verificado, 27/10/2026: `docs/deploy.md`, 4.7.)
- [x] A região `southamerica-east1` é suportada pelos serviços usados. (Cloud Run e Hosting funcionam em `southamerica-east1`.)
- [x] Faturamento ativo no projeto `<ID_DO_PROJETO>`. (Ativo; Etapa 0.)
- [x] Fetcher com `--concurrency 2`, 1 GiB e conta de serviço própria **sem papéis**. `roles/run.invoker` só para a `<conta de serviço da API>`. (Etapa 3, passos 3.1 a 3.5, 27/10/2026; o 403 sem token foi conferido.)
- [x] API com `--max-instances 2`, `--concurrency 4` e `--timeout 60` (`docs/api.md`, "Capacidade e implantação"). (Etapa 3, passo 3.6, 27/10/2026.)
- [x] `EXIFTOOLS_API_KEY` no Secret Manager. (Etapas 1.3 e 3.6; o segredo foi corrigido e verificado em 27/10/2026, com a ExifTools respondendo ok para as 8 mídias de uma página real; ver 1.3)
- [x] Origens OAuth de produção (`docs/desenvolvimento-local.md`, "Origens a autorizar"). (Etapa 5, 28/10/2026.)
- [ ] Vídeo/QuickTime na ExifTools.
- [ ] Placeholders da política de privacidade preenchidos e revisão jurídica.
- [x] Primeira chamada de uma instância nova: medir o atraso do token de serviço (`docs/api.md`, "Chamada ao fetcher"). (Cerca de 4,5 s, 27/10/2026, direto na API; pelo Hosting não foi medido.)
- [ ] Fixar por digest as imagens base node:24-slim dos Dockerfiles e a imagem gcr.io/cloud-builders/docker do Cloud Build, antes do lançamento.
