// Typed text (player and lobby names) cleaned the same way the server does it. The server is the real gate;
// this keeps what we show and send tidy. Names are only ever put on screen with textContent or canvas text.

const STRIPPED = [
  [0x00, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x180e, 0x180e], [0x200b, 0x200f],
  [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff], [0xfff9, 0xfffb],
];
const INVISIBLE = new RegExp('[' + STRIPPED.map(([a, b]) => String.fromCharCode(a) + '-' + String.fromCharCode(b)).join('') + ']', 'g');

export const NAME_MAX = 16;
export const LOBBY_NAME_MAX = 32;

/** Strip invisible/control characters, trim, cap at `max` code points; `fallback` if nothing is left. */
export function cleanText(raw, fallback, max) {
  if (typeof raw !== 'string') return fallback;
  const out = [...raw.replace(INVISIBLE, '').trim()].slice(0, max).join('').trim();
  return out === '' ? fallback : out;
}

export const cleanName = (raw, fallback = 'Player') => cleanText(raw, fallback, NAME_MAX);
export const cleanLobbyName = (raw, fallback = '') => cleanText(raw, fallback, LOBBY_NAME_MAX);
