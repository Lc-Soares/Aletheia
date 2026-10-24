import { createHmac, randomBytes } from "node:crypto";

// Contador em memória, por instância (ver docs/api.md): uma aproximação aceitável para
// demonstração, com o deploy limitado a poucas instâncias. Nada é gravado.
export type RateLimiterOptions = {
  windowMs: number;
  maxKeys?: number; // teto de chaves; cheio e sem nada expirado, recusa chave nova (falha fechada)
  sweepIntervalMs?: number;
  now?: () => number;
};

export type Admission =
  | { allowed: true; release: () => void }
  | { allowed: false; reason: "limit" | "full"; retryAfterSeconds: number };

const DEFAULT_MAX_KEYS = 10_000;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const FULL_RETRY_AFTER_SECONDS = 60;

// Chave aleatória gerada na inicialização e nunca gravada: o mapa guarda só o HMAC do sub.
const USER_KEY_SECRET = randomBytes(32);

export function userKey(sub: string): string {
  return createHmac("sha256", USER_KEY_SECRET).update(sub).digest("hex");
}

// Janela deslizante por registro: cada chave guarda os instantes das checagens aceitas dentro da
// janela, no máximo o limite do plano.
export class RateLimiter {
  readonly #entries = new Map<string, number[]>();
  readonly #windowMs: number;
  readonly #maxKeys: number;
  readonly #sweepIntervalMs: number;
  readonly #now: () => number;
  #lastSweep: number;

  constructor(options: RateLimiterOptions) {
    this.#windowMs = options.windowMs;
    this.#maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
    this.#sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.#now = options.now ?? Date.now;
    this.#lastSweep = this.#now();
  }

  get trackedKeys(): number {
    return this.#entries.size;
  }

  consume(key: string, limit: number): Admission {
    const now = this.#now();
    if (now - this.#lastSweep >= this.#sweepIntervalMs) this.#sweep(now);
    const recent = (this.#entries.get(key) ?? []).filter((at) => at > now - this.#windowMs);
    const oldest = recent[0];
    if (oldest !== undefined && recent.length >= limit) {
      this.#entries.set(key, recent);
      return { allowed: false, reason: "limit", retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.#windowMs - now) / 1000)) };
    }
    if (recent.length === 0 && !this.#entries.has(key) && this.#entries.size >= this.#maxKeys) {
      this.#sweep(now);
      if (this.#entries.size >= this.#maxKeys) return { allowed: false, reason: "full", retryAfterSeconds: FULL_RETRY_AFTER_SECONDS };
    }
    recent.push(now);
    this.#entries.set(key, recent);
    return { allowed: true, release: this.#releaser(key, now) };
  }

  // Devolve a vaga uma única vez (por exemplo, quando o fetcher estava ocupado e nada foi buscado).
  #releaser(key: string, at: number): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const times = this.#entries.get(key);
      const index = times?.indexOf(at) ?? -1;
      if (times === undefined || index < 0) return;
      times.splice(index, 1);
      if (times.length === 0) this.#entries.delete(key);
    };
  }

  #sweep(now: number): void {
    this.#lastSweep = now;
    for (const [key, times] of this.#entries) {
      const newest = times.at(-1);
      if (newest === undefined || newest <= now - this.#windowMs) this.#entries.delete(key);
    }
  }
}
