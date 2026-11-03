// One signing format for every signed call between n8n and Workers, and between Workers (docs/PATTERN.md section 6):
//   x-jbx-ts:  ms since epoch (13 digits)
//   x-jbx-sig: hex HMAC-SHA256(PUSH_SECRET, purpose + '.v1.' + ts + '.' + path + '.' + body)
// purpose names the use (e.g. 'jbxsync', 'jbxingest'), so a signature made for one use is refused by another. The path
// and the raw body are signed, so a signature for one path or body is refused for another. ts within 120 s.
import { hmacHex, timingSafeEq } from '../../crypto/src/index.ts';

export const TS_HEADER = 'x-jbx-ts';
export const SIG_HEADER = 'x-jbx-sig';
export const PUSH_WINDOW_MS = 120 * 1000;

const PURPOSE_RE = /^[a-z][a-z0-9_.-]{1,40}$/;

export async function signPush(secret: string, purpose: string, path: string, body: string, now = Date.now()): Promise<{ ts: string; sig: string; headers: Record<string, string> }> {
  if (!secret) throw new Error('push-sign: no secret');
  if (!PURPOSE_RE.test(purpose)) throw new Error('push-sign: bad purpose');
  const ts = String(now);
  const sig = await hmacHex(secret, `${purpose}.v1.${ts}.${path}.${body}`);
  return { ts, sig, headers: { [TS_HEADER]: ts, [SIG_HEADER]: sig } };
}

export type PushWhy = 'not_configured' | 'missing' | 'timestamp' | 'old' | 'signature' | 'purpose';

export async function verifyPush(
  got: { ts?: string | null; sig?: string | null },
  secret: string | undefined, purpose: string, path: string, body: string,
  opt: { now?: number; windowMs?: number } = {},
): Promise<{ ok: true } | { ok: false; why: PushWhy }> {
  if (!secret) return { ok: false, why: 'not_configured' };
  if (!PURPOSE_RE.test(purpose)) return { ok: false, why: 'purpose' };
  if (!got.ts || !got.sig) return { ok: false, why: 'missing' };
  if (!/^\d{13}$/.test(got.ts)) return { ok: false, why: 'timestamp' };
  if (Math.abs((opt.now ?? Date.now()) - Number(got.ts)) > (opt.windowMs ?? PUSH_WINDOW_MS)) return { ok: false, why: 'old' };
  const want = await hmacHex(secret, `${purpose}.v1.${got.ts}.${path}.${body}`);
  return timingSafeEq(String(got.sig), want) ? { ok: true } : { ok: false, why: 'signature' };
}

// Reads the two headers and the raw body from a Request and verifies them. The body is returned so the caller does not
// read it twice.
export async function verifyPushRequest(req: Request, secret: string | undefined, purpose: string, opt: { now?: number; windowMs?: number } = {}) {
  const body = await req.text();
  const path = new URL(req.url).pathname;
  const res = await verifyPush({ ts: req.headers.get(TS_HEADER), sig: req.headers.get(SIG_HEADER) }, secret, purpose, path, body, opt);
  return Object.assign({}, res, { body });
}
