// The User-Agent contact rule (R6), shared by the settings schema (main) and
// the Settings page, so the page never accepts a value main will reject.

/**
 * The contact ends up inside the User-Agent comment "(+<contact>)", so only
 * printable ASCII without spaces or parentheses is accepted.
 */
export const CONTACT_RE = /^[!-'*-~]*$/;
export const CONTACT_MAX = 200;

/** True when the trimmed text fits the User-Agent comment (any text, not only URLs). */
export function isContactSafe(s: string): boolean {
  const t = s.trim();
  return t.length <= CONTACT_MAX && CONTACT_RE.test(t);
}
