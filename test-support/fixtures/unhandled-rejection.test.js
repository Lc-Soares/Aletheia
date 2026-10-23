// Fixture do runner: o teste passa, mas deixa uma rejeição sem tratamento DE PROPÓSITO depois de
// terminar. Prova que o runner continua carregando o guarda (fail-on-unhandled-rejection.js).
import { test } from "node:test";

test("passa e deixa uma rejeição solta depois", () => {
  setTimeout(() => void Promise.reject(new Error("rejeição deliberada da fixture")), 10);
});
