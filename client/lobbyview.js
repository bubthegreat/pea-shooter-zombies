// Wording for the lobby screens. Pure: no DOM.

export const modeLabel = (m) => (m === 'versus' ? 'Versus' : 'Co-op');
export const diffLabel = (d) => (d === 'easy' ? 'Easy' : 'Normal');
export const teamLabel = (t) => (t === 'zombie' ? 'Zombies' : 'Plants');

export function playersText(n) {
  const k = Math.max(0, Number.isFinite(n) ? Math.floor(n) : 0);
  return k === 1 ? '1 player' : `${k} players`;
}

export function fmtClock(sec) {
  const s = Math.max(0, Math.ceil(Number.isFinite(sec) ? sec : 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Status cell of a lobby row: { text, kind: 'waiting' | 'playing' | 'over' }. */
export function statusText(l) {
  if (!l || l.status !== 'playing') return { text: 'Waiting', kind: 'waiting' };
  if (l.over) return { text: 'Round over', kind: 'over' };
  return { text: `Playing · ${fmtClock((l.roundLength || 0) - (l.roundTime || 0))} left`, kind: 'playing' };
}

/** Second line of a lobby row. */
export function detailText(l) {
  return `Host ${l.host || '?'} · ${playersText(l.players)} · ${modeLabel(l.mode)} · ${diffLabel(l.difficulty)}`;
}

/** What the waiting room says under the players. */
export function waitText(room, you) {
  if (!room) return '';
  if (room.status === 'playing') return 'Joining the game…';
  if (room.host === you) return 'You are the host. Press Start when everyone is ready!';
  return `Waiting for ${room.hostName || 'the host'} to start…`;
}

/** The one-sentence rules shown on the loading screen and in the waiting room. */
export const RULES = {
  zombie: 'Break into the house and raid the fridge!',
  plant: 'Plant your garden, guard every door, and hold on until sunrise!',
};

export function ruleText(team) {
  return RULES[team === 'zombie' ? 'zombie' : 'plant'];
}
