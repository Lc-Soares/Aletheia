# Política de Privacidade (minuta LGPD) – Aletheia

Oct 22, 2026 · @Lucas

## 1. Quem somos

> Minuta para revisão por advogado. Os trechos entre colchetes devem ser preenchidos ou confirmados antes da publicação. A seção final traz notas internas e deve ser removida.

Esta política explica como a plataforma \[NOME DA PLATAFORMA\] trata dados pessoais, de acordo com a Lei Geral de Proteção de Dados (Lei nº 13.709/2018, a LGPD).

- **Controlador:** \[NOME COMPLETO\], pessoa física, que opera a plataforma sem fins lucrativos, com contato em \[E-MAIL\] e domicílio em \[CIDADE E UF\].
- **Encarregado pelo tratamento de dados (DPO):** \[NOME\], disponível em \[E-MAIL DE CONTATO\].
- **O que a plataforma faz:** recebe o link de uma página que você informa, analisa as mídias dessa página (por exemplo, metadados e assinaturas de autenticidade) e mostra sinais de proveniência. O resultado não é um veredito sobre se o conteúdo é verdadeiro ou falso.

## 2. Quais dados tratamos

Tratamos somente os dados necessários para você entrar na plataforma, pedir uma análise e receber o resultado.

| Dado | Para que usamos | Base legal (LGPD, art. 7) | Por quanto tempo guardamos |
| --- | --- | --- | --- |
| Identificador e e-mail da sua conta Google | Confirmar quem você é e liberar o acesso | Execução do serviço que você solicitou (inciso V) | Não guardamos. Usados apenas durante a sessão. \[CONFIRMAR\] |
| Link que você informa | Buscar a página e analisar as mídias | Execução do serviço (inciso V) | Não guardamos. Processado na memória e descartado ao fim da análise. |
| Conteúdo da página e das mídias (podem conter dados como autor, data e localização) | Gerar os sinais de proveniência | Execução do serviço (inciso V) e legítimo interesse (inciso IX) \[VALIDAR\] | Não guardamos. Descartado ao fim da análise. |
| Endereço IP, data e hora do acesso | Segurança e prevenção de abuso | Legítimo interesse (inciso IX) \[VALIDAR\] | \[PRAZO CURTO, por exemplo 30 dias, a confirmar com advogado\] |
| Dados técnicos da requisição (tipo de navegador e dispositivo) | Funcionamento e segurança | Legítimo interesse (inciso IX) | Mesmo prazo do registro de acesso |

Não pedimos dados sensíveis, não vendemos seus dados e não os usamos para publicidade. \[CONFIRMAR\]

**Relatórios que você baixa.** O PDF ou JSON gerado fica somente no seu dispositivo. Ele pode conter dados extraídos das mídias, como o nome do autor ou a localização de uma foto, e a decisão de guardar ou compartilhar o arquivo é sua.

## 3. Como funciona o tratamento temporário

O link e o conteúdo da página existem apenas na memória do nosso servidor enquanto a análise acontece, e são apagados quando ela termina.

1. Você entra com sua conta Google.
2. Você informa o link. Nosso servidor acessa a página e baixa as mídias dela, uma única vez.
3. Enviamos as mídias aos serviços de análise listados na seção 4; o endereço da página só é enviado onde a tabela da seção 4 indica.
4. O resultado chega ao seu navegador, que monta o relatório.
5. Nosso servidor descarta tudo. Não guardamos o link, as mídias nem o resultado.

**O que ainda pode ficar registrado.** O endereço IP e a data e hora do acesso podem constar em registros técnicos, conforme a seção 2. Esses registros não incluem o link que você analisou. Os serviços de terceiros listados abaixo também podem manter dados conforme suas próprias políticas. Por isso, dizemos que nós não armazenamos o seu conteúdo, e não que ninguém o armazena.

## 4. Com quem compartilhamos e transferência internacional

Compartilhamos dados apenas com os fornecedores que executam partes da análise, e cada um recebe somente o que precisa para isso.

| Fornecedor | Função | O que recebe | Onde processa |
| --- | --- | --- | --- |
| Google (Firebase Hosting, Cloud Run, Google Identity) | Hospedagem da plataforma e login | Dados da sua conta usados no login, IP e dados técnicos da requisição | \[CONFIRMAR PAÍSES E REGIÃO\] |
| Google Cloud Vision | Busca reversa de imagens | Imagem extraída da página | \[CONFIRMAR\] |
| Google Web Risk | Verificar se o link é malicioso | Endereço da página | \[CONFIRMAR\] |
| Google Fact Check Tools | Buscar checagens já publicadas | Texto da afirmação extraído da página | \[CONFIRMAR\] |
| ExifTools | Leitura de metadados e verificação de assinaturas de autenticidade (C2PA) | O arquivo da mídia (nunca o endereço) | \[CONFIRMAR PAÍS\] |
| Site analisado | Origem do conteúdo | Nosso servidor acessa a página que você informou, e o site pode registrar esse acesso | Conforme o próprio site |

Podem ser acionados outros fornecedores no futuro, e esta política será atualizada nesse caso.

**Transferência internacional.** Alguns desses fornecedores podem tratar dados fora do Brasil. Quando isso ocorrer, a transferência será feita conforme o artigo 33 da LGPD, com \[MECANISMO ADOTADO, A DEFINIR COM ASSESSORIA JURÍDICA\].

**Outros compartilhamentos.** Não vendemos dados. Só os compartilharemos com autoridades quando houver obrigação legal ou ordem judicial.

## 5. Seus direitos

Você pode pedir, a qualquer momento, que informemos o que fazemos com os seus dados, nos termos do artigo 18 da LGPD:

- confirmação de que tratamos dados seus;
- acesso aos dados;
- correção de dados incompletos, inexatos ou desatualizados;
- anonimização, bloqueio ou eliminação de dados desnecessários, excessivos ou tratados em desconformidade com a lei;
- portabilidade dos dados;
- eliminação dos dados tratados com base em consentimento, quando houver;
- informação sobre com quem compartilhamos seus dados;
- informação sobre a possibilidade de não dar consentimento e suas consequências;
- revogação do consentimento, quando essa for a base legal;
- oposição a um tratamento feito sem consentimento, se você entender que ele descumpre a lei.

**Como pedir.** Escreva para \[E-MAIL DO ENCARREGADO\]. Podemos pedir informações para confirmar que o pedido é seu.

**Prazo.** A confirmação de que tratamos dados seus é dada imediatamente, em formato simplificado, ou em até 15 dias, em declaração completa. Como não guardamos o link nem o conteúdo que você analisa, na maior parte dos casos só teremos registros técnicos (seção 2) para informar ou eliminar.

**Reclamações.** Você também pode peticionar à Autoridade Nacional de Proteção de Dados (ANPD).

## 6. Segurança, incidentes e cookies

Adotamos medidas técnicas e administrativas para proteger os dados contra acesso não autorizado, nos termos do artigo 46 da LGPD.

- **Medidas técnicas.** Conexão criptografada (HTTPS); validação do seu login no servidor; isolamento do componente que acessa páginas externas; limites de uso para evitar abuso; chaves de acesso guardadas em serviço de gestão de segredos; processamento sem gravação em disco ou banco de dados.
- **Incidentes.** Se ocorrer um incidente de segurança que possa causar risco ou dano relevante a você, comunicaremos a você e à ANPD, conforme o artigo 48 da LGPD.
- **Cookies e armazenamento local.** Usamos apenas o armazenamento estritamente necessário para o funcionamento do login e da plataforma. Não usamos cookies de publicidade nem de rastreamento. \[CONFIRMAR se o Firebase Hosting ou o Google Identity gravam cookies ou armazenamento local, e, se gravarem, listar aqui\].

## 7. Crianças e adolescentes, alterações e contato

**Crianças e adolescentes.** A plataforma é destinada a pessoas com \[18 ANOS OU MAIS, A DEFINIR\]. Não coletamos intencionalmente dados de crianças e adolescentes. Se soubermos que isso ocorreu, apagaremos os dados, conforme o artigo 14 da LGPD.

**Alterações desta política.** Podemos atualizar este texto. A versão vigente mostra a data da última atualização, \[DATA\]. Mudanças relevantes serão avisadas na própria plataforma.

**Contato.** Dúvidas e pedidos sobre seus dados: \[E-MAIL DO ENCARREGADO\].

**Autoridade Nacional de Proteção de Dados (ANPD).** Informações e canal de petições em gov.br/anpd.

## 8. Notas para revisão jurídica (remover antes de publicar)

Estas notas apontam as decisões que dependem de um advogado e das informações de fornecedores. Eu não sou advogado e esta minuta não substitui assessoria jurídica.

1. **Registros de acesso (Marco Civil da Internet, art. 15).** O artigo 15 impõe a guarda de registros de acesso por 6 meses a provedores constituídos como pessoa jurídica, com atividade organizada, profissional e com fins econômicos. Como o projeto será de pessoa física e sem fins lucrativos, em princípio essa obrigação não se aplica, mas uma ordem judicial pode exigir a guarda de registros sobre fatos específicos. Confirmar o enquadramento com advogado e manter o prazo curto de registros na seção 2.
2. **Bases legais.** Confirmar se execução de contrato (art. 7, V) e legítimo interesse (art. 7, IX) são as bases corretas. As mídias podem conter dados de terceiros (autor, localização); avaliar um teste de legítimo interesse documentado.
3. **Encarregado (art. 41).** Verificar se o projeto se enquadra em regras de simplificação da ANPD para agentes de pequeno porte e quais obrigações permanecem. Um canal de contato do titular continua necessário. A LGPD continua valendo para pessoa física quando a plataforma é aberta ao público: a exceção do artigo 4º (uso exclusivamente particular e não econômico) não cobre este caso, e "sem fins lucrativos" também não afasta a lei. A pessoa física responde com o patrimônio pessoal; avaliar formalizar a operação (por exemplo, como associação) se o projeto crescer.
4. **Transferência internacional (art. 33).** Definir o mecanismo, confirmar onde cada fornecedor processa os dados e revisar os contratos de tratamento de dados de cada um (por exemplo, o aditivo de processamento do Google Cloud).
5. **ExifTools.** A documentação pública não informa retenção, local de processamento nem suboperadores. Pedir os termos antes de afirmar qualquer coisa além de "não armazenamos" no nosso sistema.
6. **Registro das operações (art. 37) e relatório de impacto.** Mesmo sem armazenamento, manter o registro das operações de tratamento e avaliar se é preciso um relatório de impacto à proteção de dados.
7. **Termos de uso.** Redigir à parte: natureza dos relatórios (sinais, não veredictos), uso aceitável, limitação de responsabilidade e idade mínima.
8. **Coerência com o sistema.** Qualquer mudança técnica que passe a guardar dados (histórico, banco, logs com URL) exige atualizar esta política antes de ir ao ar.
9. **Geocodificação pela ExifTools (pendência de 24/10/2026).** A resposta da ExifTools inclui `address` e `addressPlusCode`, um endereço derivado das coordenadas GPS do arquivo. A API descarta esses campos e nunca os mostra, mas não sabemos se a ExifTools usa um terceiro para fazer essa geocodificação, o que seria mais um suboperador recebendo a localização. Avaliar na revisão jurídica e, se possível, perguntar à ExifTools. Esta nota não altera o texto publicado acima.
