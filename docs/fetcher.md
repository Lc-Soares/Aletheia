# Fetcher

Serviço isolado que recebe a URL enviada pelo usuário, baixa a página e as mídias dela em memória e devolve título, manchete, lista de mídias e, para cada mídia baixada, bytes, SHA-256 e content-type. É o único componente que acessa a internet aberta. Não chama ExifTools, Vision, Web Risk nem Fact Check, e não lê ClaimReview (Fase 5).

## Regras de implantação (obrigatórias)

1. **Nunca implantar com invocação não autenticada.** Use `--no-allow-unauthenticated` e jamais `--allow-unauthenticated` ou `allUsers`/`allAuthenticatedUsers` em `roles/run.invoker`.
2. **`roles/run.invoker` só para a conta de serviço da API.** Nenhum usuário humano e nenhuma outra conta.
3. **Validação do token no código** (já implementada em `fetcher/src/auth.ts`). Toda chamada a `POST /fetch` precisa de `Authorization: Bearer <ID token>` emitido pelo Google:
   - assinatura válida;
   - `aud` igual a `FETCHER_AUDIENCE`, a URL do serviço;
   - `iss` do Google, `exp` no futuro;
   - `email_verified === true` e `email` igual a `API_SERVICE_ACCOUNT_EMAIL`.

   A validação no código é a segunda camada, caso o IAM seja mal configurado.
4. **Conta de serviço própria do fetcher, sem nenhum papel IAM.** O servidor de metadados do Google Cloud continua alcançável pela rede do contêiner. O código bloqueia 169.254.169.254 e `metadata.google.internal`, mas se algum dia houver um desvio, o token dessa conta não pode dar acesso a nada.
5. **Concorrência baixa por instância e limite de instâncias.** Cada requisição pode ocupar até 60 MiB de mídia em memória, mais a cópia em base64 de cada mídia durante a serialização (cerca de 4/3 do tamanho). Começar com:
   - `--concurrency` entre 2 e 4;
   - memória de 1 GiB;
   - `--max-instances` baixo, ajustado ao orçamento.
6. **Sem segredos.** O fetcher não usa chave de API nem Secret Manager. As variáveis de ambiente são só `PORT`, `FETCHER_AUDIENCE` e `API_SERVICE_ACCOUNT_EMAIL`, e nenhuma delas relaxa proteção.

**A verificar na documentação atual do Cloud Run (não é requisito):** `--ingress internal`. A página de ingress diz que chamadas vindas de outro Cloud Run precisam "passar por uma rede VPC considerada interna". Isso provavelmente exige Direct VPC egress ou conector de VPC na API. Avaliar custo e complexidade antes de adotar.

**A validar no primeiro deploy: claims do ID token.** A documentação do Google (tipos de token; Cloud Run service-to-service; identidade da instância) lista formalmente só `aud`, `azp`, `exp`, `iss` e `sub` no ID token. `email` e `email_verified` aparecem nos exemplos decodificados e nos exemplos de código (o de Java recusa `email_verified` falso), mas a prosa não garante esses campos. A documentação diz que "o conjunto exato de claims depende de como o token é pedido".
- O fetcher exige `email` e `email_verified` e falha fechado: sem eles, a resposta é 401.
- No primeiro deploy, decodificar um token real obtido pela API e conferir os campos.
- Se o e-mail não vier, a alternativa é comparar `sub`, o ID numérico único da conta de serviço da API, em vez do e-mail.

## Contrato HTTP

| Rota | Método | Autenticação | Resposta |
| --- | --- | --- | --- |
| `/healthz` | GET | nenhuma | `200 {"status":"ok"}` |
| `/fetch` | POST | Bearer (ID token) | NDJSON em streaming |

`POST /fetch` recebe `Content-Type: application/json` com o corpo `{"url":"https://..."}`, de até 4 KiB. A URL vai no corpo, nunca na query string, e uma URL na query é ignorada.

Resposta `200`, `application/x-ndjson`, com uma linha JSON por evento:

```
{"type":"page","finalUrl":"...","title":"...","headline":"...","media":[{"url":"...","kind":"image","source":"og:image"}, ...]}
{"type":"media","url":"...","kind":"image","source":"img","contentType":"image/jpeg","size":12345,"sha256":"<hex>","data":"<base64>"}
{"type":"media_error","url":"...","kind":"image","source":"img","error":"blocked"}
{"type":"done"}
```

- `media` lista todas as referências encontradas, até 200. Só as primeiras 20 são baixadas, começando por og:image/og:video e seguindo a ordem do documento.
- A resposta é transmitida em streaming (chunked). A página de cotas do Cloud Run diz que o limite de 32 MiB por resposta HTTP/1 não se aplica com `Transfer-Encoding: chunked` ou streaming.
- Os campos `title`, `headline` e `url` são texto controlado por terceiros. Quem exibir esse texto precisa escapá-lo.

Erros:

| Status | Quando | Corpo |
| --- | --- | --- |
| 400 | JSON inválido ou `url` ausente | `{"error":"Requisição inválida"}` |
| 401 | Token ausente ou inválido | `{"error":"Não autorizado"}` e `WWW-Authenticate: Bearer` |
| 404 / 405 | Rota ou método errado | genérico |
| 413 | Corpo acima de 4 KiB | genérico |
| 415 | Content-Type diferente de JSON | genérico |
| 422 | Falha ao buscar a página | `{"error":"<categoria>","message":"<texto genérico>"}` |
| 431 | Cabeçalhos acima de 8 KiB | (Node) |
| 500 | Erro inesperado | `{"error":"Erro interno"}` |

Categorias, que também aparecem em `media_error`:

| Categoria | Mensagem |
| --- | --- |
| `invalid_url` | URL inválida |
| `blocked` | Destino bloqueado |
| `timeout` | Tempo esgotado |
| `too_large` | Conteúdo grande demais |
| `unsupported_type` | Tipo não suportado |
| `too_many_redirects` | Redirecionamentos demais |
| `upstream_status` | O site respondeu com erro |
| `network` | Falha de rede |

As mensagens nunca contêm IP, URL, hostname ou texto do sistema operacional.

## Proteção contra SSRF

Toda URL, seja a do usuário, um redirecionamento ou uma mídia extraída do HTML, passa pelo mesmo caminho (`safeFetch`):

1. **Forma da URL** (`url-policy.ts`, API WHATWG `URL`):
   - só `http:`/`https:`;
   - só portas 80 e 443;
   - sem usuário/senha;
   - sem hostname vazio ou com rótulo vazio;
   - sem nome single-label (`intranet`, `metadata`, `localhost`) que não seja IP literal;
   - sem `*.localhost`, `*.internal` (inclui `metadata.google.internal`), `*.local` e `*.home.arpa`;
   - até 2048 caracteres.

   O parser WHATWG normaliza IPv4 em decimal, octal, hexadecimal e abreviado (`2130706433`, `0177.0.0.1`, `0x7f.1`, `127.1`) para quatro octetos antes da checagem.
2. **DNS uma única vez** (`resolve.ts`). Todos os IPs devolvidos precisam ser permitidos; um só proibido bloqueia o nome.
3. **Política de IP** (`ip-policy.ts`):
   - IPv4 bloqueado: 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4 e 240/4.
   - IPv6: só 2000::/3 é aceito, menos 2001::/23 (inclui Teredo), 2001:db8::/32, 2002::/16 e 3fff::/20. Isso já exclui ::, ::1, fc00::/7, fe80::/10, fec0::/10, ff00::/8, 64:ff9b::/96 e ::/96.
   - IPv4-mapeado (`::ffff:a.b.c.d`) é avaliado pelo IPv4 embutido.
4. **Conexão fixada no IP** (`transport.ts`):
   - O fetcher abre o TCP direto no IP validado, sem nova resolução.
   - Confere `socket.remoteAddress` antes de enviar qualquer byte.
   - Faz o TLS com SNI e verificação de certificado do hostname original e envia `Host` com o hostname original.
   - Não usa agent nem pool de conexões, e não lê variáveis de proxy.
5. **Redirecionamentos manuais:** no máximo 5, e cada salto volta ao passo 1.
6. **Content-type declarado** contra a allowlist antes de ler o corpo.
7. **Corpo lido com limite** (`body.ts`):
   - conta os bytes antes e depois de descompactar (gzip, deflate, br; outras codificações são recusadas);
   - aborta no primeiro chunk acima do limite;
   - recusa de cara um `Content-Length` acima do limite.

Pedidos enviados: só GET, `User-Agent: AletheiaFetcher/0.1 (+https://github.com/Lc-Soares/Aletheia)`, `Accept`, `Accept-Encoding` e `Connection: close`. Nunca Cookie, Authorization ou Referer.

Os testes usam resolvedor e transporte injetados. A única "política de teste" (`TEST_LOOPBACK_POLICY`, que libera 127.0.0.1 para servidores locais) existe em `fetcher/src/testing.ts`, fora da imagem de produção. `main.ts` usa sempre `isPublicAddress` e `DEFAULT_LIMITS`. `resolveLimits` só deixa reduzir limites.

## Limites e justificativas

| Limite | Valor | Justificativa |
| --- | --- | --- |
| Conexão + TLS + cabeçalhos, por salto | 5 s | Servidor saudável responde cabeçalhos bem antes disso; corta servidores que seguram a conexão. |
| HTML (redirecionamentos + corpo) | 10 s | O "cerca de 10 s" da arquitetura. |
| Cada mídia (redirecionamentos + corpo) | 20 s | 15 MiB precisam de banda razoável; 20 s dá cerca de 6 Mbit/s. |
| Página inteira (HTML + mídias) | 30 s | Cabe no fluxo SSE da API; mídias pendentes viram `timeout`, e o resto do relatório segue. |
| HTML descompactado | 2 MiB | Páginas de notícia raramente passam disso; limita a memória do parse5. |
| Cada mídia descompactada | 15 MiB | Cobre fotos de câmera e celular em alta resolução e clipes curtos; bem abaixo dos 100 MB da ExifTools. O limite da Cloud Vision ainda deve ser conferido na documentação oficial antes da Fase 5. Vídeos maiores viram `too_large` e entram no relatório como limitação. |
| Mídia agregada por página | 60 MiB | 20 × 15 MiB daria 300 MiB por requisição; o teto agregado mantém a instância em 1 GiB com concorrência baixa. |
| Mídias baixadas por página | 20 | Custo e tempo; as mais relevantes (og:image) vêm primeiro. |
| Downloads simultâneos | 4 | Equilibra tempo total e pressão sobre o site de origem. |
| Referências listadas | 200 | Evita resposta gigante em páginas com milhares de imagens. |
| Nós HTML percorridos | 100 000 | Teto de CPU da varredura; a varredura é iterativa, sem recursão. |
| Redirecionamentos | 5 | Definido na arquitetura. |
| Cabeçalhos de resposta | 16 KiB | Padrão do Node; cabeçalhos maiores são anormais. |
| URL | 2048 caracteres | Limite prático de navegadores e CDNs. |
| Corpo da requisição ao fetcher | 4 KiB | Só carrega uma URL. |
| Cabeçalhos da requisição ao fetcher | 8 KiB | Igual à API. |

Content-types aceitos:
- página: `text/html` e `application/xhtml+xml`;
- imagens: `image/jpeg` (e o apelido `image/jpg`), `png`, `gif`, `webp`, `avif`, `heic`, `heif` e `tiff`;
- vídeos: `video/mp4`, `webm` e `quicktime`.

SVG fica de fora porque é XML e pode conter script.

## Extração de HTML

Usa parse5 (WHATWG, o mesmo algoritmo dos navegadores) sem executar script e sem buscar recurso nenhum.
- **Coleta:** `meta property|name = og:image[:url|:secure_url]`, `og:video[...]` e `og:title`; `img[src|srcset]`; `source[src|srcset]` dentro de `picture`/`video`; `video[src|poster]`; `<title>`; o primeiro `<h1>`.
- **Resolução:** honra o primeiro `<base href>` http(s); descarta `data:`, `javascript:`, `blob:` e outros esquemas; remove fragmento e duplicadas.
- **Fora da varredura:** conteúdo de `<template>`, `<script>`, comentários, atributos e `<noscript>` (que o parse5 trata como texto).
- **Charset:** vem do cabeçalho `Content-Type`. Se for desconhecido ou estiver ausente, usa UTF-8. Não há detecção por `<meta charset>`.

## Decisões abertas (sem implementação nesta fase)

- **Mídia dentro de `<noscript>`:** sites com lazy-load colocam a imagem real ali. Extrair exigiria parsear o conteúdo do noscript como fragmento.
- **`meta name=twitter:image`:** é comum em páginas sem og:image. Decidir se entra como fonte de mídia.

## Dívida técnica

- `extractBearerToken`, a verificação de ID token (`auth.ts`) e os auxiliares de teste (`testing.ts`) estão duplicados entre `api/src` e `fetcher/src`. A candidata é um workspace compartilhado (por exemplo `shared/`) numa fase futura.
- `shutdown()` também está duplicado entre `api/src/server.ts` e `fetcher/src/server.ts`.

## O que não foi testado contra a internet real

Todos os testes usam DNS e transporte simulados, ou um servidor HTTP local em 127.0.0.1. Ainda não foram verificados:
- Sites reais: variedade de HTML, charset sem cabeçalho, lazy-load, imagens servidas por JavaScript.
- Sites e CDNs que bloqueiam o User-Agent próprio, exigem cookies ou aplicam desafio anti-bot (Cloudflare e afins).
- Redes sociais (Instagram, X, Facebook, TikTok), que costumam exigir login ou JavaScript.
- HTTPS de ponta a ponta: SNI e verificação de certificado usam o hostname, mas não há teste com certificado TLS real.
- IPv6 real (só a política foi testada) e DNS real (`dns.lookup` do sistema).
- Comportamento no Cloud Run: streaming NDJSON grande, memória por instância, ID token real da conta de serviço e alcance do servidor de metadados.
