// GET /health, the same shape on every Worker (docs/PATTERN.md section 6). Never a value: only booleans saying whether a
// secret is set and a binding is present.
//   { ok, worker, version, configured: { <name>: bool }, bound: { <name>: bool }, ...extra }
export interface HealthInput {
  worker: string;                       // the Worker's name (a toml var, e.g. WORKER_NAME)
  version?: string;                     // release version, e.g. 'v3'
  configured?: Record<string, unknown>; // secret name -> value; reported as !!value
  bound?: Record<string, unknown>;      // binding name -> binding; reported as !!binding
  ok?: boolean;                         // default true
  extra?: Record<string, unknown>;      // other non-secret facts (counts, switches)
}

export function healthBody(h: HealthInput) {
  const flags = (o?: Record<string, unknown>) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, !!v]));
  return Object.assign({ ok: h.ok ?? true, worker: h.worker, version: h.version || '', configured: flags(h.configured), bound: flags(h.bound) }, h.extra || {});
}

export function healthResponse(h: HealthInput): Response {
  return new Response(JSON.stringify(healthBody(h)), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
  });
}
