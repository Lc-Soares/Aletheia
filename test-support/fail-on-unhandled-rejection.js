// Carregado com --import pelos scripts de teste de todos os workspaces (package.json de api, web e
// fetcher). Qualquer unhandled rejection, dentro de um teste ou depois que ele terminou, reprova a
// execução: em produção ela derrubaria o processo (Node 24: --unhandled-rejections=throw).
// O node:test já reprova a maioria desses casos, mas o comportamento depende de detalhes do runner;
// este guarda torna a regra explícita. Só existe nos testes: nenhum Dockerfile copia esta pasta, e
// o código de produção não tem handler global de unhandledRejection.
process.on("unhandledRejection", (reason) => {
  process.exitCode = 1;
  const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  console.error(`Teste reprovado: unhandled rejection\n${detail}`);
});
