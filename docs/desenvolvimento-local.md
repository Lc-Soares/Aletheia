# Desenvolvimento local

Roda web e API juntos, na mesma origem, sem `firebase-tools`.

1. Terminal 1 (API). As variáveis vêm do seu ambiente; os nomes estão em `api/.env.example`:
   `GOOGLE_CLIENT_ID=<id do cliente OAuth> PORT=8080 npm start -w api`
2. Terminal 2 (web + proxy): `npm run dev -w web`
3. Abra `http://localhost:5000`.

O proxy (`web/dev-proxy.mjs`) serve `web/public`, encaminha `/api/**` para a API (porta `API_PORT`, padrão 8080) e aplica os cabeçalhos do `firebase.json`, inclusive a CSP. Escuta só em 127.0.0.1. A porta do proxy muda com `DEV_PORT`.

## Origens a autorizar no cliente OAuth (Google Cloud Console)

Em "Origens JavaScript autorizadas", adicione (a documentação do GIS pede as duas para desenvolvimento local):

- `http://localhost`
- `http://localhost:5000` (ou a porta de `DEV_PORT`)

Em produção, apenas a origem exata do Firebase Hosting (`https://<projeto>.web.app`).

## Renovação do ID token

A documentação do Google Identity Services diz que o ID token dura 1 hora, que um token expirado não significa usuário deslogado e que a sessão é responsabilidade do app. Ela não descreve uma chamada de "renovar". O front, ao receber 401, chama `google.accounts.id.prompt()` e usa o novo credential entregue ao callback (o Google devolve sem interação se o usuário já consentiu). Se o prompt não for exibido ou for dispensado, a tela pede novo login. Esse comportamento ainda não foi validado com o Google real.
