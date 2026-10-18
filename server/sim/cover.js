// Destructible map pieces: doors, natural cover (gravestones, rocks, trees, ...) and player builds. Each piece owns a
// collider in game.field; when its HP runs out the collider is removed and the piece stays gone for the round.
// Pieces never appear in snapshots: the layout is static (config.map) and changes travel as events
// (coverHit at 75 / 50 / 25 %, coverBreak, build) plus game.cover.mapState() for late joiners.
import { MAP } from './map.js';
import { WORLD } from './world.js';

const HIT_STEPS = [0.75, 0.5, 0.25]; // HP shares at which a coverHit event is sent

export class Cover {
  constructor(game) {
    this.game = game;
    this.pieces = new Map(); // id -> piece
    this.gone = new Set(); // ids of broken pieces (natural + doors)
    this.round = 0;
  }

  /** Round start: remove everything dynamic, rebuild doors and cover from the static map at full health. */
  reset() {
    const g = this.game;
    for (const p of this.pieces.values()) if (p.collider) g.field.remove(p.collider);
    this.pieces.clear();
    this.gone.clear();
    this.round++;
    for (const d of MAP.doors) this._make(d, g.config.doorHp[d.door] ?? g.config.doorHp.default, 'plant');
    for (const c of MAP.cover) this._make(c, g.config.cover[c.kind]?.hp ?? 50, null);
  }

  _make(def, hp, team) {
    const collider = { ...def, _piece: null };
    const piece = {
      id: def.id,
      kind: def.kind,
      def,
      team,
      hp,
      maxHp: hp,
      state: 'alive',
      collider,
      x: def.s === 'box' ? (def.minX + def.maxX) / 2 : def.x,
      z: def.s === 'box' ? (def.minZ + def.maxZ) / 2 : def.z,
      y0: def.y0,
      y1: def.y1,
      step: 0,
    };
    collider._piece = piece;
    this.game.field.add(collider);
    this.pieces.set(piece.id, piece);
    return piece;
  }

  get(id) {
    return this.pieces.get(id) ?? null;
  }

  alive(id) {
    const p = this.pieces.get(id);
    return Boolean(p && p.state === 'alive');
  }

  /** The piece a collider belongs to, if it is destructible. */
  pieceOf(collider) {
    return collider?._piece ?? null;
  }

  /** Can a projectile of `team` hurt this piece? Pieces owned by a team are safe from that team. */
  canHurt(piece, team) {
    return piece.state === 'alive' && piece.team !== team;
  }

  /** Apply damage. Returns true if the piece was hurt. */
  damage(piece, amount, attacker = null, team = null) {
    if (!piece || piece.state !== 'alive' || !(amount > 0) || (team !== null && piece.team === team)) return false;
    piece.hp -= amount;
    const g = this.game;
    g.onPieceHit?.(piece, amount, attacker);
    if (piece.hp <= 0) {
      piece.hp = 0;
      this.destroy(piece, attacker);
      return true;
    }
    const share = piece.hp / piece.maxHp;
    while (piece.step < HIT_STEPS.length && share <= HIT_STEPS[piece.step]) {
      piece.step++;
      g.emit('coverHit', { id: piece.id, hp: Math.ceil(piece.hp), maxHp: piece.maxHp });
    }
    return true;
  }

  destroy(piece, attacker = null) {
    if (piece.state !== 'alive') return;
    const g = this.game;
    piece.state = 'broken';
    piece.hp = 0;
    g.field.remove(piece.collider);
    if (piece.build) {
      this.pieces.delete(piece.id);
      g.onBuildGone?.(piece);
    } else this.gone.add(piece.id);
    g.emit('coverBreak', { id: piece.id, kind: piece.kind, x: Math.round(piece.x * 100) / 100, y: piece.y0, z: Math.round(piece.z * 100) / 100, by: attacker?.id ?? null });
    g.onPieceBroken?.(piece, attacker);
  }

  /** Blast damage on every piece within `radius` (falls off to 40 % at the rim), skipping pieces the blast's team owns. */
  splash(x, y, z, radius, damage, attacker = null, team = null) {
    const hits = [];
    this.game.field.each(x - radius, x + radius, z - radius, z + radius, (c) => {
      const p = c._piece;
      if (!p || p.state !== 'alive' || (team !== null && p.team === team)) return;
      let d;
      if (c.s === 'box') {
        const dx = Math.max(c.minX - x, 0, x - c.maxX);
        const dz = Math.max(c.minZ - z, 0, z - c.maxZ);
        d = Math.hypot(dx, dz);
      } else d = Math.max(0, Math.hypot(x - c.x, z - c.z) - c.r);
      if (d > radius) return;
      hits.push([p, damage * (1 - 0.6 * (d / radius))]);
    });
    for (const [p, dmg] of hits) this.damage(p, dmg, attacker, team);
  }

  /** What a client needs after the static map: broken ids, damaged pieces, standing builds. */
  mapState() {
    const hurt = {};
    const builds = [];
    for (const p of this.pieces.values()) {
      if (p.state !== 'alive') continue;
      if (p.build) builds.push({ id: p.id, kind: p.build.kind, x: p.build.x, z: p.build.z, rot: p.build.rot, hp: Math.ceil(p.hp), maxHp: p.maxHp, by: p.build.by });
      else if (p.hp < p.maxHp) hurt[p.id] = Math.ceil(p.hp);
    }
    return { round: this.round, gone: [...this.gone], hurt, builds };
  }
}

export const DOOR_IDS = WORLD.doors.map((d) => `door:${d.id}`);
