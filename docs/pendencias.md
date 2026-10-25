# Pendências

Lista única do que falta, atualizada em **24/10/2026**, ao fim da Fase 4. Cada item aponta para a doc que trata do assunto, quando ela existe; os detalhes ficam lá, não aqui.

## Interface (`web/`)

- **Renovação do token:** migrar o callback do `prompt()` para não depender dos métodos de status do One Tap, que estão marcados como obsoletos com o FedCM (aviso `GSI_LOGGER` no console). Ver `docs/desenvolvimento-local.md`, "Renovação do ID token".
- **Nomes de autor ou de local:** se um dia passarem a ser exibidos, oferecer a opção de ocultar antes de mostrar (hoje a interface mostra só "contém localização" e "contém autoria declarada", sem valores).

## Próximas fases

- **PDF do relatório**, gerado no navegador (`docs/arquitetura.md`). O JSON e a interface do relatório já existem.
- **Fase 5:**
  - ClaimReview em JSON-LD na própria página;
  - Fact Check Tools (`claims.search`), com chave de API restrita a essa API;
  - Cloud Vision (Web Detection) e Web Risk usando a conta de serviço, sem chave, com faturamento ativo.
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

## Deploy

- **Guia passo a passo de implantação** em `docs/deploy.md` (a criar). Será escrito à parte, a partir da documentação oficial atual, usando o checklist abaixo e as regras de implantação de `docs/fetcher.md` e `docs/api.md`.
- **Automação do deploy por GitHub Actions.** Hoje o CI só roda `npm run check`, a auditoria de dependências e o build das imagens, sem push nem deploy.
- **Orçamento com alerta** no projeto `<ID_DO_PROJETO>` (`docs/arquitetura.md`, abuso e custo).

## Checklist do primeiro deploy

- [ ] Claims `email` e `email_verified` no ID token emitido pelo servidor de metadados do Cloud Run (`docs/fetcher.md`). A impersonação local já foi verificada.
- [ ] `--ingress internal` e VPC: avaliar custo e complexidade (`docs/fetcher.md`).
- [ ] O rewrite do Firebase Hosting preserva o cabeçalho `Authorization` até a API.
- [ ] A região `southamerica-east1` é suportada pelos serviços usados.
- [ ] Faturamento ativo no projeto `<ID_DO_PROJETO>`.
- [ ] Fetcher com `--concurrency 2`, 1 GiB e conta de serviço própria **sem papéis**. `roles/run.invoker` só para a `<conta de serviço da API>`.
- [ ] API com `--max-instances 2`, `--concurrency 4` e `--timeout 60` (`docs/api.md`, "Capacidade e implantação").
- [ ] `EXIFTOOLS_API_KEY` no Secret Manager.
- [ ] Origens OAuth de produção (`docs/desenvolvimento-local.md`, "Origens a autorizar").
- [ ] Vídeo/QuickTime na ExifTools.
- [ ] Placeholders da política de privacidade preenchidos e revisão jurídica.
- [ ] Primeira chamada de uma instância nova: medir o atraso do token de serviço (`docs/api.md`, "Chamada ao fetcher").
