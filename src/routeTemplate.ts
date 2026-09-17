/**
 * Collapse a concrete pathname to a route TEMPLATE so /guests/abc and /guests/def
 * dedupe to one sample. Pure — the testable heart of bounded discovery.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALL_DIGITS_RE = /^\d+$/;
const HEX_RE = /^[0-9a-f]{12,}$/i;
// cuid/objectId-ish: long contiguous token mixing letters and digits.
// Hyphenated slugs like "summer-sale-2024" should stay semantic, not collapse to [id].
const OPAQUE_ID_RE = /^[A-Za-z0-9]{12,}$/;

function isDynamicSegment(rawSeg: string): boolean {
  let seg = rawSeg;
  try {
    seg = decodeURIComponent(rawSeg);
  } catch {
    /* keep raw */
  }
  if (UUID_RE.test(seg)) return true;
  if (ALL_DIGITS_RE.test(seg)) return true;
  if (HEX_RE.test(seg)) return true;
  // Long opaque token that contains at least one digit (avoids flagging long slug words).
  if (OPAQUE_ID_RE.test(seg) && /\d/.test(seg)) return true;
  return false;
}

export function toRouteTemplate(pathname: string): string {
  const clean = pathname.split('?')[0].split('#')[0];
  const segs = clean.split('/').filter(Boolean);
  if (segs.length === 0) return '/';
  return '/' + segs.map((s) => (isDynamicSegment(s) ? '[id]' : s)).join('/');
}
