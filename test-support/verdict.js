// Decisão do runner (run-tests.js), separada para poder ser testada. Falha fechado: se o resumo do
// spec ou a linha do count-reporter faltarem, ou indicarem que nenhum teste rodou de verdade
// (nenhum evento recebido, total 0, nenhum passou), a execução reprova.
import { stripVTControlCharacters } from "node:util";

// Último valor de "ℹ <nome> <n>" no resumo do spec, depois de tirar as cores (FORCE_COLOR no CI).
function lastCount(lines, name) {
  const pattern = new RegExp(`^ℹ ${name} (\\d+)$`);
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = pattern.exec(lines[i] ?? "");
    if (match) return Number(match[1]);
  }
  return null;
}

export function specSummary(output) {
  const lines = stripVTControlCharacters(output)
    .split(/\r?\n/)
    .map((line) => line.trim());
  return { tests: lastCount(lines, "tests"), pass: lastCount(lines, "pass") };
}

// count: o objeto da linha do count-reporter, ou null se ela não chegou.
export function verdict(summary, count) {
  const { tests, pass } = summary;
  if (tests === null || pass === null || tests === 0 || pass < 1) return { ok: false, emptyFiles: [] };
  if (count === null || count.real === 0 || count.passed < 1) return { ok: false, emptyFiles: [] };
  if (count.emptyFiles.length > 0) return { ok: false, emptyFiles: count.emptyFiles };
  return { ok: true, emptyFiles: [] };
}
