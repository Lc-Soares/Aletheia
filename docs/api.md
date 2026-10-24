# API

Serviço Node.js no Cloud Run, atrás do Firebase Hosting (`/api/**`). Valida o login, aplica o limite do plano, chama o fetcher e devolve o relatório. É stateless: nada vai para disco ou banco, e os bytes das mídias só existem na memória durante a requisição.

Fase 4a: `POST /api/check` devolve página e mídias, sem os sinais da ExifTools (que entram na 4c).

## Rotas

| Rota | Método | Autenticação | Resposta |
| --- | --- | --- | --- |
| `/healthz` | GET | nenhuma | `200 {"status":"ok"}` |
| `/api/me` | GET | ID token do usuário | `200 {"email":"..."}` |
| `/api/check` | POST | ID token do usuário | relatório JSON (abaixo) |

O ID token do Google vai em `Authorization: Bearer`. O verificador confere assinatura, `aud`, `iss`, `exp`, `email_verified` e exige `email` e `sub` (`api/src/auth.ts`). Qualquer falha devolve `401 {"error":"Não autorizado"}` com `WWW-Authenticate: Bearer`.

## `POST /api/check`

Corpo: `Content-Type: application/json` e exatamente `{"url":"https://..."}`, com 1 a 2048 caracteres, até 4 KiB. A URL vai no corpo, nunca na query string.

Ordem de processamento (`api/src/check.ts`):
1. autentica;
2. confere o teto de checagens em andamento na instância (4);
3. lê e valida o corpo (um corpo inválido não gasta cota);
4. consome o limite do plano;
5. chama o fetcher.

### Resposta 200

```json
{
  "page": { "finalUrl": "...", "title": "...", "headline": "...", "possiblyNeedsJavaScript": false },
  "media": [
    { "url": "...", "kind": "image", "source": "og:image", "group": 1, "score": 100, "selected": true, "skipReason": null,
      "download": { "status": "ok", "contentType": "image/jpeg", "size": 12345, "sha256": "<hex>" } },
    { "url": "...", "kind": "image", "source": "img", "group": 2, "score": 20, "selected": true, "skipReason": null,
      "download": { "status": "error", "error": "unreachable", "message": "Não foi possível acessar este endereço." } },
    { "url": "...", "kind": "image", "source": "img", "group": 3, "score": -70, "selected": false, "skipReason": "icon", "download": null }
  ],
  "notices": ["A seleção de mídias é automática e heurística; ..."]
}
```

- `media` traz todas as referências que o fetcher listou (até 200), com `group`, `score`, `selected` e `skipReason` como o fetcher entrega (`docs/fetcher.md`). `download` é `null` para as não selecionadas.
- Os bytes das mídias nunca vão na resposta.
- `title`, `headline` e as URLs vêm de terceiros. Quem exibir esse texto precisa escapá-lo.
- `notices` sempre traz o aviso de seleção heurística e, quando `possiblyNeedsJavaScript` é verdadeiro, o aviso de que a página possivelmente depende de JavaScript. O sinal é uma possibilidade, nunca um fato.

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
  - content-type da mídia na lista do fetcher;
  - o base64 é decodificado linha a linha, e o tamanho e o SHA-256 são conferidos.

  Qualquer desvio vira 502 genérico.
- **Corpo de erro do fetcher:** nunca é repassado. Do 422 só se aproveitam a categoria conhecida e o `httpStatus` válido.
- **Cancelamento:** se o usuário fecha a conexão, a chamada ao fetcher é abortada.

## Limite por usuário (plano gratuito)

`api/src/plans.ts` e `api/src/rate-limit.ts`.

- **Planos:** a tabela de planos tem só `free`: 10 verificações por hora e até 8 mídias por verificação. `resolvePlan` devolve sempre `free` e é o ponto de extensão para planos futuros. Não há cobrança nem cadastro.
- **Janela deslizante de 1 hora por usuário.** A chave é o HMAC-SHA-256 do `sub` do ID token, com chave aleatória gerada quando o processo sobe e nunca gravada. O e-mail não é guardado, nem o `sub` em claro.
- **Memória limitada:** uma varredura, no máximo a cada 60 s, remove os usuários cuja última checagem saiu da janela. Teto de 10 000 usuários: cheio e sem nada expirado, um usuário novo recebe 429 (falha fechada).
- **O que conta:** toda checagem com corpo válido conta, mesmo que falhe, menos quando o fetcher está ocupado.
- **O contador é por instância.** Cada instância da API tem o próprio mapa em memória. Com N instâncias, um usuário pode chegar a até N × 10 verificações por hora. **O deploy deve usar no máximo 2 instâncias da API (`--max-instances 2`)**, o que dá no máximo 20 por hora. É uma aproximação aceitável para demonstração. Um limite exato exigiria estado compartilhado, como Redis ou Firestore, o que contraria a decisão stateless e precisa de aprovação.
- **Sem limite por IP nesta fase.** Ver o requisito 2 de `docs/fetcher.md`.

## Capacidade e implantação

| Parâmetro | Valor | Motivo |
| --- | --- | --- |
| Checagens em andamento por instância | 4 (acima disso, 503) | Cada checagem pode segurar cerca de 110 MiB (estimativa): até 60 MiB de mídia decodificada, mais uma linha de até 21 MiB em base64 e os buffers da leitura. |
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

Os erros de configuração nomeiam a variável e nunca repetem o valor.

## Logs

Uma linha JSON por requisição: `method`, `route` (normalizada), `status`, `durationMs`, `outcome`, `domainHash` e `mediaCount` (mídias baixadas).

- **Nunca aparecem:** URL, caminho, corpo, token, e-mail, `sub` nem bytes.
- **`domainHash`:** HMAC-SHA-256 truncado do hostname, com chave aleatória do processo, igual ao do fetcher.
- **`outcome`:** inclui a categoria interna exata, que nunca vai para o usuário. Valores:
  - `ok`;
  - `fetch_<categoria>` (por exemplo `fetch_blocked`);
  - `fetcher_busy`, `fetcher_unauthorized`, `fetcher_timeout`;
  - `fetcher_status`, `fetcher_network`, `fetcher_malformed`, `fetcher_token`;
  - `rate_limited`, `limiter_full`, `api_busy`;
  - `unauthorized`, `bad_request`, `bad_content_type`, `body_too_large`;
  - `client_closed`, `internal_error`.
- **Exatamente uma linha:** a linha sai no fim da resposta. Se a conexão fechar antes, sai como `client_closed`.
