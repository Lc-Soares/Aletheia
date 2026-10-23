// Reporter de contagem usado por run-tests.js ao lado do spec. Conta só testes de verdade: para um
// arquivo sem nenhum test(), o node:test emite um test:pass com o nome do próprio arquivo (o
// "invólucro" do arquivo), que conta como 1 teste no resumo e esconderia o arquivo vazio.
// No fim escreve uma única linha no stderr, com COUNT_PREFIX, que o runner lê e não repassa.
import { resolve } from "node:path";

export const COUNT_PREFIX = "aletheia-test-count ";

export default async function* countReporter(source) {
  const testsPerFile = new Map();
  let real = 0;
  let passed = 0;
  for await (const event of source) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const { name, file, details, skip, todo } = event.data;
    if (details?.type === "suite") continue;
    if (file !== undefined && !testsPerFile.has(file)) testsPerFile.set(file, 0);
    // Invólucro: o nome, resolvido a partir do diretório atual, é o próprio arquivo do evento.
    if (file !== undefined && resolve(name) === resolve(file)) continue;
    real++;
    if (file !== undefined) testsPerFile.set(file, (testsPerFile.get(file) ?? 0) + 1);
    if (event.type === "test:pass" && !skip && !todo) passed++;
  }
  const emptyFiles = [...testsPerFile].filter(([, count]) => count === 0).map(([file]) => file);
  yield `${COUNT_PREFIX}${JSON.stringify({ real, passed, emptyFiles })}\n`;
}
