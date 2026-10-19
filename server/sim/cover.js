// Destructible map pieces: doors, natural cover (gravestones, rocks, trees, ...) and player builds. Each piece owns a
// collider in game.field; when its HP runs out the collider is removed and the piece stays gone for the round.
// Pieces never appear in snapshots: the layout is static (config.map) and changes travel as events
// (coverHit at 75 / 50 / 25 %, coverBreak, build) plus game.cover.mapState() for late joiners.
import { MAP } from './map.js';
import { WORLD } from './world.js';
import { footprint } from './build.js';

const round2 = (v) => Math.round(v * 100) / 100;
const HIT_STEPS = [0.75, 0.5, 0.25]; // HP shares at which a coverHit event is sent

export class Cover {
  constructor(game) {
    this.game = game;
    this.pieces = new Map(); // id -> piece
    this.gone = new Set(); // ids of broken pieces (natural + doors)
    this.round = 0;
    this.buildSeq = 0;
  }

  /** Round start: remove everything dynamic, rebuild doors and cover from the static map at full health. */
  reset() {
    const g = this.game;
    for (const p of this.pieces.values()) if (p.collider) g.field.remove(p.collider);
    this.pieces.clear();
    this.gone.clear();
    this.buildSeq = 0;
    this.round++;
    const doorMult = g.scaling?.plant.door ?? 1; // the level's door toughness (when the kids are on the zombie side)
    for (const d of MAP.doors) this._make(d, Math.round((g.config.doorHp[d.door] ?? g.config.doorHp.default) * doorMult), 'plant');
    if (g.config.features.cover) for (const c of MAP.cover) this._make(c, g.config.cover[c.kind]?.hp ?? 50, null);
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

  /** Standing builds of one player: all of them, or only the 'pot's / only the 'fort's (everything else). */
  buildsOf(playerId, which = null) {
    let n = 0;
    for (const p of this.pieces.values()) {
      if (!p.build || p.build.by !== playerId || p.state !== 'alive') continue;
      if (which === 'pot' ? p.build.kind !== 'pot' : which === 'fort' && p.build.kind === 'pot') continue;
      n++;
    }
    return n;
  }

  /** A player's build goes up (placement was validated by build.js). `chk` carries the ground range under it. */
  addBuild(def, owner, gx, gz, rot, chk) {
    const g = this.game;
    const f = footprint(def, rot);
    const id = `b${++this.buildSeq}`;
    const hp0 = def.pot ? Math.round(def.hp * (g.scaling?.plant.potHp ?? 1)) : def.hp; // pots get the level's toughness too
    const collider = { id, kind: def.id, s: 'box', minX: gx, maxX: gx + f.w, minZ: gz, maxZ: gz + f.d, y0: Math.round((chk.lo - 0.3) * 100) / 100, y1: Math.round((chk.hi + def.h) * 100) / 100, style: def.id, _piece: null };
    const piece = {
      id, kind: def.id, def: collider, team: owner.team, hp: hp0, maxHp: hp0, state: 'alive', collider,
      x: gx + f.w / 2, z: gz + f.d / 2, y0: collider.y0, y1: collider.y1, step: 0,
      build: { kind: def.id, x: gx, z: gz, rot, by: owner.id },
    };
    collider._piece = piece;
    g.field.add(collider);
    this.pieces.set(id, piece);
    g.emit('build', { id, kind: def.id, x: gx, z: gz, rot, by: owner.id, hp: hp0, maxHp: hp0 });
    // anybody standing right where it appears is nudged out (placement already refuses fighters, this catches projectiles' owners etc.)
    return piece;
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
      g.onBuildGone?.(piece, attacker);
    } else this.gone.add(piece.id);
    g.emit('coverBreak', { id: piece.id, kind: piece.kind, x: Math.round(piece.x * 100) / 100, y: piece.y0, z: Math.round(piece.z * 100) / 100, by: attacker?.id ?? null });
    g.onPieceBroken?.(piece, attacker);
  }

  /** Heal a standing door or piece by `amount` (never above its maximum); the hit steps rearm. Returns the new HP. */
  heal(piece, amount) {
    if (!piece || piece.state !== 'alive') return 0;
    piece.hp = Math.min(piece.maxHp, piece.hp + amount);
    const share = piece.hp / piece.maxHp;
    piece.step = HIT_STEPS.filter((s) => share <= s).length;
    return piece.hp;
  }

  /** A broken door is raised again with `hp` (its collider comes back, it is no longer "gone"). Returns true when it was rebuilt. */
  rebuildDoor(piece, hp) {
    if (!piece || piece.state !== 'broken' || piece.kind !== 'door') return false;
    const g = this.game;
    piece.state = 'alive';
    piece.hp = Math.max(1, Math.min(piece.maxHp, hp));
    piece.step = HIT_STEPS.filter((s) => piece.hp / piece.maxHp <= s).length;
    g.field.add(piece.collider);
    this.gone.delete(piece.id);
    g.emit('doorUp', { id: piece.id, hp: Math.ceil(piece.hp), maxHp: piece.maxHp, x: round2(piece.x), z: round2(piece.z) });
    return true;
  }

  /** Maximum HP of the four doors (they depend on the level), in WORLD.doors order. */
  doorMaxes() {
    return WORLD.doors.map((d) => {
      const p = this.pieces.get(`door:${d.id}`);
      return p ? p.maxHp : this.game.config.doorHp[d.id] ?? this.game.config.doorHp.default;
    });
  }

  /** Door HP for the snapshot, in WORLD.doors order: 0 = broken. */
  doorHps() {
    return WORLD.doors.map((d) => {
      const p = this.pieces.get(`door:${d.id}`);
      if (!p) return this.game.config.doorHp[d.id] ?? this.game.config.doorHp.default; // no round yet: full health
      return p.state === 'alive' ? Math.max(1, Math.ceil(p.hp)) : 0;
    });
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
