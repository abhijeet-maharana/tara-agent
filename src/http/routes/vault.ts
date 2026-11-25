import type { Vault } from '../../vault/vault.js';
import type { ServerContext } from '../context.js';
import { readJson, str } from '../io.js';
import { type Route, route } from '../router.js';

/**
 *   GET  /vault                  {on, problem?, logins, uses}: never a secret
 *   POST /vault                  {id, service, account?, loginUrl, sites?, projects, password?, totp?, clearTotp?, note?}
 *   POST /vault/<id>/delete
 *   POST /vault/<id>/reveal      → {account?, password, code?} (logged)
 * Every POST needs a person: an unlocked browser on another device (`c.human`), like decisions.
 */
export function vaultRoutes(c: ServerContext, vault: Vault): Route<unknown>[] {
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return [
    route('GET /vault', () => ({
      on: vault.on,
      ...(vault.problem && { problem: vault.problem }),
      logins: vault.list(),
      uses: vault.uses({ limit: 100 }),
    })),
    route('POST /vault', async ({ req }) => {
      const by = c.human(req);
      const body = await readJson(req);
      return vault.save(
        {
          id: str(body.id) ?? '',
          service: str(body.service) ?? '',
          account: str(body.account),
          loginUrl: str(body.loginUrl) ?? '',
          sites: list(body.sites),
          projects: list(body.projects).filter((p) => c.options.projects.includes(p)),
          password: typeof body.password === 'string' ? body.password : undefined,
          totp: str(body.totp),
          clearTotp: body.clearTotp === true,
          note: str(body.note)?.slice(0, 300),
        },
        by,
      );
    }),
    route('POST /vault/:id/delete', ({ req, params }) => {
      vault.delete(params.id ?? '', c.human(req));
      return { ok: true };
    }),
    route('POST /vault/:id/reveal', ({ req, params }) => vault.reveal(params.id ?? '', c.human(req))),
  ];
}
