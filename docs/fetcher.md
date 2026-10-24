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
5. **Concorrência 2 por instância e limite de instâncias.** O próprio fetcher aceita no máximo 2 requisições `/fetch` em andamento (`maxInFlightFetches`) e responde `503` com `Retry-After: 1` acima disso, então a memória não depende do `--concurrency` do Cloud Run. Mesmo assim:
   - `--concurrency 2` e memória de 1 GiB (conta em "Orçamento de memória por instância", abaixo). Com um `--concurrency` maior, o Cloud Run mandaria requisições para uma instância que responde 503, em vez de abrir outra instância;
   - `--max-instances` baixo, ajustado ao orçamento.
6. **Sem segredos.** O fetcher não usa chave de API nem Secret Manager. As variáveis de ambiente são só `PORT`, `FETCHER_AUDIENCE` e `API_SERVICE_ACCOUNT_EMAIL`, e nenhuma delas relaxa proteção.

**A verificar na documentação atual do Cloud Run (não é requisito):** `--ingress internal`. A página de ingress diz que chamadas vindas de outro Cloud Run precisam "passar por uma rede VPC considerada interna". Isso provavelmente exige Direct VPC egress ou conector de VPC na API. Avaliar custo e complexidade antes de adotar.

**A validar no primeiro deploy: claims do ID token.** A documentação do Google (tipos de token; Cloud Run service-to-service; identidade da instância) lista formalmente só `aud`, `azp`, `exp`, `iss` e `sub` no ID token. `email` e `email_verified` aparecem nos exemplos decodificados e nos exemplos de código (o de Java recusa `email_verified` falso), mas a prosa não garante esses campos. A documentação diz que "o conjunto exato de claims depende de como o token é pedido".
- O fetcher exige `email` e `email_verified` e falha fechado: sem eles, a resposta é 401.
- **Verificado localmente (24/10/2026):** com a impersonação do gcloud (`docs/desenvolvimento-local.md`), o ID token da conta de serviço trouxe `email` e `email_verified`, e o fetcher o aceitou.
- **Não verificado:** o caminho pelo servidor de metadados do Cloud Run, que é o usado em produção. No primeiro deploy, decodificar um token real obtido pela API e conferir os campos.
- Se o e-mail não vier, a alternativa é comparar `sub`, o ID numérico único da conta de serviço da API, em vez do e-mail.

## Contrato HTTP

| Rota | Método | Autenticação | Resposta |
| --- | --- | --- | --- |
| `/healthz` | GET | nenhuma | `200 {"status":"ok"}` |
| `/fetch` | POST | Bearer (ID token) | NDJSON em streaming |

`POST /fetch` recebe `Content-Type: application/json` com o corpo `{"url":"https://..."}`, de até 4 KiB. A URL vai no corpo, nunca na query string, e uma URL na query é ignorada.

Resposta `200`, `application/x-ndjson`, com uma linha JSON por evento:

```
{"type":"page","finalUrl":"...","title":"...","headline":"...","possiblyNeedsJavaScript":false,"media":[{"url":"...","kind":"image","source":"og:image","group":1,"score":100,"selected":true,"skipReason":null}, ...]}
{"type":"media","url":"...","kind":"image","source":"img","group":2,"contentType":"image/jpeg","size":12345,"sha256":"<hex>","data":"<base64>"}
{"type":"media_error","url":"...","kind":"image","source":"img","group":3,"error":"upstream_status","httpStatus":404}
{"type":"media_error","url":"...","kind":"image","source":"img","group":4,"error":"blocked"}
{"type":"done"}
```

- `media` lista todas as referências encontradas, até 200, na ordem de coleta (og:image, twitter:image e og:video primeiro, depois a ordem do documento). Cada item traz:
  - `group`: o grupo da mídia (variantes da mesma imagem), numerado pelo ranking (1 = melhor);
  - `score`: a pontuação do grupo, inteiro entre −1000 e 1000, para calibrar os pesos;
  - `selected`: se será baixada;
  - `skipReason`: `null` quando selecionada; senão `variant` (outra variante do grupo foi a escolhida), `icon` (ícone ou elemento de interface), `unsupported_format` (SVG), `low_score` (pontuação negativa: sinais de elemento secundário da página), `limit` (passou de `maxSelectedMedia`) ou `other` (reservado; aceito, mas não emitido hoje).
- Só as selecionadas são baixadas, no máximo `maxSelectedMedia` (8), em ordem de grupo. Ver "Seleção de mídias (heurística)".
- `possiblyNeedsJavaScript` é um sinal heurístico, nunca certeza. Ver "Sinal de página montada por JavaScript".
- `httpStatus` só aparece com `upstream_status`: o número do status HTTP que o site respondeu (100 a 599), nada do corpo nem dos cabeçalhos.
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
| 422 | Falha ao buscar a página | `{"error":"<categoria>","message":"<texto genérico>"}`; com `upstream_status`, também `"httpStatus":<número>` |
| 431 | Cabeçalhos acima de 8 KiB | (Node) |
| 500 | Erro inesperado | `{"error":"Erro interno"}` |
| 503 | Instância ocupada: 2 requisições já em andamento, ou fila do worker de extração cheia | `{"error":"Serviço ocupado"}` e `Retry-After: 1` |

Categorias, que também aparecem em `media_error`:

| Categoria | Mensagem |
| --- | --- |
| `invalid_url` | URL inválida |
| `blocked` | Destino bloqueado |
| `timeout` | Tempo esgotado |
| `too_large` | Conteúdo grande demais |
| `unsupported_type` | Tipo não suportado |
| `too_many_redirects` | Redirecionamentos demais |
| `upstream_status` | O site respondeu com erro (status fora de 2xx, ou redirecionamento sem `Location`) |
| `network` | Falha de rede |

As mensagens nunca contêm IP, URL, hostname ou texto do sistema operacional. Em `upstream_status`, o `FetchError` guarda o `httpStatus` (só o número, e só se for inteiro de 100 a 599), que vai no corpo do 422 e na linha `media_error`.

Logs: uma linha JSON por requisição, com método, rota normalizada, status, duração, resultado e `domainHash`. O `domainHash` é um HMAC-SHA-256 truncado do hostname com chave aleatória gerada na inicialização do processo e nunca gravada. Ele correlaciona requisições só dentro da mesma instância e não se reverte por dicionário (um SHA-256 sem chave dos domínios populares se reverteria).

**Exatamente uma linha por requisição**, também quando a resposta não termina. A linha sai quando a resposta termina; se ela fechar antes, sai quando fecha. Nunca há URL, caminho, corpo, token ou domínio em claro, só o mesmo `domainHash`.

| `outcome` | Quando |
| --- | --- |
| `ok` | Resposta NDJSON completa. |
| categoria de `FetchError` (`timeout`, `blocked`...) | Falha ao buscar a página (422). |
| `unauthorized`, `bad_request`, `bad_content_type`, `body_too_large`, `busy` | Erros 401, 400, 415, 413 e 503. |
| `stream_idle_timeout` | O fetcher destruiu a resposta porque quem chamou não esvaziou uma fatia de 64 KiB por `streamIdleMs` (10 s). |
| `stream_total_timeout` | O fetcher destruiu a resposta porque o streaming passou de `streamTotalMs` (60 s). |
| `client_closed` | Quem chamou fechou a conexão antes do fim, durante a busca ou durante o streaming. |
| `internal_error` | O fetcher destruiu a resposta por um erro inesperado depois de já ter enviado os cabeçalhos (antes deles, a resposta é o 500 genérico). |

Quando o próprio fetcher destrói a resposta (os dois prazos e `internal_error`), a categoria vem do estado dos sinais e é registrada **antes** do `destroy()`. Por isso essas linhas nunca viram `client_closed`; só vira `client_closed` o fechamento que o fetcher não causou.

**`status`:** o código HTTP já enviado. Numa resposta destruída no meio do streaming, é o 200 que já tinha saído. **`status: 0`** significa que nada foi enviado antes do fechamento (por exemplo, quem chamou desistiu durante a busca da página). Linhas `stream_*` e `client_closed` em volume são o sinal de alguém segurando vagas da instância de propósito.

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
2. **DNS uma única vez** (`resolve.ts`). Todos os IPs devolvidos precisam ser permitidos; um só proibido bloqueia o nome. Ver "Resolução de DNS", abaixo.
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

### Resolução de DNS

- **c-ares, não `getaddrinfo`.** `dns.promises.Resolver` com `timeout` de 1 s e 2 tentativas, consultando `resolve4` e `resolve6` em paralelo. O `getaddrinfo` do sistema ocupa uma thread do threadpool do libuv (4 por padrão) até o timeout do sistema operacional, mesmo depois que o fetcher desistiu. Uma página com mídias em subdomínios de um DNS que nunca responde prendia as 4 threads e parava o zlib e o DNS de toda a instância (achado 4 da revisão). O c-ares não usa o threadpool.
- **Prazo rígido de 3 s por salto** (`dnsHopMs`), independente do prazo do download. Ao esgotar, a resolução vira `timeout` e as consultas são canceladas. O pior caso fica previsível: não depende de quantos servidores DNS o sistema tem nem do recuo do c-ares. Medido contra um servidor UDP local que nunca responde (Node 24.22.1, Windows):

  | Configuração | Pior caso por resolução |
  | --- | --- |
  | c-ares sozinho, `timeout` 1,5 s, 2 tentativas (antes) | cerca de 5,0 s |
  | c-ares sozinho, `timeout` 1 s, 2 tentativas | cerca de 4,0 s (o c-ares dobra a espera na segunda tentativa) |
  | c-ares sozinho, `timeout` 2 s, 1 tentativa | cerca de 2,0 s |
  | **adotado: `timeout` 1 s, 2 tentativas, prazo de 3 s** | **3,0 s** (4 pacotes: 2 tentativas × 2 famílias) |

  Por que 2 tentativas e não 1: com a regra de falhar fechado, um único pacote UDP perdido derrubaria a página com `network`. A segunda tentativa sai depois de 1 s e cabe no prazo. Com 1 tentativa e 2 s, a configuração seria mais simples e quase tão previsível, mas sem tolerância a perda.
- **Um resolvedor por consulta**, cancelado (`cancel()`) quando a requisição aborta, o prazo do salto esgota ou o prazo do download (HTML ou mídia) esgota. Assim, cancelar uma requisição não cancela as consultas de outra.
- **Uma família falha e a outra responde:**
  - se a falha é "sem registro" (`ENODATA` ou `ENOTFOUND`), segue com a família que respondeu (há nomes só com A ou só com AAAA);
  - qualquer outra falha (`ETIMEOUT`, `ESERVFAIL`, `EREFUSED`, resposta inválida etc.) **falha fechado** com `network`, porque não dá para garantir que vimos todos os IPs;
  - nenhuma família com registro: `network`;
  - prazo do salto esgotado com qualquer família pendente: `timeout` (também fechado, mesmo que a outra já tenha respondido).
- **Um DNS mudo pode chegar como `network` ou como `timeout`** (achado 3 da terceira revisão). Depende de quem desiste primeiro: o c-ares ou o prazo de 3 s. Com um único servidor DNS, o revisor viu o c-ares desistir em cerca de 2,6 s, com `ETIMEOUT`, que vira `network`. Com três servidores, o prazo corta antes e o resultado é `timeout`. Na máquina de desenvolvimento (Windows), com um servidor, o corte veio em 3,0 s como `timeout`. Então o número de servidores e a plataforma mudam a categoria. Isso não revela nada interno, porque o servidor mudo é do atacante. Mas a mesma falha pode chegar à API com duas categorias, e a API deve tratá-las da mesma forma na mensagem ao usuário (ver "Requisitos para a API").
- **Diferença em relação ao `getaddrinfo`:** `resolve4` e `resolve6` consultam os servidores DNS configurados e não leem `/etc/hosts`. Nomes como `localhost` já são recusados antes, pela política de URL.
- **Mitigação adicional:** `UV_THREADPOOL_SIZE=16` no Dockerfile, porque zlib e crypto continuam no threadpool.

**Limitação a revisar com dados reais:** a regra de falhar fechado quando uma família dá erro diferente de "sem registro" troca disponibilidade por segurança. Servidores autoritativos que respondem SERVFAIL ou não respondem a AAAA existem e fariam o site inteiro falhar com `network`. Como a conexão é sempre feita num IP já validado, aceitar só a família que respondeu não abriria SSRF; só afrouxaria a regra de "todos os IPs". Rever com a taxa real de falhas depois do deploy. **O DNS real não foi testado:** as combinações de famílias usam um cliente c-ares falso. O c-ares de verdade só foi exercitado contra um servidor DNS UDP local em 127.0.0.1 (respostas A/AAAA, NXDOMAIN e servidor mudo). Os valores de `timeout`, `tries` e prazo ainda não foram observados contra servidores reais, com perda de pacote real, nem contra o DNS do Cloud Run.

## Limites e justificativas

| Limite | Valor | Justificativa |
| --- | --- | --- |
| DNS, por salto | 3 s | Pior caso previsível contra servidor mudo; c-ares com 1 s × 2 tentativas. Ver "Resolução de DNS". |
| Conexão + TLS + cabeçalhos, por salto | 5 s | Servidor saudável responde cabeçalhos bem antes disso; corta servidores que seguram a conexão. |
| HTML (redirecionamentos + corpo) | 10 s | O "cerca de 10 s" da arquitetura. |
| Cada mídia (redirecionamentos + corpo) | 20 s | 15 MiB precisam de banda razoável; 20 s dá cerca de 6 Mbit/s. |
| Página inteira (HTML + mídias) | 30 s | Cabe nos 40 s da fase do fetcher na API e no prazo total de 50 s da resposta JSON (`docs/api.md`); mídias pendentes viram `timeout`, e o resto do relatório segue. |
| HTML descompactado | 2 MiB | Páginas de notícia raramente passam disso. **Não limita a memória do parse5:** uma página hostil de cerca de 55 KB gera milhões de nós. Quem limita é o heap do worker de extração. |
| Cada mídia descompactada | 15 MiB | Cobre fotos de câmera e celular em alta resolução e clipes curtos; bem abaixo dos 100 MB da ExifTools. O limite da Cloud Vision ainda deve ser conferido na documentação oficial antes da Fase 5. Vídeos maiores viram `too_large` e entram no relatório como limitação. |
| Mídia agregada por página | 60 MiB | 8 × 15 MiB daria 120 MiB por requisição; o teto agregado mantém a instância em 1 GiB com concorrência baixa. |
| Mídias selecionadas (baixadas) por página (`maxSelectedMedia`) | 8 | Substitui o antigo teto de 20 downloads. Uma matéria típica tem 1 imagem principal e poucas no corpo; 8 cabem em 2 rodadas de 4 downloads; 60 MiB / 8 dá cerca de 7,5 MiB por mídia; as requisições de saída por chamada caem de 126 para 54 ((1 + 8) × 6); o custo das APIs da Fase 5 é por mídia. Só reduzível, como os demais. |
| Downloads simultâneos | 4 | Equilibra tempo total e pressão sobre o site de origem. |
| Referências listadas | 200 | Evita resposta gigante em páginas com milhares de imagens. |
| Nós HTML percorridos | 100 000 | Teto de CPU da varredura, que é iterativa e sem recursão. Atua depois do parse e **não limita o parse em si**: a memória e a CPU do parse5 são limitadas pelo worker. |
| Extração (worker): prazo | 2,5 s | Inclui subir o worker. Ver "Extração isolada em worker". |
| Extração (worker): heap | 128 MiB (old) + 32 MiB (young) | Página legítima de 2 MiB usa cerca de 90 MiB de RSS; estourar vira `too_large`. |
| Extrações simultâneas | 2 | Fila compartilhada pela instância, de até 4 (2 × concorrência); acima disso, 503. Quem espera desiste pelo prazo da página. |
| Requisições `/fetch` em andamento | 2 | Cada uma pode segurar até cerca de 126 MiB; acima disso, 503 rápido, depois da autenticação e antes de ler o corpo. A vaga só volta no fim do streaming, que tem os dois prazos abaixo. |
| Resposta NDJSON: inatividade de escrita | 10 s | Conta só enquanto o fetcher espera o `drain` de uma fatia de 64 KiB, ou seja, enquanto quem chamou não está lendo. Um consumidor saudável em memória, na mesma região, esvazia 64 KiB em milissegundos; 10 s sem esvaziar 64 KiB é menos de 6,4 KB/s, na prática um leitor parado. Esgotado, a resposta é destruída e a vaga volta. Uma origem lenta não conta: o `fetchPage` termina antes do `writeHead`. |
| Resposta NDJSON: prazo total | 60 s | Desde o `writeHead`. A maior resposta tem cerca de 80 MiB (60 MiB de mídia em base64 mais a linha `page`); 60 s exigem cerca de 11 Mbit/s, muito abaixo da rede entre serviços do Cloud Run. Corta o leitor que lê aos poucos para fugir da inatividade. Com o prazo da página (30 s), uma vaga fica presa no máximo cerca de 90 s, contra os 300 s padrão do Cloud Run. |
| Redirecionamentos | 5 | Definido na arquitetura. |
| Cabeçalhos de resposta | 16 KiB | Padrão do Node; cabeçalhos maiores são anormais. |
| URL | 2048 caracteres | Limite prático de navegadores e CDNs. |
| Corpo da requisição ao fetcher | 4 KiB | Só carrega uma URL. |
| Cabeçalhos da requisição ao fetcher | 8 KiB | Igual à API. |

Content-types aceitos:
- página: `text/html` e `application/xhtml+xml`;
- imagens: `image/jpeg` (e o apelido `image/jpg`), `png`, `gif`, `webp`, `avif`, `heic`, `heif` e `tiff`;
- vídeos: `video/mp4`, `webm` e `quicktime`.

SVG fica de fora porque é XML e pode conter script. Quando dá para reconhecê-lo antes do download (nome de arquivo `.svg`/`.svgz` ou `<source type="image/svg+xml">`), ele é listado como ignorado (`unsupported_format`), sem conexão. Um SVG servido sem essa extensão ainda é baixado e recusado pelo content-type (`unsupported_type`).

## Extração de HTML

Usa parse5 (WHATWG, o mesmo algoritmo dos navegadores) sem executar script e sem buscar recurso nenhum.
- **Coleta:** `meta property|name = og:image[:url|:secure_url]`, `twitter:image[:src]`, `og:video[...]` e `og:title`; `img[src|srcset]`; `source[src|srcset]` dentro de `picture`/`video`; `video[src|poster]`; `<title>`; o primeiro `<h1>`.
- **Coleta com teto:** os valores brutos são deduplicados já na coleta e param em 4 × `maxMediaRefs` (800) por lista (og e corpo), antes de resolver as URLs. Sem esse teto, 100 mil nós com `srcset` gerariam milhões de entradas e de `new URL` (achado 7 da revisão). A folga cobre valores inválidos e variações que viram a mesma URL (por exemplo, fragmentos diferentes).
- **Resolução:** honra o primeiro `<base href>` http(s); descarta `data:`, `javascript:`, `blob:` e outros esquemas; remove fragmento e duplicadas.
- **Fora da varredura:** conteúdo de `<template>`, `<script>`, comentários, atributos e `<noscript>` (que o parse5 trata como texto).
- **Charset:** vem do cabeçalho `Content-Type`. Se for desconhecido ou estiver ausente, usa UTF-8. Não há detecção por `<meta charset>`.

### Seleção de mídias (heurística)

Decisão de produto: o sistema escolhe sozinho as imagens principais, para usuários leigos, e o relatório mostra o que foi analisado e o que foi ignorado, com o motivo. Tudo roda dentro do worker de extração (`extract.ts` e `select.ts`), com os mesmos limites de heap, prazo e nós. **São regras heurísticas, determinísticas e revisáveis; nenhuma delas afirma o que a imagem é.**

**Grupos (variantes da mesma mídia).** Vêm da estrutura do HTML, sem adivinhar por padrão de URL:
- todos os candidatos de um `srcset` e o `src` do mesmo `<img>`;
- todas as `<source>` de um `<picture>` e o `<img>` filho direto dele;
- o `src` de um `<video>` e as `<source>` filhas dele (o `poster` é grupo próprio);
- cada valor distinto de og:image, twitter:image e og:video é um grupo próprio;
- a mesma URL (já resolvida, sem fragmento) em dois elementos une os dois grupos, se forem do mesmo tipo (imagem ou vídeo), e a URL é listada uma vez só.

**Variante baixada.** A de maior descritor `w`, se algum candidato tiver `w`; senão a de maior `x` (um `src` de `<img>` e um candidato sem descritor contam como 1x); senão a primeira em ordem de coleta. Empate fica com a primeira. Candidato SVG nunca é escolhido; um grupo só de SVG fica como `unsupported_format`. As outras variantes ficam como `variant`.

**Pontuação.** Cada sinal conta uma vez por grupo, venha de qual membro vier (sinais como bits, somados). A soma é limitada a −1000..1000.

| Sinal | Peso | Observação |
| --- | --- | --- |
| og:image, og:video, twitter:image | +100 | A página declara a mídia principal. |
| Ancestral `<article>`, `<main>` ou `<figure>` | +20 | Conteúdo da página. |
| Ancestral `<nav>` ou `<aside>`; `<header>` ou `<footer>` fora de article/main | −30 | O `<header>` de um `<article>` é o topo da matéria e não rebaixa. |
| `role="presentation"` ou `aria-hidden="true"` no elemento ou no `<picture>` | −40 | Decoração, segundo a própria página. |
| Palavra icon(s), logo(s), sprite(s), avatar(s) ou favicon em `class`, `id`, `alt` ou no nome do arquivo | −40 | Palavra inteira: trechos de `[a-z0-9]` depois de passar para minúsculas. `site-logo` conta; `logotipo` e `siteLogo` não. |
| `width` ou `height` declarado até 64 | −60 | Só os dígitos iniciais do atributo (`24`, `24px`); porcentagem não conta. |
| `width` e `height` declarados até 2 | −100 | Pixel de rastreamento (soma com o anterior). |

- **Exclusão:** só grupos com pontuação maior ou igual a 0 podem ser selecionados, mesmo sobrando vaga. As regras, nesta ordem:
  1. grupo só de SVG: `unsupported_format`;
  2. pontuação até −40: `icon`;
  3. qualquer outra pontuação negativa (−39 a −1): `low_score`. Por exemplo, imagem só em `<nav>`/`<aside>` (−30), ou logo dentro de `<article>` (+20 − 40 = −20);
  4. sobrou vaga: selecionado;
  5. senão: `limit`.

  Pontuação 0 é a base de um `<img>` comum, sem nenhum sinal, e continua elegível. Sem isso, sites que não usam `<article>`, `<main>`, `<figure>` nem og:image ficariam sem nenhum download. og:image com "logo" no nome (+100 − 40 = 60) continua elegível. Origem da regra: num teste real (Olhar Digital), grupos com pontuação negativa, como um logo com −20, eram baixados porque sobrava vaga.
- **Ordem:** pontuação decrescente, empate pela ordem de coleta. O número do grupo é a posição no ranking. Os `maxSelectedMedia` (8) primeiros grupos elegíveis são selecionados; os demais ficam como `limit`.
- **Defesas:** cada atributo e o nome do arquivo são cortados em 1 KiB antes de procurar palavras, e `width`/`height` em 32 caracteres (até 6 dígitos). Os laços são lineares, sem regex com repetição aninhada. A varredura guarda os bits de ancestrais numa pilha paralela de números, sem objeto por item.

**Limitações (revisar com páginas reais, usando o `score` impresso pelo `try-fetch`):**
- Os pesos foram escolhidos à mão, sem calibração com páginas reais.
- `aria-hidden` e `role="presentation"` podem excluir slides reais de carrossel: sites escondem dos leitores de tela os slides fora da vista.
- Logos e marcas podem ser justamente o objeto da verificação (por exemplo, uma marca falsificada). A exclusão como `icon` ou `low_score` é heurística e revisável; o item continua listado, com o motivo.
- **Limitação conhecida (fora do escopo):** um logo dentro de `<article>` fica com −20 e aparece como `low_score`, não como `icon`, porque o motivo vem só da faixa de pontuação. Ele não é baixado do mesmo jeito; só o rótulo é menos preciso.
- Uma imagem real de conteúdo que só aparece em `<aside>` ou `<nav>` (por exemplo, a foto de uma matéria relacionada) nunca é baixada.
- Se a maior variante passar do limite de 15 MiB, o grupo vira `too_large`. **Melhoria futura (não implementada):** tentar a próxima variante.
- Grupos, pontuação e seleção usam só as referências listadas (até 200). Variantes além da 200ª não entram, e um grupo pode ficar sem a maior variante.
- Imagens de CSS (`background-image`), de `<noscript>` e as carregadas por JavaScript (lazy-load com `data-src`) não são vistas.
- Dimensões só valem quando declaradas no HTML; um ícone sem `width`/`height` e sem palavra-chave passa como imagem comum (rebaixado só se estiver em área de layout).
- Palavras-chave só em inglês e em minúsculas depois da conversão; `siteLogo` ou nomes em português não são reconhecidos.
- SVG só é reconhecido pela extensão ou pelo `type` da `<source>`.

**Calibração encerrada (decisão de 24/10/2026).** Os casos abaixo foram vistos com o `try-fetch` em páginas reais e ficam como estão, sem calibrar mais. Só reabrir se uma página real usada na demonstração der resultado ruim.
- **Empate de pontuação resolvido só pela ordem do documento.** Na Wikipedia, bandeira, brasão, selo e mapa da infobox entraram entre as 8 escolhidas antes das fotos do artigo.
- **Avatar de autor e miniaturas de matérias relacionadas ainda são baixados** (Olhar Digital). O avatar tinha `150x150` só no nome do arquivo, que a heurística não lê como dimensão.
- **A mesma foto servida por dois hosts vira dois grupos.** A união só acontece com a mesma URL.
- **Com descritor `w`, prevalece o maior `w`**, mesmo que exista um `<img src>` sem descritor maior. Na BBC, a variante escolhida foi a de 512w em vez do `src` de 1024.
- **A maior variante é escolhida mesmo quando é pesada.** No G1, foi um GIF de cerca de 9,9 MB.

### Sinal de página montada por JavaScript

`possiblyNeedsJavaScript` é `true` quando, ao mesmo tempo:
- nenhuma mídia foi listada;
- o texto visível do documento tem menos de 500 caracteres (sem contar espaços, nem texto dentro de `script`, `style`, `noscript`, `template`, `title` e `textarea`);
- há pelo menos um `<script>`, **ou** um ponto de montagem vazio: elemento com `id` `root`, `app`, `__next`, `__nuxt` ou `___gatsby` sem elementos filhos.

É heurística, nunca certeza. Falsos positivos: página legítima curta e sem imagens que carrega algum script. Falsos negativos: aplicação de página única que pré-renderiza texto mas monta as imagens por JavaScript, ou página com uma única imagem de interface. **Observado no teste real:** o `try-fetch` mostrou o sinal em `http://example.com/`, uma página mínima. É um falso positivo; a causa não foi investigada e o caso foi aceito pelo baixo impacto (o sinal é apresentado só como possibilidade). A API e a interface devem apresentar o sinal como possibilidade ("a página possivelmente depende de JavaScript; as mídias podem não ter sido vistas"), nunca como fato.

### Extração isolada em worker

A revisão de segurança da Fase 3 mostrou que o parse5, por montar a árvore inteira, tem dois casos patológicos com HTML pequeno: explosão de memória na reconstrução de elementos de formatação (cerca de 73 KB derrubavam o processo por falta de heap) e CPU quadrática com tags de fechamento órfãs (2 MiB passariam de 3 minutos de CPU síncrona, com o event loop parado). Por isso o parse e a extração rodam fora do event loop principal (`extract-pool.ts` e `extract-worker.ts`):

- **Um worker novo por extração**, encerrado com `terminate()` em `finally`: no sucesso, no erro, no prazo e quando quem chamou cancela a requisição. Nenhum estado passa de uma requisição para outra.
- **Entrada e saída:** o worker recebe só o HTML decodificado, a URL base e quatro limites numéricos (`maxMediaRefs`, `maxUrlLength`, `maxHtmlNodes` e `maxSelectedMedia`), e devolve dados simples (título, manchete, referências com grupo e seleção, e o sinal de JavaScript). Roda com `execArgv: []` e `env: {}`.
- **O código do worker não importa módulos de rede, disco ou processo.** Um teste percorre o grafo de imports, incluindo parse5 e entities, e exige que o único módulo nativo seja `node:worker_threads`.
- **O worker NÃO é uma sandbox.** Ele tem `fetch`, `process` e `import()` dinâmico como globais; um teste confirma isso. Uma falha explorável no parser, rodando no worker, poderia usar esses globais para fazer requisições, ler o ambiente do processo ou carregar módulos. **O isolamento é de memória e de CPU** (heap limitado, prazo, `terminate()` e a validação da mensagem no processo principal), não de capacidades. A defesa contra o que o worker poderia alcançar continua sendo a da instância: conta de serviço sem papéis IAM, nenhum segredo no ambiente e o IAM do Cloud Run.
- **Limites:** `resourceLimits` com 128 MiB de old generation e 32 MiB de young. O estouro chega como `ERR_WORKER_OUT_OF_MEMORY` e vira `too_large`; o prazo de 2,5 s (ou o cancelamento) vira `timeout`; qualquer outra falha vira `network`.
- **Saída validada no processo principal** (`worker-message.ts`): a mensagem do worker é tratada como não confiável. Só passa um objeto com exatamente `title`, `headline`, `media` e `possiblyNeedsJavaScript`. `title` e `headline` precisam ser `null` ou texto bem formado (sem surrogate solto) de até 300 caracteres; o `extract.ts` aplica `toWellFormed()` depois do corte. `possiblyNeedsJavaScript` precisa ser booleano, e só pode ser `true` com `media` vazio. `media` precisa ser um array de até `maxMediaRefs` itens, cada um com exatamente `url`, `kind`, `source`, `group`, `score`, `selected` e `skipReason`:
  - `group` inteiro de 1 ao número de itens; `score` inteiro de −1000 a 1000;
  - `selected` booleano; `skipReason` é `null` exatamente quando `selected` é `true`, e senão um dos motivos conhecidos;
  - cada grupo tem exatamente um item que não é `variant`, e todos os itens do grupo têm o mesmo `kind` e o mesmo `score`;
  - no máximo `maxSelectedMedia` itens selecionados. A `url` precisa ser http ou https, ter até `maxUrlLength` e vir **na forma normalizada** (`new URL(url).href === url`), que é o que o worker legítimo sempre envia. Espaços, quebras de linha, maiúsculas ou porta padrão explícita são recusados, não corrigidos. `kind` e `source` precisam ser dos valores conhecidos. Qualquer desvio vira `network`. Userinfo e porta não padrão na forma normalizada passam, porque podem vir de uma página real; o download dessas URLs é bloqueado (`blocked`) sem abrir conexão. A validação não carrega o parse5: os tipos e valores aceitos ficam em `media.ts`.
- **Concorrência:** no máximo 2 workers por instância, com fila de até 4; fila cheia vira 503. O prazo conta a partir da vaga; a espera na fila é limitada pelo prazo da página (30 s). Com o teto de 2 requisições em andamento, a fila não chega a encher; ela é defesa em profundidade.
- **Inicialização:** `main.ts` faz uma extração mínima antes de escutar a porta. Se o arquivo do worker não estiver na imagem, o processo sai com erro em vez de falhar em toda requisição. Um teste sobe `node src/main.ts` (o mesmo comando do Dockerfile) e outro confere que o `.dockerignore` não remove nenhum módulo de produção.

**Medições que definiram o prazo** (máquina de desenvolvimento com Windows, Node 24.22.1; página legítima sintética de 2,1 MiB com CSS e script inline e 200 referências, gerada por `legitNewsPage` em `testing.ts`):

| Cenário | Extração (inclui subir o worker) |
| --- | --- |
| 12 núcleos | cerca de 190 a 290 ms |
| Processo preso a 1 núcleo (`start /affinity 1`) | 370 a 420 ms |
| 1 núcleo, duas extrações em paralelo | cerca de 750 ms no total |

O prazo de 2,5 s dá cerca de 3 vezes o pior caso medido, com margem para uma vCPU do Cloud Run mais lenta que o núcleo de desenvolvimento. Ele não é maior porque **workers presos em CPU competem com o processo principal em instâncias de 1 vCPU**: com o processo preso a 1 núcleo, durante o ataque de CPU quadrática, o atraso de um timer do event loop principal chegou a cerca de 0,7 s e `/healthz` levou cerca de 0,7 s (com 12 núcleos, cerca de 15 ms). Um prazo maior prolongaria essa degradação para todas as requisições da instância. O teste `extract-pool.test.ts` imprime o tempo medido a cada execução.

**Melhoria possível: extração em nível de token.** O parse5 exporta `Tokenizer`, então daria para coletar as tags de interesse direto do fluxo de tokens, sem montar árvore.
- Prós: custo linear no tamanho da entrada, por construção; elimina a causa raiz dos dois casos patológicos, em vez de conter o efeito; não precisa de worker (menos memória por instância e sem o custo de subir uma thread).
- Contras: é preciso reimplementar à mão parte do que a árvore dá de graça (troca de estado do tokenizador para RCDATA, RAWTEXT, script e plaintext; profundidade de `picture`, `video` e `template`; `noscript`; o texto do `<title>` e do primeiro `<h1>`), com risco de divergir do que o navegador vê em HTML malformado; o comportamento já testado em `extract.test.ts` precisa ser mantido; a manutenção fica maior. Mesmo com essa mudança, o worker continuaria valendo como defesa em profundidade contra patologias futuras.

### Orçamento de memória por instância

| Parcela | Tamanho | Origem |
| --- | --- | --- |
| Processo principal em repouso | cerca de 90 MiB | medido (RSS com o grafo de módulos de `main.ts`) |
| Workers de extração | até cerca de 2 × 150 MiB | medido: um worker no limite somou 152 MiB de RSS; dois em paralelo, 290 MiB |
| HTML de cada requisição | cerca de 6 MiB | estimado: 2 MiB de bytes mais a string decodificada (até 2 bytes por caractere) |
| Mídias de cada requisição | até 60 MiB | teto agregado |
| Serialização de cada requisição | até cerca de 60 MiB, temporário | estimado: para uma mídia de 15 MiB, a string base64 (20 MiB), a linha JSON (20 MiB) e o buffer de escrita (20 MiB) |

Pior caso: 90 + 300 + R × 126 MiB, em que R é o número de requisições em andamento. O fetcher limita R a 2 (`maxInFlightFetches`), qualquer que seja o `--concurrency` do Cloud Run: cerca de 650 MiB, o que cabe em 1 GiB com folga para GC e buffers nativos. Com R = 4, seriam cerca de 900 MiB, o que não caberia com segurança em 1 GiB. **Recomendação: 1 GiB e `--concurrency 2`.** Para aceitar mais requisições por instância, é preciso subir juntos `maxInFlightFetches` no código e a memória para 2 GiB. As parcelas estimadas ainda precisam ser confirmadas no Cloud Run.

## Requisitos para a API (quem chama o fetcher)

Achados 5 e 8 da primeira revisão de segurança da Fase 3, e o 503 da segunda. A API precisa cumprir isto quando passar a chamar o fetcher.

**Situação depois da Fase 4** (4a a 4c; detalhes em `docs/api.md`):

| Requisito | Situação |
| --- | --- |
| 1 | Atendido: `api/src/messages.ts` |
| 2 | Atendido só por conta: `api/src/rate-limit.ts`. O limite por IP fica pendente (ver o item 2) |
| 3 | Atendido: `api/src/fetcher-client.ts` |
| 4 | Atendido: `api/src/fetcher-client.ts`, com prazo de 40 s e tetos por linha e total |
| 5 | Atendido: `api/src/messages.ts` |
| 6 | Atendido na API: o relatório traz `selected`, `skipReason`, os avisos e, para cada mídia baixada, os sinais de metadados. Atendido na interface (`web/public/report-*.js`) |

1. **Uma única mensagem ao usuário para `blocked` e para falha de resolução de nome.** Hoje um nome que existe e resolve para IP privado devolve `blocked`, e um nome inexistente devolve `network`. Se a API repassar essa diferença, o usuário consegue enumerar nomes internos (por exemplo, zonas privadas do Cloud DNS, se um dia houver VPC). A API deve mostrar o mesmo texto genérico para `blocked` e para `network`, tanto no erro da página quanto em `media_error`. A categoria exata pode ir para métricas internas, nunca para a tela nem para a resposta da API. Pelo mesmo motivo, um DNS que não responde pode chegar como `network` ou como `timeout`, conforme o número de servidores DNS e a plataforma ("Resolução de DNS"). A API deve tratar as duas categorias da mesma forma na mensagem ao usuário, sem que a diferença entre elas apareça na tela.
2. **Limite de taxa por usuário e por IP**, antes de chamar o fetcher. Uma única chamada a `/fetch` pode gerar até 54 requisições de saída, ou seja, 1 página + 8 mídias selecionadas, cada uma com até 5 redirecionamentos ((1 + 8) × 6). Ela também pode baixar cerca de 62 MiB (2 MiB de HTML + 60 MiB de mídia) de um alvo escolhido pelo usuário. Sem limite, a plataforma vira amplificador contra terceiros. O limite precisa valer por conta Google (o `sub` do ID token) e por IP de origem, para que várias contas no mesmo IP, ou um IP com várias contas, não escapem.

   **Decisão da Fase 4:**
   - **Por conta, implementado:** 10 verificações por hora no plano gratuito, contador em memória por instância e no máximo 2 instâncias da API (`docs/api.md`).
   - **Por IP, pendente.** Dois motivos:
     - atrás do Firebase Hosting, o IP do cliente só chega pelo `X-Forwarded-For`, e as entradas à esquerda desse cabeçalho são forjáveis pelo próprio cliente. Uma regra confiável exige confirmar qual entrada o Hosting e o Cloud Run acrescentam;
     - guardar IP, mesmo em hash e só em memória, é tratamento de dado pessoal que precisa constar da política de privacidade.

     Enquanto o limite por IP não existir, contas descartáveis continuam sendo o vetor de abuso. As mitigações previstas em `docs/arquitetura.md` (captcha, cota e alerta de orçamento) seguem pendentes.
3. **Tratar `503` com `Retry-After`.** O fetcher responde `503 {"error":"Serviço ocupado"}` com `Retry-After: 1` quando a instância já tem 2 requisições em andamento ou a fila do worker está cheia. A API deve:
   - tentar de novo poucas vezes (por exemplo, até 2), com espera curta que respeite o `Retry-After` e um limite total que caiba no prazo da requisição do usuário;
   - esgotadas as tentativas, mostrar ao usuário uma mensagem clara, por exemplo "O serviço está ocupado. Tente de novo em alguns instantes.", sem repassar status, cabeçalhos ou qualquer detalhe interno do fetcher.
4. **Consumir o stream do fetcher com prazo próprio, em memória, sem amarrar a leitura ao ritmo do usuário final** (achado 1 da terceira revisão). Cada resposta do fetcher segura uma das 2 vagas da instância até terminar. Se a API repassasse o NDJSON ao navegador respeitando backpressure, quem controlaria o ritmo seria o usuário: duas abas pausadas deixariam a instância em 503. A API deve:
   - ler o NDJSON inteiro do fetcher para a memória o mais rápido que puder, com um prazo total menor que o `streamTotalMs` do fetcher (60 s);
   - processar e enviar o relatório ao usuário a partir da própria memória, desacoplado da leitura do fetcher;
   - descartar tudo no `finally` da requisição, como o resto da plataforma (stateless).

   O fetcher corta quem não lê por 10 s ou passa de 60 s, mas isso é a última linha de defesa, não o ritmo normal.
5. **`httpStatus` em `upstream_status`.** A API pode mostrar o código ao usuário (por exemplo, "o site respondeu 403") só quando a categoria for `upstream_status`, e só depois de conferir que é inteiro de 100 a 599. As regras do item 1 não mudam: `blocked`, `network` e `timeout` continuam sem detalhe.
6. **Seleção e sinais no relatório.** O relatório deve mostrar o que foi analisado e o que foi ignorado, com o motivo em linguagem simples (variante da mesma imagem, ícone ou elemento de interface, formato não analisável, limite de mídias). Deve deixar claro que a escolha é automática e heurística, e que uma mídia ignorada (inclusive um logo) pode ser relevante. `possiblyNeedsJavaScript` é apresentado como possibilidade, nunca como fato. O `score` é para calibração interna; não precisa ir para a tela.

## Decisões abertas (sem implementação nesta fase)

- **Mídia dentro de `<noscript>`:** sites com lazy-load colocam a imagem real ali. Extrair exigiria parsear o conteúdo do noscript como fragmento.
- **Variante seguinte quando a maior passa do limite:** hoje o grupo vira `too_large`. Ver "Seleção de mídias (heurística)".

## Dívida técnica

- `extractBearerToken`, a verificação de ID token (`auth.ts`) e os auxiliares de teste (`testing.ts`) estão duplicados entre `api/src` e `fetcher/src`. A candidata é um workspace compartilhado (por exemplo `shared/`) numa fase futura.
- `shutdown()` também está duplicado entre `api/src/server.ts` e `fetcher/src/server.ts`.
- `domainHash()` (`api/src/http.ts` e `fetcher/src/server.ts`) e os valores do contrato NDJSON (`api/src/fetcher-contract.ts`, copiados de `fetcher/src/media.ts`, `errors.ts` e `safe-fetch.ts`) também estão duplicados. Uma mudança no contrato precisa ser feita nos dois lados.

## O que não foi testado contra a internet real

Todos os testes usam DNS e transporte simulados, ou um servidor HTTP local em 127.0.0.1. Ainda não foram verificados:
- Sites reais: variedade de HTML, charset sem cabeçalho, lazy-load, imagens servidas por JavaScript.
- Seleção de mídias e sinal de JavaScript: só foram testados com fixtures escritas à mão que imitam a estrutura de páginas reais (srcset, `<picture>`, ícones no cabeçalho, casca de SPA). Os pesos e os limiares ainda não foram calibrados com páginas reais.
- Sites e CDNs que bloqueiam o User-Agent próprio, exigem cookies ou aplicam desafio anti-bot (Cloudflare e afins).
- Redes sociais (Instagram, X, Facebook, TikTok), que costumam exigir login ou JavaScript.
- HTTPS de ponta a ponta: SNI e verificação de certificado usam o hostname, mas não há teste com certificado TLS real.
- IPv6 real (só a política foi testada).
- DNS real: o c-ares (`resolve4`/`resolve6`, timeout, tentativas e prazo por salto) só foi testado com cliente falso e contra um servidor DNS local em 127.0.0.1; ver "Resolução de DNS".
- Comportamento no Cloud Run: streaming NDJSON grande, memória por instância, ID token real da conta de serviço e alcance do servidor de metadados.
- Workers de extração em 1 vCPU real: a disputa de CPU só foi simulada prendendo o processo a um núcleo no Windows.
- Imagem Docker: não foi construída na máquina de desenvolvimento (sem Docker). O `.dockerignore` e o comando de produção têm teste, mas a imagem só é construída no CI.
