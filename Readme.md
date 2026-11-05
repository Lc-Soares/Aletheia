**Este é um projeto para a matéria de Laboratório de Inovação 2**

O objetivo é criar um portal de apoio à checagem de fatos. A pessoa entra com a conta Google, cola na barra de pesquisa o link de uma matéria e recebe um relatório de sinais.

O portal consulta ferramentas e referências já existentes e mostra, para as imagens da página (e, em parte, os vídeos), se há metadados, localização, autoria declarada e assinatura de autenticidade (C2PA), incluindo a marcação de IA quando o arquivo a traz. A verificação do C2PA com arquivos reais ainda está em andamento. Está planejado também mostrar se outros sites ou plataformas abordam o mesmo assunto e se já existem checagens publicadas sobre ele.

O Aletheia **não diz se a matéria é verdadeira ou falsa** e **não tenta adivinhar se um texto ou uma imagem foi gerado por IA**, porque nenhuma ferramenta faz isso de forma confiável. Cada sinal vem com suas limitações, e a conclusão fica com quem lê. Não há banco de dados nem arquivos guardados: os dados da análise existem só na memória. Registros técnicos (como IP, data e hora) podem ser mantidos, conforme a política de privacidade.

Estado atual: primeiro deploy fechado no ar, com login, análise de mídias e relatório. Os detalhes técnicos estão em `docs/`.
