// Text that kids type (player names, lobby names): length-capped and stripped of anything invisible or
// control-like. Clients render the result with textContent / canvas text only, never as HTML.

// Code point ranges removed from names: C0/C1 controls, soft hyphen, Arabic letter mark, Mongolian vowel separator,
// zero-width + bidi formatting characters, line/paragraph separators, invisible operators, BOM, interlinear marks.
const STRIPPED = [
  [0x00, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x180e, 0x180e], [0x200b, 0x200f],
  [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff], [0xfff9, 0xfffb],
];
const INVISIBLE = new RegExp('[' + STRIPPED.map(([a, b]) => String.fromCharCode(a) + '-' + String.fromCharCode(b)).join('') + ']', 'g');

/** Clean `raw` into at most `max` code points; `fallback` if nothing printable is left. */
export function sanitizeText(raw, fallback, max) {
  if (typeof raw !== 'string') return fallback;
  const s = raw.replace(INVISIBLE, '').trim();
  const out = [...s].slice(0, max).join('').trim();
  return out === '' ? fallback : out;
}

export const NAME_MAX = 16;
export const LOBBY_NAME_MAX = 32;

export function sanitizeName(raw, fallback = 'Player', max = NAME_MAX) {
  return sanitizeText(raw, fallback, max);
}

export function sanitizeLobbyName(raw, fallback, max = LOBBY_NAME_MAX) {
  return sanitizeText(raw, fallback, max);
}
