import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { createUi } from "../public/render.js";

/** Elemento falso: só guarda textContent. Qualquer uso de innerHTML falha o teste. */
function fakeElement() {
  return {
    textContent: "",
    hidden: false,
    set innerHTML(/** @type {string} */ _value) {
      throw new Error("innerHTML não pode ser usado");
    },
  };
}

describe("render", () => {
  test("e-mail vindo da API é exibido como texto, sem interpretar HTML", () => {
    const status = fakeElement();
    const hostile = '<img src=x onerror="alert(1)">@example.com';
    createUi({ status, signin: fakeElement() }).showEmail(hostile);
    assert.ok(status.textContent?.includes(hostile));
  });

  test("mensagens de expiração e erro não incluem dados externos", () => {
    const status = fakeElement();
    const ui = createUi({ status, signin: fakeElement() });
    ui.showExpired();
    assert.match(String(status.textContent), /expirou/i);
    ui.showError();
    assert.match(String(status.textContent), /não foi possível/i);
  });
});

describe("código do front-end (varredura do código-fonte)", () => {
  const dir = new URL("../public/", import.meta.url);
  /** @type {Array<[string, string]>} */
  const sources = readdirSync(dir)
    .filter((f) => f.endsWith(".js") || f.endsWith(".html"))
    .map((f) => [f, readFileSync(new URL(f, dir), "utf8")]);

  test("há arquivos para varrer", () => {
    assert.ok(sources.length >= 4);
  });

  for (const [file, text] of sources) {
    test(`${file}: sem innerHTML, outerHTML, insertAdjacentHTML, document.write ou eval`, () => {
      assert.doesNotMatch(text, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/);
    });

    test(`${file}: o token não vai para localStorage, sessionStorage, cookie ou IndexedDB`, () => {
      assert.doesNotMatch(text, /localStorage|sessionStorage|document\.cookie|indexedDB/);
    });

    test(`${file}: sem script ou estilo inline (CSP sem unsafe-inline)`, () => {
      if (!file.endsWith(".html")) return;
      assert.doesNotMatch(text, /<script(?![^>]*\bsrc=)[^>]*>/i);
      assert.doesNotMatch(text, /<style|\sstyle=|\sonclick=|\sonload=/i);
    });
  }
});
