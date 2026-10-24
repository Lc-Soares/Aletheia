import { GoogleAuth, type IdTokenClient } from "google-auth-library";

export type ServiceTokenSource = () => Promise<string>;

// ID token da conta de serviço da API, com aud = FETCHER_AUDIENCE. No Cloud Run vem do servidor de
// metadados; em desenvolvimento, das credenciais padrão do gcloud com impersonação da mesma conta
// (docs/desenvolvimento-local.md). Não existe modo que pule a autenticação. O IdTokenClient guarda
// o token em cache e renova perto da expiração. O token nunca é logado.
export function createServiceTokenSource(audience: string, auth: GoogleAuth = new GoogleAuth()): ServiceTokenSource {
  let client: Promise<IdTokenClient> | null = null;
  return async () => {
    client ??= auth.getIdTokenClient(audience);
    try {
      const headers = await (await client).getRequestHeaders();
      const token = /^Bearer (\S+)$/.exec(headers.get("authorization") ?? "")?.[1];
      if (token === undefined) throw new Error("ID token ausente");
      return token;
    } catch (error) {
      client = null; // a próxima chamada tenta obter um cliente novo
      throw error;
    }
  };
}
