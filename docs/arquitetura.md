# Arquitetura – Plataforma de Checagem de Mídia (Aletheia)

Oct 22, 2026 · @Lucas

## Visão geral

A plataforma recebe o link de uma página, analisa as mídias dela e devolve um relatório de sinais de proveniência, sem guardar o conteúdo analisado.

**Escopo do MVP**

- Entrada somente por link; não há upload de arquivo.
- Login somente com conta Google.
- Checagens: metadados EXIF e assinatura C2PA (API ExifTools), marcação ClaimReview na própria página, busca de checagens existentes (Google Fact Check Tools), busca reversa de imagem (Cloud Vision, Web Detection) e reputação da URL (Web Risk).
- Relatório em PDF ou JSON, gerado no navegador do usuário.
- Nenhum banco de dados e nenhum armazenamento persistente de conteúdo.

**O que o sistema afirma e o que não afirma**

O relatório descreve sinais, não veredictos. Uma assinatura C2PA válida mostra quem assinou o arquivo e que ele não foi alterado depois, mas não prova que o conteúdo é verdadeiro. A ausência de EXIF ou C2PA não indica fraude, porque redes sociais removem metadados. EXIF presente também pode ser forjado. Por isso a interface e o relatório nunca devem exibir "verdadeiro" ou "falso", e sim sinais, fontes e limitações.

## Decisões de arquitetura

A arquitetura é stateless: tudo o que o usuário envia existe apenas na memória durante a requisição e é descartado ao final.

| Tema | Decisão | Motivo | Alternativa descartada |
| --- | --- | --- | --- |
| Hospedagem do front-end | Firebase Hosting (subdomínio \*.web.app) | Origem exclusiva, cabeçalhos de segurança configuráveis, encaminha /api para o Cloud Run na mesma origem | GitHub Pages (sem cabeçalhos próprios, origem compartilhada com outros projetos) |
| Código-fonte | Repositório público no GitHub; implantação por GitHub Actions | Equipe já usa; segredos nunca ficam no repositório | Repositório privado (exigiria plano pago para Pages) |
| Backend | Node.js LTS com TypeScript, no Cloud Run | Familiaridade da equipe; contêiner sem disco persistente | Servidor fixo (VM) |
| Persistência | Nenhuma no MVP | Menor risco e menor obrigação sob a LGPD | MySQL (adiado; entra se houver histórico ou auditoria) |
| Login | Google Identity Services; ID token no header Authorization, verificado no servidor | Sem senhas, sem sessão, sem cookies entre sites | Provedor gerenciado com MFA obrigatório |
| Entrada | Somente link | Menor superfície de ataque e de privacidade | Upload de arquivo |
| Download de mídia | Uma vez, em memória; os mesmos bytes vão a todas as checagens | Menos requisições e menos tempo de exposição | Passar a URL a cada serviço |
| Relatório | PDF e JSON gerados no navegador | Nada é retido pelo servidor | Relatório salvo no servidor com link |
| Pacotes Node | npm 11.10 ou superior, com idade mínima de versão (min-release-age) e scripts de instalação bloqueados | Reduz risco de pacotes comprometidos | Instalação sem restrições |

A hospedagem Firebase com encaminhamento ao Cloud Run normalmente exige projeto com faturamento ativo; confirmar na documentação atual antes de implantar.

## Componentes e diagrama

O navegador fala só com o Firebase Hosting, que encaminha /api para a API no Cloud Run; a API usa um fetcher isolado para baixar o conteúdo e chama os serviços externos em paralelo.

&#91;embedded content: arquitetura · 3 camadas, 1 orquestrador\]

A API é o único componente que conversa com todos os serviços. O fetcher é o único que acessa a internet aberta, e por isso fica isolado dos demais.

## Fluxo de uma verificação

Uma verificação é uma única requisição em streaming, do login ao descarte dos dados.

1. O usuário entra com Google e o navegador obtém um ID token.
2. O navegador envia a URL no corpo de um POST (nunca na query string) e o token no header Authorization.
3. A API valida o token (assinatura, audiência, expiração, e-mail verificado) e aplica o limite de uso.
4. A API repassa a URL ao fetcher, um serviço privado que só aceita a conta de serviço da API. O fetcher valida a URL: apenas http e https, portas 80 e 443, resolve o DNS uma vez e bloqueia endereços privados, de loopback e link-local (inclusive o servidor de metadados do Google Cloud). A validação se repete a cada redirecionamento.
5. O fetcher baixa o HTML em memória, com limite de tamanho e de tempo.
6. O fetcher extrai do HTML as mídias (img, srcset, video, source, og:image, og:video) e o título ou manchete. A leitura de ClaimReview em JSON-LD entra na Fase 5.
7. Cada mídia é baixada uma única vez pelo fetcher, com as mesmas validações da URL do usuário, limite de tamanho e lista de tipos permitidos, e o SHA-256 é calculado. Detalhes, limites e regras de implantação em `docs/fetcher.md`.
8. As checagens rodam em paralelo: ExifTools (EXIF e C2PA), Cloud Vision (Web Detection), Web Risk (reputação da URL) e Fact Check (busca da afirmação extraída).
9. O agregador junta os sinais e envia o resultado ao navegador. Na Fase 4, a resposta é um único JSON no fim da verificação (`docs/api.md`). O envio de cada resultado por SSE, assim que fica pronto, fica para uma fase posterior.
10. O navegador monta o relatório e o usuário baixa PDF ou JSON.
11. O servidor descarta tudo em um bloco finally. Nada vai para disco ou banco.

No passo 8, a ExifTools recebe **sempre o arquivo** já baixado pelo fetcher, em multipart, e nunca a URL da mídia (decisão da Fase 4). Os modos `url` e `data_url` com URL fariam a ExifTools buscar a mídia por conta própria: isso contornaria o fetcher isolado e as proteções contra SSRF, e entregaria a terceiros o endereço que o usuário analisou. Detalhes em `docs/api.md`.

## Integrações externas

Cinco serviços externos alimentam o relatório; todas as chaves ficam no Secret Manager do Google Cloud e nunca no código nem no front-end.

| Serviço | Uso | Entrada e saída | Pontos a observar |
| --- | --- | --- | --- |
| API ExifTools | EXIF, IPTC, XMP, GPS e verificação C2PA | POST /extract com url, file ou data\_url (usamos só file, em multipart); devolve metadata e, quando há credenciais, o bloco contentCredentials | Chave no header X-API-Key (o parâmetro ?key= vaza em logs). Limite de 100 MB por envio. A documentação não informa limites de requisição, preço, retenção nem SLA. Resultados são recuperáveis por UUID, o que indica retenção do lado deles. |
| Google Fact Check Tools | Achar checagens já publicadas sobre a afirmação | claims.search recebe o texto da afirmação | O recurso pages é para publicadores criarem marcação ClaimReview e não serve a este caso. |
| Cloud Vision, Web Detection | Busca reversa: onde a imagem já circulou | Imagem em bytes; devolve páginas e entidades correspondentes | Serviço pago: definir cota diária e alerta de orçamento antes de habilitar. |
| Web Risk | Reputação da URL (malware, phishing) | URL; devolve ameaças conhecidas | A Safe Browsing gratuita é restrita a uso não comercial; confirmar os termos antes de escolher. |
| Google Identity Services | Login | ID token JWT | O cliente OAuth deve listar apenas a origem exata do front-end. O MFA depende do que o usuário ativou na conta Google. |

A leitura de ClaimReview em JSON-LD da própria página é feita localmente e não depende de API.

**Estados C2PA no relatório.** O campo state da ExifTools pode ser trusted, trusted\_legacy, valid, invalid, remote, unchecked ou error. O relatório mostra o estado e o signatário com o texto da própria API e uma nota fixa: um signatário confiável diz quem fez o arquivo, não que o conteúdo é verdadeiro.

**PDF e Office.** A ExifTools devolve também arquivos embutidos, ainda pendentes logo após o envio. O MVP trata imagens e vídeos; documentos entram em fase posterior, com consulta repetida ao resultado.

## Segurança

Os maiores riscos são o servidor buscar URLs fornecidas por terceiros, a exibição de texto controlado por atacantes e a cadeia de dependências do Node.

- **SSRF (servidor buscando URLs).** O fetcher roda em serviço separado, com egress controlado. Resolve o DNS uma vez e conecta naquele IP, para evitar DNS rebinding. Bloqueia loopback, redes privadas, link-local e o endereço do servidor de metadados do Google Cloud. Limita redirecionamentos (no máximo 5), tempo (cerca de 10 s), tamanho e tipos de conteúdo. Nunca repassa cookies nem credenciais e usa User-Agent próprio.
- **Arquivos não confiáveis.** A API não interpreta mídias por conta própria. Se um dia o ExifTool for auto-hospedado, deve rodar em contêiner isolado, pois já teve uma vulnerabilidade de execução remota (CVE-2021-22204).
- **XSS.** Metadados são texto escolhido por quem criou o arquivo. O front-end escapa tudo, nunca usa innerHTML com dados externos e aplica a mesma regra ao PDF e ao JSON exportados.
- **Cabeçalhos do Firebase Hosting.** Configurar em firebase.json: CSP restritiva, frame-ancestors, HSTS, X-Content-Type-Options e Referrer-Policy.
- **Token de login.** O ID token fica apenas na memória do JavaScript, nunca em localStorage, e expira em cerca de 1 hora; o front-end o renova.
- **Abuso e custo.** Limite por conta e por IP, Turnstile ou reCAPTCHA, número máximo de instâncias no Cloud Run, cota diária e alerta de orçamento em cada API paga. O limite por conta sozinho não basta, porque contas Google são fáceis de criar.
- **Segredos.** Secret Manager; o Cloud Run usa a identidade da própria conta de serviço, sem arquivos JSON de chave; cada chave de API é restrita ao serviço que usa.
- **Cadeia de suprimentos.** Incidentes recentes (como o sequestro de versões do axios em março de 2026) mostram o risco. Controles: lockfile versionado e instalação com npm ci ou pnpm install --frozen-lockfile; idade mínima de versão (min-release-age no npm 11.10 ou superior, em dias; minimumReleaseAge no pnpm, em minutos); ignore-scripts=true, liberando por exceção apenas pacotes que precisam compilar; allow-git=none; poucas dependências, preferindo recursos nativos do Node; scanner de vulnerabilidades (por exemplo OSV-Scanner) no CI; GitHub Actions fixadas por hash de commit com permissões mínimas; etapa de instalação sem acesso a segredos; contêiner sem root e com sistema de arquivos somente leitura.
- **Registro de acesso.** Ver a seção de privacidade: o dever legal de guardar registros pode conflitar com a meta de não reter nada.

## Privacidade, logs e retenção

O sistema não guarda o conteúdo analisado, mas ainda trata dados pessoais durante a requisição e depende de terceiros que podem reter dados por conta própria.

| Dado | Por onde passa | Retenção pelo sistema |
| --- | --- | --- |
| E-mail e identificador Google | Google (login) e API (validação do token) | Nenhuma além da requisição |
| URL enviada pelo usuário | API, fetcher, Web Risk, Fact Check (texto extraído) | Nenhuma; não vai em log |
| Mídia baixada da página (pode conter GPS e autor) | Memória da API, ExifTools, Cloud Vision | Nenhuma; descartada ao fim da requisição |
| IP e dados técnicos da requisição | Cloud Run e Cloud Logging | Conforme configuração de logs (abaixo) |

**Regras de implementação**

- A URL do usuário vai no corpo do POST, nunca no caminho nem na query string, porque o Cloud Run registra o caminho das requisições por padrão.
- Logs de aplicação não registram URL completa nem corpo da requisição; no máximo o domínio ou um hash.
- Definir retenção curta nos buckets de log do Cloud Logging (por exemplo 30 dias, a decidir) e desligar qualquer exportação.
- Terceiros podem reter dados: a ExifTools permite recuperar resultados por UUID, e o Google trata o que recebe conforme seus próprios termos. A política de privacidade deve dizer isso, em vez de prometer que ninguém armazena nada.
- Servidores de terceiros podem estar fora do Brasil, o que configura transferência internacional de dados na LGPD. Confirmar onde cada serviço processa os dados.

**Ponto jurídico em aberto: Marco Civil da Internet.** O artigo 15 exige a guarda de registros de acesso (data, hora e IP) por 6 meses de provedores constituídos como pessoa jurídica, com atividade organizada, profissional e com fins econômicos. O projeto será de pessoa física e sem fins lucrativos, então em princípio a obrigação não se aplica, mas uma ordem judicial pode exigir registros sobre fatos específicos. Manter registros mínimos e de curta duração, sem a URL analisada, e validar o enquadramento com advogado antes do lançamento.

A minuta da política de privacidade acompanha este documento, em arquivo separado.

## Relatório em PDF e JSON

O relatório é montado no navegador a partir do que a API enviou por SSE, então o servidor não precisa guardar nada para que o usuário o leve consigo.

- **JSON.** Um Blob baixado pelo navegador, sem dependências. Campos mínimos: versão do esquema, data e hora, URL analisada, SHA-256 de cada mídia e, por checagem, estado, evidência, fonte e limitação conhecida, além de um aviso fixo de que os sinais não são veredictos.
- **PDF.** Começar com folha de estilo de impressão e window.print() ("Salvar como PDF"), que não adiciona dependências. Se for preciso layout exato, usar uma biblioteca como pdf-lib ou jsPDF, com versão fixa e passando pelos controles de cadeia de suprimentos.
- **Dados pessoais no arquivo.** O relatório pode trazer GPS ou nome de autor extraídos dos metadados. A interface avisa isso antes do download e permite ocultar esses campos.
- **Fase 2, relatório assinado (opcional).** Um relatório local pode ser editado por qualquer pessoa. A API pode assinar o JSON ao fim da requisição (chave no Cloud KMS) e oferecer um endpoint de verificação. A assinatura prova que o relatório saiu do serviço naquele momento, não que o conteúdo analisado é verdadeiro, e continua sem exigir armazenamento.

## Qualidade: testes e CI

Nenhuma alteração entra na branch principal sem passar por lint, checagem de tipos, testes e verificação de dependências no CI.

- **Testes unitários** para validação de URL, extração de mídias, agregador de sinais e montagem do relatório. O runner nativo do Node (node:test) reduz dependências; Vitest é a alternativa se a equipe preferir.
- **Testes de integração com serviços simulados.** O CI nunca chama as APIs reais (custo e limites). Usar respostas gravadas no formato da documentação da ExifTools e dos serviços Google.
- **Testes de segurança obrigatórios:** SSRF (IPs privados, IPv6, formatos decimal e octal, redirecionamento para 169.254.169.254, DNS que muda entre a validação e a conexão, URL com usuário e senha); token ausente, expirado ou com audiência errada; metadados com HTML e scripts; mídias acima do limite de tamanho.
- **Teste de não retenção:** verificar que nenhum arquivo é gravado fora do tmpfs e que os logs não contêm a URL enviada.
- **Ponta a ponta** (por exemplo com Playwright) do fluxo principal, com as APIs simuladas.
- **CI no GitHub Actions:** instalação com lockfile e scripts bloqueados, lint, tipos, testes, auditoria de dependências, build. A branch principal exige CI verde antes do merge.
- **Definição de pronto:** código novo vem com testes, todos os comandos acima passam e nenhuma dependência é adicionada sem justificativa. As mesmas regras estão no arquivo CLAUDE.md para o Claude Code.

## Riscos, limitações e pontos a confirmar

Os riscos mais altos são jurídicos (registros de acesso e LGPD), a dependência de um único fornecedor para EXIF e C2PA e a cadeia de dependências do Node.

| Risco | Gravidade | Mitigação |
| --- | --- | --- |
| Usuário interpretar "sem metadados" como fraude | Alta | Sem veredictos; aviso fixo no relatório e na interface |
| Dependência da ExifTools (limites, preço, retenção e SLA desconhecidos) | Alta | Cada checagem é um plugin com interface padrão; plano B com ExifTool e c2patool auto-hospedados em sandbox |
| Obrigações do Marco Civil e da LGPD | Alta | Validação com advogado; registros mínimos; política de privacidade publicada |
| Pacotes npm comprometidos | Alta | Controles da seção de segurança |
| Redes sociais bloqueiam o fetcher ou já removeram metadados | Média | Mensagem clara de "não foi possível analisar"; não prometer cobertura de todas as redes |
| Custo de APIs pagas e abuso por contas descartáveis | Média | Cotas, alertas de orçamento, limite por IP e captcha |
| Busca reversa e detectores de mídia sintética geram falsos positivos e negativos | Média | Mostrar como indicador, nunca como conclusão |
| Resultado perdido ao fechar a aba | Baixa | Aceito como consequência de não reter dados; relatório baixável |

**A confirmar antes de implementar**

- Limites de requisição, preço, retenção de dados e SLA da ExifTools, e onde ela processa os dados.
- Termos de uso comercial do Web Risk e da Safe Browsing.
- Exigência de faturamento no Firebase para encaminhar requisições ao Cloud Run.
- Enquadramento do projeto no Marco Civil (artigo 15) e necessidade de encarregado de dados na LGPD.
- Região do Cloud Run (preferir uma região no Brasil, se a latência e o preço forem aceitáveis).

## Plano de implementação

A implementação segue sete fases, e cada uma só termina quando seus testes passam no CI.

1. **Fundação.** Repositório com pastas web/ e api/, .npmrc endurecido, CI, arquivo CLAUDE.md, projeto Google Cloud com alertas de orçamento e projeto Firebase. Pronto quando o CI roda verde em um commit vazio.
2. **Esqueleto seguro.** API no Cloud Run que valida o ID token do Google; front mínimo com login, cabeçalhos e CSP. Pronto quando um usuário logado chama uma rota protegida e um token inválido é recusado.
3. **Fetcher seguro.** Validação de URL, proteção contra SSRF, extração de mídias, limites de tamanho e tempo. Pronto quando toda a bateria de testes de SSRF passa.
4. **ExifTools e relatório.** Integração EXIF e C2PA, agregador de sinais, streaming SSE e relatório JSON. Pronto quando uma página real gera um relatório completo.
5. **Demais checagens, uma por vez.** ClaimReview local, Fact Check, Web Risk e Cloud Vision, cada uma com sua chave, cota e alerta. Pronto quando cada plugin tem testes com respostas simuladas.
6. **Lançamento limitado.** PDF, política de privacidade e termos publicados, revisão jurídica, teste dos limites de uso e do custo por verificação. Pronto quando o advogado aprova e o custo por verificação está dentro do orçamento.
7. **Opcional.** Relatório assinado, análise de PDF e Office, plano B com ExifTool auto-hospedado.
