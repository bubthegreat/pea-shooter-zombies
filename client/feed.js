// Kill-feed lines from server events. Pure: no DOM. The HUD renders each part with textContent.
import { cleanName } from './text.js';

const name = (v, fallback) => cleanName(typeof v === 'string' ? v : '', fallback);

/**
 * Turn an event into { parts: [{ text, team? }], head } or null when it should not be shown.
 * Only lines with a human on either side are shown, so bots fighting each other do not flood the feed.
 */
export function feedLine(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const humanBy = ev.byKind === 'player';
  const humanTarget = ev.targetKind === 'player';
  const who = (v, team, fallback) => ({ text: name(v, fallback), team });
  const t = (text) => ({ text });
  const head = ev.head === true;
  switch (ev.type) {
    case 'convert':
      if (!humanBy && !humanTarget) return null;
      if (typeof ev.byName !== 'string') return null;
      return { parts: [who(ev.byName, 'plant', 'Someone'), t(' turned '), who(ev.targetName, 'zombie', 'Zombie'), t(' into a flower!')], head };
    case 'wilt':
      if (!humanBy && !humanTarget) return null;
      if (typeof ev.byName !== 'string') return null;
      if (ev.targetKind === 'garden') return { parts: [who(ev.byName, 'zombie', 'Someone'), t(' wrecked a '), who(ev.targetName, 'plant', 'plant'), t('!')], head: false };
      return { parts: [who(ev.byName, 'zombie', 'Someone'), t(' wilted '), who(ev.targetName, 'plant', 'Plant'), t('!')], head };
    case 'mow':
      if (!humanBy || typeof ev.byName !== 'string') return null;
      return { parts: [who(ev.byName, 'zombie', 'Someone'), t(' mowed a '), who(ev.targetName, 'plant', 'plant'), t('!')], head: false };
    case 'mower_destroyed':
      if (!humanBy || typeof ev.byName !== 'string') return null;
      return { parts: [who(ev.byName, 'plant', 'Someone'), t(' wrecked the mower!')], head: false };
    default:
      return null;
  }
}
