// Entry point: start the forge, then either join a make.fun trial
// (MAKEFUN_ENV_URL is set: bind an ephemeral port, POST it to /register,
// long-poll GET /done until the suite finishes, exit 0) or run standalone
// for local development (PORT, default 8080).
//
//   node main.ts
//
// The server needs no arguments: the bearer token comes from
// MAKEFUN_SHOP_TOKEN (empty in dev mode accepts any non-empty token), and
// dates come from the logical clock seeded by MAKEFUN_TRIAL_NOW when the
// trial provides one.

import { Forge } from './src/store.ts';
import { createForgeServer } from './src/server.ts';

const DONE_POLL_MS = 500;
const REGISTER_ATTEMPTS = 30;
const REGISTER_RETRY_MS = 500;
// The boot budget is 20 s, so registration must give up well inside it:
// a slow env would otherwise eat the whole budget on retries.
const REGISTER_BUDGET_MS = 15000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function envUrl(): string | null {
  const raw = process.env.MAKEFUN_ENV_URL;
  if (raw === undefined || raw === '') return null;
  return raw.replace(/\/+$/, '');
}

async function register(env: string, port: number): Promise<void> {
  let lastError: unknown = null;
  const deadline = Date.now() + REGISTER_BUDGET_MS;
  for (let attempt = 1; attempt <= REGISTER_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${env}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(5000),
      });
      if (response.status === 200) {
        console.log(`registered port ${port} with the trial env`);
        return;
      }
      if (response.status === 409) throw new Error('another entry already registered');
      lastError = new Error(`register answered HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    if (attempt < REGISTER_ATTEMPTS && Date.now() < deadline) await sleep(REGISTER_RETRY_MS);
    else if (Date.now() >= deadline) break;
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function waitForDone(env: string): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`${env}/done`, { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is briefly unreachable; keep polling.
    }
    await sleep(DONE_POLL_MS);
  }
}

async function main(): Promise<void> {
  const forge = new Forge();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const server = createForgeServer(forge, { token });
  const env = envUrl();

  let shuttingDown = false;
  const shutdown = (code: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(() => process.exit(code));
    setTimeout(() => process.exit(code), 2000).unref();
  };
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));

  if (env === null) {
    const port = Number(process.env.PORT ?? 8080);
    await new Promise<void>((resolve) => server.listen(port, '0.0.0.0', resolve));
    console.log(`forge listening on http://127.0.0.1:${port} (dev mode; MAKEFUN_ENV_URL is unset)`);
    return;
  }

  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind a port');
  const port = address.port;
  await register(env, port);
  await waitForDone(env);
  console.log('the suite is done; exiting');
  shutdown(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
