import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { FETCHER_CATEGORIES } from "./fetcher-contract.ts";
import { fetchErrorView, rateLimitedMessage, USER_MESSAGES } from "./messages.ts";

describe("mensagens ao usuário", () => {
  test("blocked, network e timeout viram exatamente a mesma resposta (sem enumerar nomes internos)", () => {
    const views = ["blocked", "network", "timeout"].map((category) => JSON.stringify(fetchErrorView(category as never)));
    assert.equal(new Set(views).size, 1);
    assert.deepEqual(JSON.parse(views[0] ?? ""), { error: "unreachable", message: "Não foi possível acessar este endereço." });
  });

  test("upstream_status mostra o código HTTP só quando é inteiro de 100 a 599", () => {
    assert.deepEqual(fetchErrorView("upstream_status", 403), {
      error: "upstream_status",
      message: "O site respondeu com erro (HTTP 403).",
      httpStatus: 403,
    });
    for (const bad of [99, 600, 403.5, Number.NaN, undefined]) {
      assert.deepEqual(fetchErrorView("upstream_status", bad), { error: "upstream_status", message: "O site respondeu com erro." });
    }
  });

  test("httpStatus nunca aparece fora de upstream_status", () => {
    for (const category of FETCHER_CATEGORIES) {
      if (category === "upstream_status") continue;
      assert.equal("httpStatus" in fetchErrorView(category, 403), false, category);
    }
  });

  test("toda categoria tem mensagem em português e nenhuma revela a categoria interna", () => {
    for (const category of FETCHER_CATEGORIES) {
      const { message } = fetchErrorView(category);
      assert.ok(message.length > 0);
      for (const internal of ["blocked", "network", "timeout", "DNS", "IP"]) assert.equal(message.includes(internal), false, `${category}: ${message}`);
    }
  });

  test("mensagens fixas", () => {
    assert.equal(USER_MESSAGES.busy, "Serviço ocupado, tente novamente em instantes.");
    assert.equal(USER_MESSAGES.internal, "Não foi possível concluir a análise. Tente novamente.");
    assert.equal(USER_MESSAGES.timeout, "A análise demorou demais. Tente novamente.");
  });

  test("limite estourado: mensagem clara com o limite e os minutos", () => {
    assert.equal(rateLimitedMessage(10, 50 * 60), "Você atingiu o limite de 10 verificações por hora. Tente novamente em 50 minutos.");
    assert.equal(rateLimitedMessage(10, 30), "Você atingiu o limite de 10 verificações por hora. Tente novamente em 1 minuto.");
    assert.equal(rateLimitedMessage(10, 61), "Você atingiu o limite de 10 verificações por hora. Tente novamente em 2 minutos.");
  });
});
