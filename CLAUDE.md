# Plataforma de checagem de mídia (Aletheia)

Portal em que o usuário cola o link de uma página. A API analisa as mídias da página e devolve **sinais de proveniência** (EXIF, C2PA, ClaimReview, Fact Check, busca reversa, reputação da URL). O sistema nunca emite veredito de "verdadeiro" ou "falso".

Leia antes de mudanças de arquitetura ou de privacidade:
- `docs/arquitetura.md` (decisões, fluxo, segurança, plano de fases)
- `docs/politica-privacidade.md` (minuta LGPD)
- `docs/apis/` (documentação das APIs externas; nunca invente endpoints ou campos)

## Princípio central: stateless
- Sem banco de dados e sem arquivos persistentes. Dados do usuário existem só na memória durante a requisição e são descartados em um bloco `finally`.
- Nunca logar URL do usuário, corpo da requisição nem metadados. No máximo o domínio ou um hash.
- A URL do usuário vai no corpo de um POST, nunca na query string.

## Estrutura
- `web/`: front-end estático (Firebase Hosting)
- `api/`: API Node.js + TypeScript (Cloud Run)
- `fetcher/`: serviço isolado que baixa páginas e mídias (Cloud Run)
- `docs/`: documentação do projeto
- O `package.json` da raiz declara `workspaces` para `web/`, `api/` e `fetcher/`.

## Comandos (rodar na raiz)
- `npm ci` (instala exatamente o que está no `package-lock.json`; use `npm install` só para adicionar pacote, com aprovação)
- `npm run lint`
- `npm run typecheck`
- `npm run test`
- `npm run check`: roda lint, typecheck e test. **Deve passar antes de concluir qualquer tarefa.**

## Fluxo de trabalho obrigatório
1. Leia os arquivos relevantes antes de editar. Para mudança não trivial, proponha um plano curto e espere o OK.
2. Escreva ou atualize os testes junto com o código. Em código de segurança, escreva o teste primeiro.
3. Rode `npm run check`. Só diga que terminou se passou, e mostre o resultado real. Nunca afirme que testes passaram sem rodar. Se não conseguir rodar, diga isso.
4. Se um teste falhar, corrija a causa. Nunca apague, pule (`skip`, `only`), enfraqueça asserts nem desligue regras de lint ou de tipos para passar.
5. Trabalhe em branch própria, com commits pequenos e focados. Nunca commite direto na `main` e nunca use `git push --force`.

## Segurança (não negociável)
- **Segredos:** nunca em código, logs, testes ou commits. Vêm de variáveis de ambiente ou do Secret Manager. Não leia arquivos `.env*`.
- **Entrada hostil:** URLs, HTML, metadados e nomes de arquivo vêm do atacante.
- **SSRF:** toda requisição a URL externa passa pelo módulo do `fetcher`. Ele resolve o DNS uma vez e conecta naquele IP, bloqueia loopback, redes privadas, link-local e o servidor de metadados do Google Cloud, revalida a cada redirecionamento (máx. 5), e limita tempo, tamanho e tipos de conteúdo. Nunca use `fetch` com URL do usuário fora dele.
- **XSS:** escape todo texto vindo de páginas e metadados. Nunca use `innerHTML` com dado externo.
- **Chaves de API externas:** só no header (`X-API-Key`), nunca em `?key=`.
- **Login:** valide o ID token do Google em toda rota protegida (assinatura, `aud`, `exp`, `email_verified`).
- **Linguagem do produto:** relatórios e interface falam em sinais e limitações, nunca em veredito.

## Dependências
- Antes de adicionar um pacote, justifique por que o Node nativo não resolve (`fetch`, `crypto`, `node:test`) e pergunte ao usuário.
- Nunca afrouxe o `.npmrc` (scripts de instalação desligados, idade mínima de versão, sem dependências via git).
- Em CI e produção, instale sempre com `npm ci`. Nunca apague o `package-lock.json` para "resolver" um erro.

## Testes
- Runner: `node:test` (ou Vitest, se a equipe decidir). Arquivos `*.test.ts` ao lado do código.
- Testes nunca chamam APIs externas reais. Use fixtures baseadas na documentação em `docs/apis/`.
- Bateria de SSRF obrigatória: IPs privados, IPv6, formatos decimal e octal, redirecionamento para `169.254.169.254`, DNS que muda entre validação e conexão, URL com usuário e senha.
- Também obrigatórios: token ausente, expirado ou com `aud` errada; metadados com HTML e scripts; mídia acima do limite; teste de que nada é gravado em disco e de que logs não contêm a URL enviada.

## Estilo
- TypeScript com `strict: true`. Sem `any` sem comentário explicando.
- Funções pequenas. Erros com mensagens que não vazam dados do usuário.
- Código e identificadores em inglês; textos de interface em português do Brasil.

## Quando em dúvida, pergunte
Principalmente sobre: guardar qualquer dado, nova API externa ou custo, nova dependência e mudança que afete a política de privacidade.
