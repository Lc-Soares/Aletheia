// Todo texto que vem da API entra na página por textContent, nunca como HTML.

/**
 * @param {{ status: { textContent: string | null }, signin: { hidden: boolean | string } }} elements
 */
export function createUi({ status, signin }) {
  return {
    /** @param {string} email */
    showEmail(email) {
      status.textContent = `Conectado como ${email}`;
      signin.hidden = true;
    },
    showExpired() {
      status.textContent = "Sua sessão expirou. Entre novamente com o Google.";
      signin.hidden = false;
    },
    showError() {
      status.textContent = "Não foi possível concluir a verificação. Tente novamente.";
    },
  };
}
