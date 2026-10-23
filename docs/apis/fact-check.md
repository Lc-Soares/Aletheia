# Google Fact Check: referência para o projeto

Resumo escrito em 2026-10-22 a partir das páginas oficiais. São duas fontes diferentes, para usos diferentes. Antes de implementar, leia as páginas originais (com WebFetch) e crie as fixtures de teste a partir delas. Não invente campos.

## 1. API Fact Check Tools: `claims.search` (achar checagens que já existem)

Páginas oficiais:
- Método: https://developers.google.com/fact-check/tools/api/reference/rest/v1alpha1/claims/search
- Recurso Claim (subcampos da resposta): https://developers.google.com/fact-check/tools/api/reference/rest/v1alpha1/claims

O que a página do método informa:
- Requisição: `GET https://factchecktools.googleapis.com/v1alpha1/claims:search`, com corpo vazio.
- A entrada é **texto da afirmação**, não uma URL.
- Parâmetros de consulta:
  - `query`: texto da busca. Obrigatório, exceto quando `reviewPublisherSiteFilter` é informado.
  - `languageCode`: idioma em BCP-47. A região é ignorada.
  - `reviewPublisherSiteFilter`: restringe ao site de quem publicou a checagem.
  - `maxAgeDays`: idade máxima dos resultados, em dias.
  - `pageSize`: resultados por página (padrão 10).
  - `pageToken`: próxima página, vindo de `nextPageToken`. Os demais parâmetros devem ser iguais aos da primeira chamada.
  - `offset`: posição inicial; é ignorado quando há `pageToken`.
- Resposta: `claims[]` e `nextPageToken` (vazio quando não há mais resultados).

O que essa página **não** informa (confirmar nas páginas oficiais antes de codar):
- Como autenticar (provavelmente chave de API; confirmar na visão geral da API).
- Os subcampos de cada Claim. Estão na página do recurso Claim, acima.

Não usar neste projeto: o recurso `pages` (create, delete, get, list, update). Ele serve a **publicadores** para gerenciar a marcação ClaimReview das próprias páginas.

## 2. Marcação ClaimReview (JSON-LD) na página analisada

Página oficial: https://developers.google.com/search/docs/appearance/structured-data/factcheck?hl=pt-br

Uso no projeto: ao baixar a página do link, procurar blocos `<script type="application/ld+json">` com `ClaimReview`. Isso mostra se a própria página se apresenta como uma checagem, sem chamar nenhuma API.

O que a página informa:
- Campos obrigatórios: `claimReviewed` (resumo da afirmação), `reviewRating` (com rótulo textual em `alternateName`, como "Falso") e `url`.
- Campos recomendados: `author`, `itemReviewed` (objeto Claim com autor, data e onde a afirmação apareceu) e, na avaliação, `bestRating`, `worstRating` e `ratingValue`.
- O exemplo da página usa JSON-LD.
- O Google avisa que está desativando o suporte a esse resultado na Pesquisa, mas a marcação continua funcionando no Fact Check Explorer. Portanto, sites podem manter ou remover a marcação, e a **ausência dela não diz nada**.

Regras de segurança para este projeto:
- Qualquer site pode escrever ClaimReview, então trate o conteúdo como entrada não confiável: escape tudo e mostre sempre a fonte.
- A marcação indica que a página se apresenta como checagem. Não indica que a checagem está correta.
