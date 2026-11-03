// The front door's pass, x-door-identity (docs/PATTERN.md section 8):
//   v1.<b64url(JSON{ e, r, rs, iat, p })>.<hex HMAC-SHA256(DOOR_SECRET, 'jbxid.' + payload)>
// e = email, r = main role, rs = roles, iat = ms, p = the door-side path the pass was signed for.
// Every Worker behind the door verifies it with its own DOOR_SECRET (one value per target) and fails closed.
// The door checks roles; a Worker may check them again with `roles`.
import { hmacHex, timingSafeEq, b64urlEncode, b64urlDecode } from '../../crypto/src/index.ts';

export const DOOR_PASS_HEADER = 'x-door-identity';
export const DOOR_PASS_MAX_AGE_MS = 5 * 60 * 1000;

export interface DoorIdentity { e: string; r: string; rs: string[]; iat: number; p: string }
export type DoorPassResult = { ok: true; ident: DoorIdentity } | { ok: false; why: DoorPassWhy };
export type DoorPassWhy = 'not_configured' | 'missing' | 'format' | 'signature' | 'payload' | 'age' | 'path' | 'role';

export interface VerifyOptions {
  path: string;            // the path this request is for; must equal the pass's p
  now?: number;            // ms, for tests
  maxAgeMs?: number;       // default 5 minutes
  roles?: string[];        // if given, the pass must hold at least one
}

export async function verifyDoorPass(header: string | null | undefined, secret: string | undefined, opt: VerifyOptions): Promise<DoorPassResult> {
  if (!secret) return { ok: false, why: 'not_configured' };
  if (!header) return { ok: false, why: 'missing' };
  const parts = String(header).split('.');
  if (parts.length !== 3 || parts[0] !== 'v1' || !parts[1] || !/^[0-9a-f]{64}$/.test(parts[2])) return { ok: false, why: 'format' };
  const want = await hmacHex(secret, 'jbxid.' + parts[1]);
  if (!timingSafeEq(parts[2], want)) return { ok: false, why: 'signature' };
  let p: any = null;
  try { p = JSON.parse(b64urlDecode(parts[1])); } catch { p = null; }
  if (!p || typeof p.e !== 'string' || !p.e || typeof p.p !== 'string' || !Number.isFinite(Number(p.iat))) return { ok: false, why: 'payload' };
  const now = opt.now ?? Date.now();
  if (Math.abs(now - Number(p.iat)) > (opt.maxAgeMs ?? DOOR_PASS_MAX_AGE_MS)) return { ok: false, why: 'age' };
  if (p.p !== opt.path) return { ok: false, why: 'path' };
  const ident: DoorIdentity = { e: p.e, r: String(p.r || ''), rs: Array.isArray(p.rs) ? p.rs.map(String) : [], iat: Number(p.iat), p: p.p };
  if (opt.roles && !ident.rs.some(r => opt.roles!.includes(r))) return { ok: false, why: 'role' };
  return { ok: true, ident };
}

// Signs a pass as the door does. For the door itself and for tests; Workers never sign passes.
export async function signDoorPass(secret: string, ident: { e: string; r?: string; rs?: string[] }, path: string, now = Date.now()): Promise<string> {
  const payload = b64urlEncode(JSON.stringify({ e: ident.e, r: ident.r || '', rs: ident.rs || [], iat: now, p: path }));
  return 'v1.' + payload + '.' + await hmacHex(secret, 'jbxid.' + payload);
}
