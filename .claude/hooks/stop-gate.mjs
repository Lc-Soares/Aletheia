#!/usr/bin/env node
// Stop gate: impede o Claude Code de encerrar uma tarefa enquanto `npm run check` falhar.
// Bloqueia no máximo MAX_ATTEMPTS vezes seguidas, para nunca entrar em loop infinito.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_ATTEMPTS = 3;
const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const stateDir = join(root, '.claude', 'state');
const counterFile = join(stateDir, 'stop-gate-attempts');

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let payload = {};
try {
  payload = JSON.parse(raw);
} catch {
  // sem payload legível: segue com os valores padrão
}

const readAttempts = () => {
  try {
    return Number(readFileSync(counterFile, 'utf8')) || 0;
  } catch {
    return 0;
  }
};
const resetAttempts = () => rmSync(counterFile, { force: true });

// Nova resposta (não é uma continuação forçada por este hook): zera o contador.
if (!payload.stop_hook_active) resetAttempts();

// Sem projeto Node ou sem o script "check": ainda não há o que verificar.
const pkgPath = join(root, 'package.json');
if (!existsSync(pkgPath)) process.exit(0);
let hasCheck = false;
try {
  hasCheck = Boolean(JSON.parse(readFileSync(pkgPath, 'utf8')).scripts?.check);
} catch {
  // package.json inválido: deixa o próprio npm reclamar em outra etapa
}
if (!hasCheck) process.exit(0);

// Repositório git sem nenhuma alteração: não há o que verificar de novo.
const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
if (status.status === 0 && status.stdout.trim() === '') process.exit(0);

// Comando em texto único, com shell: no Windows o npm é um atalho .cmd, que o Node não executa sem shell.
const run = spawnSync('npm run --silent check', {
  shell: true,
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
  timeout: 10 * 60 * 1000,
});

if (run.error) {
  console.error(`stop-gate: não foi possível executar "npm run check": ${run.error.message}`);
  process.exit(0);
}
if (run.status === 0) {
  resetAttempts();
  process.exit(0);
}

const attempts = readAttempts() + 1;
if (attempts > MAX_ATTEMPTS) {
  resetAttempts();
  console.error(`stop-gate: "npm run check" ainda falha após ${MAX_ATTEMPTS} tentativas; liberando para o usuário decidir.`);
  process.exit(0);
}
mkdirSync(stateDir, { recursive: true });
writeFileSync(counterFile, String(attempts));

const tail = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.trim().split('\n').slice(-80).join('\n');
console.log(
  JSON.stringify({
    decision: 'block',
    reason:
      `"npm run check" falhou (tentativa ${attempts} de ${MAX_ATTEMPTS}). ` +
      `Corrija a causa, sem apagar nem enfraquecer testes, e rode de novo antes de concluir.\n\n${tail}`,
  }),
);
process.exit(0);
