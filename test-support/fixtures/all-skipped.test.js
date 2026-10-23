// Fixture do runner: todos os testes pulados. "pass" fica em 0; o runner precisa reprovar.
import { test } from "node:test";

test("pulado 1", { skip: "fixture: todos pulados" }, () => {});
test("pulado 2", { skip: "fixture: todos pulados" }, () => {});
