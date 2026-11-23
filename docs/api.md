# API

Serviço Node.js no Cloud Run, atrás do Firebase Hosting (`/api/**`). Valida o login, aplica o limite do plano, chama o fetcher e devolve o relatório. É stateless: nada vai para disco ou banco, e os bytes das mídias só existem na memória durante a requisição.

Fase 4 (4a, 4b e 4c): `POST /api/check` devolve a página, as mídias e, para cada mídia baixada, os sinais de metadados extraídos pela ExifTools (lista permitida). Fase 5a: também as marcações ClaimReview que a página declara. Fase 5b: também as checagens que terceiros publicaram sobre afirmações parecidas com a manchete (Google Fact Check Tools). Nunca há veredito de verdadeiro ou falso. A resposta é um único JSON no fim; o envio por SSE fica para depois.

## Rotas

| Rota | Método | Autenticação | Resposta |
| --- | --- | --- | --- |
| `/healthz` | GET | nenhuma | `200 {"status":"ok"}` |
| `/api/me` | GET | ID token do usuário | `200 {"email":"..."}` |
| `/api/check` | POST | ID token do usuário | relatório JSON (abaixo) |

O ID token do Google vai em `Authorization: Bearer`. O verificador confere assinatura, `aud`, `iss`, `exp`, `email_verified` e exige `email` e `sub` (`api/src/auth.ts`). Qualquer falha devolve `401 {"error":"Não autorizado"}` com `WWW-Authenticate: Bearer`.

## `POST /api/check`

Corpo: `Content-Type: application/json` e exatamente `{"url":"https://..."}`, com 1 a 2048 caracteres, até 4 KiB. A URL vai no corpo, nunca na query string.

**Normalização do link na interface** (`web/public/check-form.js`, `validateLink`). Antes de enviar, a interface faz duas coisas:
- **Remove os parâmetros de rastreio** `utm_*`, `fbclid`, `gclid`, `igshid` e `mc_eid`, sem diferenciar maiúsculas, e mostra o aviso "Removemos parâmetros de rastreio do link antes de enviar." junto ao formulário.
  - Só o nome do parâmetro conta: um valor que contém um desses nomes fica.
  - Os demais parâmetros seguem exatamente como foram colados, sem recodificar (`%20`, `+` e a ordem não mudam). Se só havia rastreio, o `?` também sai.
  - O nome é comparado como está no texto, sem decodificar. Um nome codificado (por exemplo `utm%5Fsource`) não é removido, e o link segue como foi colado.
- **Descarta o fragmento** (`#...`), sem aviso. O servidor já o descartava (`fetcher/src/url-policy.ts`), então isso não muda o que é analisado.

Um link com usuário e senha é recusado ainda no navegador. Um texto que o navegador não consegue interpretar como URL segue sem alteração, e quem valida de verdade é o servidor.

Ordem de processamento (`api/src/check.ts`):
1. autentica;
2. confere o teto de checagens em andamento na instância (4);
3. lê e valida o corpo (um corpo inválido não gasta cota);
4. consome o limite do plano;
5. chama o fetcher;
6. assim que a linha `page` chega, busca checagens publicadas pela manchete, em paralelo (ver "Fact Check Tools");
7. manda cada mídia baixada à ExifTools (ver "Sinais por mídia").

### Resposta 200

```json
{
  "page": { "finalUrl": "...", "title": "...", "headline": "...", "possiblyNeedsJavaScript": false,
    "claimReviews": [{ "claimReviewed": "...", "ratingLabel": "...", "ratingValue": 1, "bestRating": 5, "worstRating": 1,
      "url": "https://...", "authorName": "...", "datePublished": "..." }] },
  "media": [
    { "url": "...", "kind": "image", "source": "og:image", "group": 1, "score": 100, "selected": true, "skipReason": null,
      "download": { "status": "ok", "contentType": "image/jpeg", "size": 12345, "sha256": "<hex>" },
      "metadata": { "status": "ok", "signals": { "fileType": "JPEG", "mimeType": "image/jpeg", "width": 8192, "height": 5464,
        "sha256": "<hex>", "dates": [{ "tag": "EXIF:DateTimeOriginal", "value": "2026:03:15 10:30:00" }],
        "camera": { "make": "Canon", "model": "Canon EOS R5" }, "software": [], "containsLocation": false,
        "containsAuthorship": false, "c2pa": null } } },
    { "url": "...", "kind": "image", "source": "img", "group": 2, "score": 20, "selected": true, "skipReason": null,
      "download": { "status": "error", "error": "unreachable", "message": "Não foi possível acessar este endereço." },
      "metadata": null },
    { "url": "...", "kind": "image", "source": "img", "group": 3, "score": -70, "selected": false, "skipReason": "icon",
      "download": null, "metadata": null }
  ],
  "notices": [
    "A seleção de mídias é automática e heurística; ...",
    "A revogação de certificados C2PA não é verificada online.",
    "Um signatário confiável indica quem gerou o arquivo, não que o conteúdo seja verdadeiro."
  ],
  "factCheck": { "status": "ok", "query": "<manchete enviada>",
    "claims": [{ "text": "...", "claimant": "...", "claimDate": "2014-10-02T15:01:23Z",
      "reviews": [{ "publisherName": "...", "publisherSite": "...", "url": "https://...", "title": "...",
        "reviewDate": "2014-10-02T15:01:23Z", "textualRating": "...", "languageCode": "en" }] }] }
}
```

- `media` traz todas as referências que o fetcher listou (até 200), com `group`, `score`, `selected` e `skipReason` como o fetcher entrega (`docs/fetcher.md`). `download` é `null` para as não selecionadas.
- São **uma referência por variante** (cada tamanho de um `srcset` é uma linha). A interface (`web/public/report-model.js`) agrupa por `group` e mostra uma linha por imagem.
- Os bytes das mídias nunca vão na resposta.
- `title`, `headline` e as URLs vêm de terceiros. Quem exibir esse texto precisa escapá-lo.
- `metadata` é `null` para as mídias não selecionadas e para as que falharam no download. Para as baixadas, ver "Sinais por mídia".
- `notices` sempre traz o aviso de seleção heurística e os dois avisos fixos de C2PA. Quando `possiblyNeedsJavaScript` é verdadeiro, traz também o aviso de que a página possivelmente depende de JavaScript. O sinal é uma possibilidade, nunca um fato.
- `page.claimReviews` traz as marcações ClaimReview que a própria página declarou, como o fetcher entregou (até 5; lista vazia quando não há). Ver "Marcação ClaimReview".
- `factCheck` (Fase 5b, campo aditivo) traz o resultado da busca no Google Fact Check Tools. Ver "Fact Check Tools".

### Marcação ClaimReview

Fase 5a. O fetcher lê o JSON-LD da página (`docs/fetcher.md`, "ClaimReview") e a API repassa as marcações em `page.claimReviews`, sem mudar nada.

| Campo | Origem na marcação | Formato |
| --- | --- | --- |
| `claimReviewed` | `claimReviewed` | texto, até 300 |
| `ratingLabel` | `reviewRating.alternateName`, ou `reviewRating.name` na falta dele | texto, até 300 |
| `ratingValue`, `bestRating`, `worstRating` | os de `reviewRating` | número finito; texto numérico simples (`"1"`, `" 4 "`) vira número; senão `null` (regra exata em `docs/fetcher.md`, "ClaimReview") |
| `url` | `url` | resolvida contra a base da página (a mesma das mídias); http(s), sem usuário e senha, normalizada; senão `null`. **Nunca é buscada** |
| `authorName` | `author` (texto, `author.name` ou o primeiro nome de uma lista) | texto, até 300 |
| `datePublished` | `datePublished` da raiz (data da checagem) | texto, até 64 |

- **Linguagem:** é o que a página declarou, nunca conclusão do Aletheia. A interface mostra a seção só quando há marcação, com o aviso fixo "A página se apresenta como uma checagem. Isso não indica que a checagem esteja correta.", a fonte (domínio e endereço da página) e o rótulo entre aspas. A seção fica fora do resumo de sinais. A ausência da marcação não diz nada e não é exibida.
- **Não sai:** `itemReviewed` (autor, data e aparições da afirmação), `publisher` (que a página oficial não lista em ClaimReview), `author.url`, `sameAs`, imagens e qualquer outro campo.
- **Logs:** nada da marcação vai para o log nem para `notices`.
- **Contrato:** `claimReviews` é **obrigatório** na linha `page` do fetcher, como lista (vazia quando a página não declara marcação). Uma linha `page` sem o campo é resposta malformada, e a API devolve o 502 genérico. Um fetcher anterior à Fase 5a não é mais compatível.
  - Histórico: o deploy de 22/11/2026 usou uma transição temporária, em que a API aceitava a linha com ou sem o campo. Por isso a ordem foi API primeiro, fetcher depois (`docs/deploy.md`, "Atualização de 22/11/2026").

### Sinais por mídia

`api/src/analyze.ts`. Cada mídia baixada vai à ExifTools, e cada uma tem o próprio `metadata.status`: a falha de uma mídia não derruba a checagem nem as outras mídias.

| `metadata.status` | Quando | `message` |
| --- | --- | --- |
| `ok` | a ExifTools respondeu; vem com `signals` (lista permitida, ver "ExifTools") | — |
| `unavailable` | 429, 5xx, timeout, erro de rede, prazo total esgotado, ou chave inválida (erro nosso, só no log) | Análise de metadados indisponível no momento. |
| `unsupported` | 415 | Formato não suportado pela análise de metadados. |
| `too_large` | 413 | Arquivo grande demais para a análise de metadados. |
| `error` | 400, outros 4xx, resposta fora do formato | Não foi possível analisar os metadados deste arquivo. |
| `not_analyzed` | passou de `maxMediaPerCheck` do plano (8) | Fora do limite de mídias analisadas por verificação. |

- **No máximo 2 chamadas simultâneas** à ExifTools por checagem, em fila.
- **Chave inválida (401/403):** as chamadas que ainda não começaram são puladas, para não insistir com uma chave recusada. O usuário vê "indisponível"; o log registra `config_error`.
- **Prazo total de 50 s** por checagem, contado desde a chegada da requisição, porque o Firebase Hosting corta em 60 s. O fetcher tem prazo próprio de 40 s, e a ExifTools fica com o que sobrar. Esgotado o prazo, as mídias pendentes ficam `unavailable` e a resposta sai assim mesmo.
- **Cancelamento:** se o usuário fecha a conexão, as chamadas à ExifTools são canceladas.
- **Memória:** os bytes das mídias só existem na memória da requisição. Eles vão para a ExifTools e são soltos ao fim da resposta. Nunca vão para disco, log ou resposta.

### Erros e mensagens

As mensagens são unificadas para não vazar detalhe interno (`api/src/messages.ts`). A categoria exata do fetcher vai só para o log.

| Situação | HTTP | `error` | `message` |
| --- | --- | --- | --- |
| `blocked`, `network` ou `timeout` do fetcher (página ou mídia) | 422 | `unreachable` | Não foi possível acessar este endereço. |
| `invalid_url` | 422 | `invalid_url` | Endereço inválido. |
| `upstream_status` | 422 | `upstream_status` e `httpStatus` | O site respondeu com erro (HTTP 403). |
| `too_large` | 422 | `too_large` | O conteúdo é grande demais para ser analisado. |
| `unsupported_type` | 422 | `unsupported_type` | Tipo de conteúdo não suportado. |
| `too_many_redirects` | 422 | `too_many_redirects` | O endereço redirecionou vezes demais. |
| Fetcher ocupado depois das novas tentativas, ou API no teto | 503, `Retry-After: 5` | `busy` | Serviço ocupado, tente novamente em instantes. |
| Limite do plano estourado | 429, `Retry-After` | `rate_limited` | Você atingiu o limite de 10 verificações por hora. Tente novamente em N minutos. |
| Fetcher respondeu 401, erro inesperado ou resposta fora do contrato; falha ao obter o token de serviço | 502 | `internal` | Não foi possível concluir a análise. Tente novamente. |
| Prazo da fase do fetcher esgotado | 504 | `timeout` | A análise demorou demais. Tente novamente. |
| JSON inválido, campo extra, `url` ausente, vazia, longa ou que não é texto | 400 | `bad_request` | Requisição inválida. |
| Corpo acima de 4 KiB | 413 | `body_too_large` | Requisição grande demais. |
| Content-Type diferente de JSON | 415 | `bad_content_type` | Envie o corpo como application/json. |

Por que `blocked`, `network` e `timeout` têm a mesma mensagem: um nome que resolve para IP interno chega como `blocked`, um nome inexistente como `network`, e um DNS que não responde como `network` ou `timeout`, conforme a plataforma. Se qualquer uma dessas diferenças chegasse ao usuário, ele poderia enumerar nomes internos (requisito 1 de `docs/fetcher.md`). O `httpStatus` só aparece com `upstream_status`, e só se for inteiro de 100 a 599.

O 504 vale para qualquer prazo esgotado antes da linha `done`, inclusive quando a linha `page` já chegou: sem o fim do stream, a API não sabe se a lista de downloads está completa.

## Chamada ao fetcher

`api/src/fetcher-client.ts` e `api/src/fetcher-contract.ts`. O endereço vem de `FETCHER_URL` (serviço nosso), nunca do usuário; a URL do usuário vai só no corpo de `POST /fetch`.

- **Autenticação:** ID token da conta de serviço da API, com `aud` = `FETCHER_AUDIENCE`, obtido pelo `GoogleAuth` (`api/src/service-token.ts`). No Cloud Run vem do servidor de metadados. Não existe flag nem variável que pule a autenticação; para desenvolvimento local, ver `docs/desenvolvimento-local.md`.
- **Prazo total de 40 s** para a fase do fetcher, com novas tentativas e leitura do stream. O fetcher gasta até 30 s com a página e as mídias e só então transmite.
- **503:** até 2 novas tentativas. A espera é o `Retry-After` (inteiro de 0 a 5; senão, 1 s), com teto de 2 s, e só se ainda sobrarem 5 s do prazo depois da espera. Esgotadas as tentativas, o usuário recebe 503 e a vaga do limite é devolvida, porque nada foi buscado no alvo.
- **Leitura em memória, o mais rápido possível**, desacoplada do ritmo do usuário (requisito 4 de `docs/fetcher.md`). Cada linha tem teto de 21 MiB (uma mídia de 15 MiB em base64 mais o JSON), e a resposta inteira, de 85 MiB.
- **Validação estrita do contrato:**
  - Content-Type `application/x-ndjson`;
  - uma linha `page`, um resultado por mídia selecionada, sem repetir, e `done`;
  - campos com os tipos e valores conhecidos;
  - `claimReviews` com até 5 marcações, chaves exatas, textos bem formados dentro do teto, números finitos e `url` http(s) normalizada sem usuário e senha (obrigatório, ver "Marcação ClaimReview");
  - content-type da mídia na lista do fetcher;
  - o base64 é decodificado linha a linha, e o tamanho e o SHA-256 são conferidos.

  Qualquer desvio vira 502 genérico.
- **Corpo de erro do fetcher:** nunca é repassado. Do 422 só se aproveitam a categoria conhecida e o `httpStatus` válido.
- **Cancelamento:** se o usuário fecha a conexão, a chamada ao fetcher é abortada.
- **Primeira chamada de cada processo:** localmente, levou cerca de 15 s (as seguintes, cerca de 150 ms), inclusive quando falhou. A causa provável é a primeira obtenção do token por impersonação; não foi investigada. Esse atraso conta dentro do prazo de 50 s e do corte de 60 s do Hosting. **A avaliar no primeiro deploy:** se o Cloud Run mostrar atraso na primeira chamada de uma instância nova, obter o token de serviço uma vez na inicialização, antes de aceitar tráfego.

## ExifTools

`api/src/exiftools-client.ts` e `api/src/metadata-allowlist.ts`. Documentação do serviço: `docs/apis/documentacao-exif.md`.

### Cliente

- **Só o arquivo.** A API envia os bytes já baixados pelo fetcher, em multipart, num único campo `file`, com nome genérico derivado do content-type (`media.jpg`, `media.mov`, `media.bin`…), nunca o nome original. Nunca usa os modos `url` nem `data_url`: a ExifTools não pode buscar nada por conta própria, porque isso contornaria o fetcher e vazaria a URL do usuário. A função do cliente nem recebe URL.
- **Endereço fixo:** `https://exiftools.com/api/v1/extract`, sem variável de ambiente para trocar o destino. Os testes passam o endereço do servidor falso pelas opções do cliente.
- **Chave só no cabeçalho `X-API-Key`**, nunca em `?key=`. Ela vem de `EXIFTOOLS_API_KEY` (obrigatória: sem ela a API não sobe) e nunca aparece em log, resultado ou mensagem de erro.
- **Redirecionamento:** não é seguido (`redirect: "manual"`), porque o cabeçalho com a chave iria junto para outro host. Um redirecionamento vira `invalid`.
- **Prazo:** 15 s por chamada, limitado pelo prazo total da checagem.
- **Resposta:** até 2 MiB. Um `Content-Length` maior é recusado sem ler o corpo, e a leitura em fluxo para no primeiro pedaço que passa do limite.
- **Nunca lança:** toda falha vira um status, e o erro original é descartado.

| Resposta da ExifTools | Status no resultado | Nova tentativa |
| --- | --- | --- |
| 200 com `success: true` | `ok` | não |
| 200 com outro corpo, JSON inválido ou acima de 2 MiB | `invalid` | não |
| 400, outros 4xx, redirecionamento | `invalid` | não |
| 401, 403 | `config_error` (chave inválida: erro nosso, vai para o log interno; o usuário vê "indisponível") | não |
| 413 | `too_large` | não |
| 415 | `unsupported` | não |
| 429, 5xx, timeout, erro de rede | `unavailable` | no máximo uma, depois do `Retry-After` (teto de 2 s; sem cabeçalho válido, 1 s), e só se sobrarem 5 s do prazo depois da espera |
| `EXIFTOOLS_API_KEY` vazia | `config_error`, sem requisição | não |

**Códigos não documentados:** a documentação da ExifTools só lista 400, 401 e 500 para `/extract`. 413 e 415 aparecem só em `/remove`, e 429 não aparece em lugar nenhum. O cliente trata todos de forma defensiva; o comportamento real precisa ser confirmado.

### Lista permitida de sinais

Nada da resposta da ExifTools é repassado em bloco. Cada campo é escolhido, com tipo conferido. Um campo com tipo inesperado vira `null` (ou lista vazia) e não derruba os outros. O texto passa por uma limpeza:
- sem controles (C0, DEL, C1) nem caracteres de formato Unicode, como o U+202E;
- cortado em 256 caracteres (64 nos campos curtos);
- bem formado.

HTML continua sendo texto: quem exibe escapa.

**Limitação conhecida da limpeza** (aqui e em `web/public/sanitize.js`): remover `\p{Cf}` também tira o ZWJ (emojis compostos) e o ZWNJ (persa e alguns scripts indianos). Decisão aceita: segurança antes de fidelidade em texto de terceiros.

| Sinal | Origem |
| --- | --- |
| `fileType`, `mimeType` | `metadata.File.FileType`; `mimeType` (ou `metadata.File.MIMEType`) |
| `width`, `height` | Sempre da mesma fonte, nesta ordem: `metadata.Composite.ImageSize`; o campo de nível superior `dimensions`; em último caso, `metadata.File.ImageWidth`/`ImageHeight` (nomes do exemplo da documentação, que a resposta real não traz). O texto só é aceito no formato `"640x480"` (também `"640 x 480"` e `"640×480"`). Cada valor precisa ser inteiro de 1 a 100000; qualquer outra coisa vira `null` |
| `sha256` | o calculado pelo fetcher e conferido pela API (não o da ExifTools) |
| `dates[]` `{tag, value}` | `EXIF:DateTimeOriginal`, `EXIF:CreateDate`, `EXIF:ModifyDate`, `XMP:CreateDate`, `XMP:ModifyDate`, `XMP:MetadataDate`. As datas do sistema de arquivos do servidor da ExifTools (`File.FileModifyDate`…) ficam de fora |
| `camera` `{make, model}` | `EXIF.Make`, `EXIF.Model` |
| `software[]` | `EXIF.Software`, `EXIF.ProcessingSoftware`, `XMP.CreatorTool`, `XMP.HistorySoftwareAgent`, sem repetição, até 10 |
| `containsLocation` | `true` se houver alguma destas fontes:<br>• `GPS.GPSLatitude`/`GPSLongitude`, `EXIF.GPSLatitude`/`GPSLongitude`, `Composite.GPSPosition`/`GPSLatitude`/`GPSLongitude` ou `XMP.GPSLatitude`/`GPSLongitude`, com valor presente;<br>• `address` ou `addressPlusCode` de nível superior, com texto não vazio;<br>• `latitude` ou `gpsCoordinates.lat` de nível superior, com número de −90 a 90;<br>• `longitude` ou `gpsCoordinates.lng` de nível superior, com número de −180 a 180.<br>**Nunca as coordenadas nem o endereço** |
| `containsAuthorship` | `true` se houver `author`, `IPTC.By-line`, `IPTC.CopyrightNotice`, `EXIF.Artist`, `EXIF.Copyright`, `XMP.Creator`, `XMP.Rights` ou `contentCredentials.creator`. **Nunca o nome nem o aviso de copyright** |
| `c2pa` (ou `null`) | de `contentCredentials`: `state`, `reason`, `signer`, `certificateName`, `trustList`, `signedAt`, `timestamped`, `generator`, `aiGenerated`, `digitalSourceTypes` (até 10), `actions` (até 20, só `action`, `softwareAgent` e `digitalSourceType`), `checks` (até 50, só `code` e `outcome`), `ingredientCount` e `remoteHost` |

**Nunca saem:**
- o endereço e as coordenadas que a resposta real traz no nível superior: `address` e `addressPlusCode` (derivados do GPS pela ExifTools), `gpsCoordinates`, `latitude` e `longitude`. A API descarta todos; eles só servem para decidir `containsLocation`;
- identificadores e metadados da própria ExifTools: `uuid`, `fileName`, `processedAt`;
- o `manifestUrl` do bloco C2PA, que é um link com o UUID do resultado guardado na ExifTools;
- outros campos do bloco C2PA: `creator`, `title`, `aiTraining`, `algorithm`, `checkedAt` e o conteúdo de `ingredients` (a árvore não é documentada, então só a contagem);
- coordenadas e qualquer outra tag GPS;
- números de série (`SerialNumber`, `BodySerialNumber`, `InternalSerialNumber`);
- `MakerNotes`, `ICC_Profile`, o IPTC inteiro;
- `author`, `cameraModel` e `dimensions` de nível superior;
- qualquer grupo ou campo não listado acima.

**Teste real da ExifTools (24/10/2026).** Feito com o `try-exiftools` (`docs/desenvolvimento-local.md`).

Confirmado com um JPEG sintético de metadados conhecidos:
- **nomes de tags que batem com a lista permitida:**
  - EXIF: `Make`, `Model`, `Software`, `Artist`, `Copyright`, `CreateDate`, `DateTimeOriginal`, `ModifyDate`, `GPSLatitude`/`GPSLongitude`;
  - XMP: `CreateDate`, `CreatorTool`, `ModifyDate`;
  - Composite: `GPSLatitude`/`GPSLongitude`, `ImageSize`;
  - grupo GPS.
- **dimensões:** vêm de `Composite.ImageSize` e de `dimensions`, não de `File.ImageWidth`/`ImageHeight`. Depois da correção, o `try-exiftools` devolveu `width` 640 e `height` 480, e o resto idêntico;
- **arquivos sem EXIF:** um PNG e JPEGs sem EXIF devolvem os grupos `File`, `JFIF`, `Composite` e `ICC_Profile`, com `c2pa` `null`.

**Ainda não verificado:**
- a estrutura de `contentCredentials` com C2PA real, e o valor desse campo num arquivo sem C2PA (a fixture de teste usa `null` por suposição);
- a estrutura de `ingredients`;
- se 413, 415 e 429 existem em `/extract`;
- a latência real por chamada;
- vídeo (grupo `QuickTime`), que fica de fora por enquanto.

**Avisos fixos no relatório:** "A revogação de certificados C2PA não é verificada online." e "Um signatário confiável indica quem gerou o arquivo, não que o conteúdo seja verdadeiro."

**Retenção do lado da ExifTools:**
- **Contradição:** a página oficial diz que os arquivos são processados e excluídos. Mas a API devolve um `uuid` que permite recuperar o resultado depois (`GET /extract/{uuid}`), e o `/remove` guarda o arquivo limpo por 24 h.
- **Consequência:** a política de privacidade não afirma prazo de retenção. A API nunca repassa o UUID, mas o arquivo enviado pode conter GPS e autoria. Ver `docs/politica-privacidade.md`.
- **Limites documentados:** 100 MB por arquivo enviado. Não há limite de requisições documentado; ele é tratado como inexistente, com o tratamento defensivo de 429 e 5xx descrito acima.
- **Não informados:** a retenção real, a região de processamento e o SLA.
- **Geocodificação:** a resposta real inclui `address` e `addressPlusCode`, derivados do GPS. A API descarta os dois (ver "Nunca saem"), mas não sabemos se a ExifTools usa um terceiro para geocodificar. É pendência de revisão jurídica (`docs/arquitetura.md`).

## Fact Check Tools

Fase 5b. `api/src/factcheck-client.ts`, `api/src/factcheck-response.ts` e `api/src/factcheck-search.ts`. Documentação: `docs/apis/fact-check.md` e as páginas oficiais de `claims.search` e do recurso Claim (lidas em 22/11/2026).

### Texto da busca

- **Origem:** a manchete da página (`headline`, que o fetcher já extrai). Sem ela, ou se ficar vazia depois da limpeza, o título. O usuário não digita nada, e a marcação ClaimReview da 5a não é usada.
- **Limpeza:** caracteres de controle viram espaço; bidi, largura zero e surrogate solto saem; os espaços são colapsados; o texto é cortado em 200 pontos de código, sem partir surrogate.
- **Sem texto:** status `skipped`, sem chamar o Google.
- **Sem filtro de idioma** (`languageCode`): o fetcher não extrai o idioma da página, e um filtro esconderia checagens em outras línguas sobre a mesma afirmação. Cada checagem traz o próprio `languageCode`, e a interface mostra.
- **Quando:** a busca começa assim que a linha `page` do fetcher chega (aviso `onPage` do cliente do fetcher), em paralelo com os downloads e a ExifTools.
  - **A manchete pode já ter sido enviada ao Google mesmo que o fetcher falhe depois.** Nesse caso a checagem responde com o erro do fetcher, a busca é abortada, e o aborto só descarta o resultado.
  - Se o usuário fechar a conexão, a busca também é abortada.
- **Prazo:** 5 s por chamada, desde o início da busca, e nunca além do prazo total da checagem (50 s). A resposta espera a busca no máximo até esse prazo; um erro rápido do Google não atrasa nada.

### Cliente

- **Endereço fixo:** `GET https://factchecktools.googleapis.com/v1alpha1/claims:search`, com corpo vazio e só os parâmetros `query` e `pageSize=10`, montados com `URLSearchParams` (acentos, `&`, `#` e espaços vão codificados). Sem variável de ambiente para trocar o destino. A URL da página nunca é enviada.
- **Chave só no cabeçalho `X-Goog-Api-Key`**, nunca em `?key=`. O cabeçalho está nos parâmetros de sistema das APIs do Google Cloud, e a página de chaves avisa que a chave na URL fica exposta. A página do Fact Check não documenta a autenticação; o uso do cabeçalho foi confirmado na prática em 22/11/2026 (`docs/deploy.md`, "Atualização de 22/11/2026 (Fase 5b: Fact Check Tools)").
  - A chave vem de `FACTCHECK_API_KEY`, **opcional**: sem ela, o status é `not_configured`, nenhuma requisição é feita e a checagem segue normal.
  - A chave nunca aparece em log, resultado ou mensagem de erro.
- **Redirecionamento:** não é seguido (`redirect: "manual"`), porque a chave iria junto.
- **Resposta:** até 512 KiB, com a mesma leitura com teto da ExifTools.
- **Sem nova tentativa:** é uma chamada por checagem, com prazo curto. 429 é cota, e insistir não resolve; tentar de novo depois de 5xx ou timeout só esticaria a espera.
- **Nunca lança:** toda falha vira um status, e o erro original (que pode citar a URL, e com ela o texto da busca) é descartado.

### Campo `factCheck`

| `status` | Quando | `query` | `claims` |
| --- | --- | --- | --- |
| `ok` | o Google respondeu no formato | texto enviado | até 10 afirmações (lista vazia quando não há) |
| `unavailable` | qualquer falha: 400, 403, 429, 5xx, outro status, redirecionamento, timeout, rede, resposta fora do formato ou grande demais | texto enviado | vazia |
| `skipped` | página sem manchete nem título | `null` | vazia |
| `not_configured` | sem `FACTCHECK_API_KEY` | `null` | vazia |

Cada afirmação: `text`, `claimant` e `claimDate`, e `reviews` com até 5 checagens: `publisherName`, `publisherSite`, `url`, `title`, `reviewDate`, `textualRating` e `languageCode`. São os campos de Claim, ClaimReview e Publisher da documentação oficial, com nomes nossos.

**Validação** (lista permitida; nada do Google é repassado sem cópia campo a campo; só propriedade própria é lida):
- Corpo que não é JSON, raiz que não é objeto ou `claims` que não é lista: a resposta inteira é descartada (`unavailable`). Sem `claims` (o Google manda `{}` quando não acha nada): `ok` com lista vazia. O `nextPageToken` é ignorado: só a primeira página.
- **Campo desconhecido é ignorado, nunca repassado** (a API é alfa e pode ganhar campos sem aviso).
- Campo com tipo errado vira `null`. Textos: espaços colapsados, até 300 (253 no site), sempre bem formados. Datas só em RFC 3339 UTC, como a documentação descreve. Idioma só como código BCP-47 de até 35.
- `url`: só http(s) absoluta, sem usuário e senha, de até 2048, guardada na forma normalizada; senão `null`. **Nunca é buscada.**
- Revisão sem `url`, `title` e `textualRating` é descartada; afirmação sem nenhuma revisão válida também. Item que não é objeto é descartado.
- Tetos de 10 afirmações e 5 revisões por afirmação; só os primeiros 50 itens de cada lista são lidos. A ordem é a do Google.

**Linguagem.** `textualRating` é o rótulo que o **publicador** escreveu (por exemplo "Mostly false"). A interface mostra a seção com "Buscamos por: «…»", a linha "Esse texto foi enviado ao Google Fact Check Tools." e o aviso fixo "Estas checagens foram publicadas por terceiros sobre afirmações parecidas com a manchete. Parecido não significa que seja a mesma afirmação, e o Aletheia não conclui nada.". O rótulo sai entre aspas, com o publicador e o link. Sem contagem, sem nota e sem ordenação por rótulo; fica fora do resumo de sinais. Sem checagens, a tela diz que isso não diz nada sobre a matéria.

**Compatibilidade.** O campo é aditivo: a web anterior o ignora, e a web nova sem o campo (API anterior) não mostra a seção. O fetcher não muda.

## Limite por usuário (plano gratuito)

`api/src/plans.ts` e `api/src/rate-limit.ts`.

- **Planos:** a tabela de planos tem só `free`: 10 verificações por hora e até 8 mídias por verificação. `free` é a base. Planos pagos hipotéticos, se vierem, entram estendendo a tabela de planos e a função `resolvePlan(user)`, que hoje devolve sempre `free`. Não há cobrança nem cadastro nesta fase.
- **Janela deslizante de 1 hora por usuário.** A chave é o HMAC-SHA-256 do `sub` do ID token, com chave aleatória gerada quando o processo sobe e nunca gravada. O e-mail não é guardado, nem o `sub` em claro.
- **Memória limitada:** uma varredura, no máximo a cada 60 s, remove os usuários cuja última checagem saiu da janela. Teto de 10 000 usuários: cheio e sem nada expirado, um usuário novo recebe 429 (falha fechada).
- **O que conta:** toda checagem com corpo válido conta, mesmo que falhe, menos quando o fetcher está ocupado.
- **O contador é por instância.** Cada instância da API tem o próprio mapa em memória. Com N instâncias, um usuário pode chegar a até N × 10 verificações por hora. **O deploy deve usar no máximo 2 instâncias da API (`--max-instances 2`)**, o que dá no máximo 20 por hora. É uma aproximação aceitável para demonstração. Um limite exato exigiria estado compartilhado, como Redis ou Firestore, o que contraria a decisão stateless e precisa de aprovação.
- **Sem limite por IP nesta fase.** Ver o requisito 2 de `docs/fetcher.md`.

## Capacidade e implantação

| Parâmetro | Valor | Motivo |
| --- | --- | --- |
| Checagens em andamento por instância | 4 (acima disso, 503) | Cada checagem pode segurar cerca de 110 MiB (estimativa): até 60 MiB de mídia decodificada, mais uma linha de até 21 MiB em base64 e os buffers da leitura. Durante o envio à ExifTools, somam-se até 2 cópias de mídia de 15 MiB (o corpo multipart), depois que o stream do fetcher já foi liberado. |
| Memória | 1 GiB | 4 × 110 MiB mais o processo e a folga para GC. |
| `--concurrency` | 4 | Igual ao teto do código. Com um valor maior, o Cloud Run mandaria requisições para uma instância que responde 503, em vez de abrir outra. |
| `--max-instances` | 2 | Contador do limite por instância (acima). |
| `--timeout` | 60 s | O Firebase Hosting corta em 60 s. |

**Capacidade do fetcher:** 2 instâncias da API × 4 checagens dão até 8 chamadas simultâneas ao fetcher, que aceita 2 por instância. Com menos de 4 instâncias do fetcher, o excesso recebe "Serviço ocupado". As estimativas de memória ainda precisam ser confirmadas no Cloud Run.

## Configuração

| Variável | Obrigatória | Uso |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | sim | `aud` esperado no ID token do usuário |
| `PORT` | sim | definida pelo Cloud Run |
| `FETCHER_URL` | sim | URL do serviço do fetcher. https, ou `http://localhost` em desenvolvimento; sem usuário/senha, query ou fragmento |
| `FETCHER_AUDIENCE` | sim | `aud` do ID token de serviço; igual ao `FETCHER_AUDIENCE` do fetcher. Mesma regra de esquema |
| `EXIFTOOLS_API_KEY` | sim | chave da ExifTools. Em produção, vem do Secret Manager; nunca vai para código, log ou commit |
| `FACTCHECK_API_KEY` | não | chave do Google Fact Check Tools (segredo `factcheck-api-key`). Sem ela, a busca de checagens fica `not_configured` e a checagem segue normal. Mesmas regras de segredo |

Os erros de configuração nomeiam a variável e nunca repetem o valor.

## Logs

Uma linha JSON por requisição: `method`, `route` (normalizada), `status`, `durationMs`, `outcome`, `domainHash`, `mediaCount` (mídias baixadas), `analyzedCount` (mídias com sinais), `exif` (contagem por status da ExifTools: `ok`, `unavailable`, `unsupported`, `too_large`, `invalid`, `config_error`, `not_analyzed`, `skipped`) e `factCheck` (contagem por status da busca no Fact Check Tools: `ok`, `skipped`, `not_configured` ou a categoria da falha, `http_400`, `http_403`, `http_429`, `http_5xx`, `http_other`, `timeout`, `network`, `invalid`, `too_large`, `aborted`; só nas respostas 200).

`http_403` em `factCheck` indica chave recusada ou API desativada no projeto: precisa de ação, como o `config_error` da ExifTools.

`config_error` em `exif` significa que a ExifTools recusou a chave: é erro de configuração nosso e precisa de ação.

- **Nunca aparecem:** URL, caminho, corpo, token, e-mail, `sub`, chaves da ExifTools e do Fact Check, o texto enviado na busca, nada das checagens devolvidas, nem bytes.
- **`domainHash`:** HMAC-SHA-256 truncado do hostname, com chave aleatória do processo, igual ao do fetcher.
- **`outcome`:** inclui a categoria interna exata, que nunca vai para o usuário. "Observado" marca os valores vistos no teste real de 24/10/2026; os demais vêm do código e ainda não apareceram num teste manual.

  | `outcome` | Significado | Observado |
  | --- | --- | --- |
  | `ok` | Relatório devolvido (200) | sim |
  | `fetch_blocked` | Destino bloqueado pelo fetcher (IP interno, metadados); o usuário vê a mensagem única de endereço inacessível | sim |
  | `fetch_network` | Falha de rede ou de DNS no fetcher (por exemplo, domínio inexistente); mesma mensagem única | sim |
  | `fetch_upstream_status` | O site respondeu com erro (422 com `httpStatus`) | sim |
  | `fetch_<outra categoria>` | `timeout`, `invalid_url`, `too_large`, `unsupported_type`, `too_many_redirects` | não |
  | `fetcher_token` | A API não conseguiu emitir o token de serviço (502) | sim |
  | `fetcher_unauthorized` | O fetcher recusou o token de serviço (502) | sim |
  | `fetcher_network` | O fetcher não respondeu: fora do ar (502) | sim |
  | `fetcher_busy`, `fetcher_timeout`, `fetcher_status`, `fetcher_malformed` | Fetcher ocupado depois das novas tentativas (503), prazo esgotado (504), status inesperado ou resposta fora do contrato (502) | não |
  | `rate_limited` | Limite do plano estourado (429) | sim |
  | `limiter_full`, `api_busy` | Teto de usuários do contador (429) ou de checagens em andamento (503) | não |
  | `bad_request` | Corpo inválido (400) | sim |
  | `unauthorized` | Token do usuário ausente ou inválido (401) | sim |
  | `bad_content_type`, `body_too_large` | 415 e 413 | não |
  | `client_closed`, `internal_error` | O usuário fechou a conexão; erro inesperado | não |
- **Exatamente uma linha:** a linha sai no fim da resposta. Se a conexão fechar antes, sai como `client_closed`.
