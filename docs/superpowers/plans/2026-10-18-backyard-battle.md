# Backyard Battle v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Playable LAN/localhost first-person PvZ-themed shooter: two teams, waves, upgrades, planting, mower, sunrise, co-op and versus.

**Architecture:** Node server is authoritative: pure game simulation (`server/sim/*`, no I/O, unit-tested with `node:test`) ticked at 30 Hz by `server/index.js`, which also serves static client files and a WebSocket. Browser client (`client/*`, plain ES modules, Three.js via import map, no bundler) sends inputs and renders interpolated snapshots.

**Tech Stack:** Node 24 (ESM), `ws@8`, `three@0.169.0` (served from `node_modules`), `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-18-backyard-battle-design.md`

## Global Constraints

- No ads, no external network calls at runtime, no accounts. All assets generated in code (primitives / canvas textures). No PvZ trademark assets.
- Cheerful, non-gory visuals: conversion = green poof + leaves, never blood.
- `npm start` serves on `PORT` env or `8080`, bound to `0.0.0.0`. `npm test` runs `node --test`.
- Up to 2 human players, one game at a time.
- All tunables live in `server/sim/config.js`; no magic numbers elsewhere.

## Review Focus

1. Player disconnects mid-round (tab closed): their entity is removed; when 0 humans remain, game resets to lobby. Test in Task 1.
2. Second player joins mid-round: they spawn into running game on chosen team. Test in Task 1.
3. Zombie driving mower is converted: mower stops, becomes free at its current spot. Test in Task 5.
4. Planting with too little sunshine or no free slot nearby: no-op, sunshine unchanged. Test in Task 4.
5. Malformed / oversized WS message: ignored, server does not crash. Test in Task 1.

## Coordinate system & world (Task 1, `server/sim/world.js`)

Y up, units meters. Yard: x ∈ [-30, 30], z ∈ [-50, 30]. Zombie gate spawn: z = -48, x ∈ [-20, 20]. Garden slots: columns x = -16, -12, …, 16 (9), rows (front→back, toward house) z = 0 Peashooter, 4 Cactus, 8 Cactus, 12 Peashooter (slot `kind` fixed per row — spec layout). House: box x ∈ [-25, 10], z ∈ [30, 45]. Garage: box x ∈ [12, 28], z ∈ [30, 45], open door facing −z; mower home at (20, 0, 34). Plant spawn (players/bots): (−5, 0, 26). Fence around yard bounds; players clamped to bounds and pushed out of house/garage solids (garage interior walkable through door x ∈ [14, 26]).

## Protocol (shared by Tasks 1 and 6)

Client → server JSON:
- `{t:"join", name:string(≤16), team:"plant"|"zombie", mode:"coop"|"versus", difficulty:"easy"|"normal"}` (mode/difficulty only honored by first joiner)
- `{t:"input", seq:int, keys:{f,b,l,r,jump:bool}, yaw:number, pitch:number, fire:bool, use:bool, plant:0|1|2, plantSeq:int}` sent at 30 Hz (`plant` 1=Peashooter, 2=Cactus, 0=none; `plantSeq:int` counts presses — the server plants when it increases; `use` = E key, mower)

Server → client JSON:
- `{t:"welcome", id:string, config:{...publicConfig}}`
- `{t:"snap", time:number, phase:"lobby"|"playing"|"ended", winner:null|"plant"|"zombie", roundTime:number, roundLength:number, wave:int, gardenCount:int, entities:[Entity], events:[Event]}` at 20 Hz
- Entity: `{id, kind:"player"|"bot"|"garden"|"projectile"|"mower"|"sun", team, x,y,z, yaw, pitch?, hp, maxHp, weapon?, tier?, state?:"alive"|"wilted"|"sprout"|"starting"|"driving"|"idle", name?, plantKind?:"peashooter"|"cactus", sunshine?, progress?, streak?, projKind?:"pea"|"spike"|"housepea"|"bullet"}`
- Event: `{type:"convert"|"wilt"|"upgrade"|"plant"|"mow"|"hit"|"wave"|"win", ...}`

---

### Task 1: Server core — scaffold, world, game loop, join/move/snapshot

**Files:**
- Create: `package.json`, `.gitignore`, `server/index.js`, `server/sim/config.js`, `server/sim/world.js`, `server/sim/game.js`, `server/sim/vec.js`
- Test: `test/game-core.test.js`

**Interfaces:**
- Produces: `class Game { constructor(config=DEFAULT_CONFIG, rng=Math.random); addPlayer(id, {name,team,mode,difficulty}) ; removePlayer(id); handleInput(id, input); tick(dt); snapshot() -> SnapObject; drainEvents() -> Event[]; phase; entities: Map<string,Entity> }`. `DEFAULT_CONFIG` export from config.js. `world.js` exports `WORLD`, `gardenSlots() -> [{x,z,kind}]`, `clampToWorld(pos)`.
- Game owns subsystems added by later tasks via methods on the class (or helper modules imported by game.js): `combat.js`, `upgrades.js`, `garden.js`, `mower.js`, `rules.js`, `bots.js`.

- [ ] **Step 1:** `git init`; package.json `{type:"module", scripts:{start:"node server/index.js", test:"node --test"}, dependencies:{ws:"^8.18.0", three:"0.169.0"}}`; `npm install`; `.gitignore` node_modules.
- [ ] **Step 2: Failing tests** in `test/game-core.test.js`:
  - `addPlayer first sets mode and phase "playing"`: after `addPlayer("a",{team:"plant",mode:"coop"})`, `game.phase==="playing"`, `game.mode==="coop"`, player entity at plant spawn.
  - `second player joins mid-round on chosen team`: second `addPlayer` with team zombie spawns at gate z≈-48; mode unchanged.
  - `movement`: input keys.f with yaw=0 for 1 s of `tick(1/30)` moves player toward −z by ≈ `config.moveSpeed` (6 m/s) ±0.5; positions clamped inside yard.
  - `removing last human resets to lobby`: `removePlayer` both → `phase==="lobby"`, entities empty.
  - `malformed input ignored`: `handleInput("a", {yaw:"x"})` and `handleInput("nobody", {})` do not throw; state unchanged.
- [ ] **Step 3:** Run `npm test` → FAIL.
- [ ] **Step 4:** Implement. Movement relative to yaw (yaw=0 faces −z), gravity + jump (`jumpSpeed` 6, `gravity` 18), eye height 1.6. Input sanitized (numbers finite, booleans coerced).
- [ ] **Step 5:** `server/index.js`: http static server for `client/` plus `/vendor/three.module.js` → `node_modules/three/build/three.module.js`; `ws` server on same port; message size cap 4 KB, JSON parse in try/catch; tick loop 30 Hz, snapshot 20 Hz; `PORT` default 8080, host `0.0.0.0`; log LAN URL on start.
- [ ] **Step 6:** `npm test` → PASS. Commit `feat: server core game loop and networking`.

### Task 2: Combat — weapons, projectiles, conversion, wilt, sprout

**Files:** Create `server/sim/combat.js`, `server/sim/weapons.js`; Modify `game.js`, `config.js`; Test `test/combat.test.js`

**Interfaces:**
- Produces: `weapons.js` exports `PLANT_LADDER` and `ZOMBIE_LADDER`: arrays of `{id, name, damage, rate (shots/s), pellets, spread (rad), speed (m/s), projKind}`.
  - Plant: `pea_blaster` "Pea Blaster" dmg1 rate4 pellets1 speed50 pea; `pea_rifle` "Pea Rifle" dmg1 rate9 speed70 pea; `spike_shotgun` "Spike Shotgun" dmg1 rate1.3 pellets7 spread0.12 speed55 spike; `house_gun` "House Gun" dmg5 rate1.5 speed40 housepea (big).
  - Zombie: `goo_blaster` "Goo Blaster" dmg8 rate3 speed50 bullet; `zombie_rifle` "Zombie Rifle" dmg8 rate6; `zombie_shotgun` "Zombie Shotgun" dmg6 pellets6 spread0.12 rate1.2; `auto_shot_rifle` "Auto-Shot Rifle" dmg8 rate12.
- Produces: `combat.js` `fireWeapon(game, shooter)`, `stepProjectiles(game, dt)`, `applyDamage(game, target, amount, attacker)`.
- Config: zombie hp 5; plant player/bot hp 100; garden plant hp 60; `wiltRespawn` 4 s; `sproutTime` 5 s; projectile life 2 s; friendly fire off.

- [ ] **Step 1: Failing tests:**
  - `zombie bot converts after 5 pea hits`: becomes `kind:"bot", team:"plant"` walking bot; `convert` event emitted.
  - `house gun converts in one hit`.
  - `human zombie converted becomes sprout then respawns zombie at gate after 5 s with same tier`.
  - `plant player wilts at 0 hp, respawns at plant spawn after 4 s with full hp, tier kept`.
  - `fire rate respected`: holding fire 1 s with pea_blaster spawns 4 ±1 projectiles.
  - `no friendly fire`.
- [ ] **Step 2:** `npm test` → FAIL. **Step 3:** Implement (sphere-vs-capsule hit test, capsule radius 0.5 height 1.8; garden plants radius 0.6 height 1.2). **Step 4:** PASS. **Step 5:** Commit `feat: combat and conversion`.

### Task 3: Upgrades and streaks

**Files:** Create `server/sim/upgrades.js`; Modify `combat.js`/`game.js`; Test `test/upgrades.test.js`

**Interfaces:** `recordKill(game, player)`, `recordHurt(player)`; player fields `tier` (0–3), `progress` (kills), `streak`.
- Config `tierThresholds: [0, 3, 7, 12]` cumulative kills; `streakBonus: 10`.
- Kill = plant converts a zombie; zombie destroys/mows a garden plant or wilts a plant player/bot. Bots don't upgrade.

- [ ] **Step 1: Failing tests:** `3 kills → tier 1 Pea Rifle, upgrade event`; `12 kills → house_gun`; `10 kills without hurt → extra tier jump (tier = min(3, thresholdTier+1))` and streak resets to 0 after bonus; `getting hit resets streak but not tier`; `zombie ladder top is auto_shot_rifle`; `tiers reset on new round`.
- [ ] **Step 2–5:** FAIL → implement → PASS → commit `feat: upgrades and streak bonus`.

### Task 4: Garden, planting, sunshine

**Files:** Create `server/sim/garden.js`; Modify `game.js`; Test `test/garden.test.js`

**Interfaces:** `initGarden(game)` pre-plants every other slot (cols 0,2,4,6,8 of each row); `tryPlant(game, player, kind)`; `stepGarden(game, dt)` (turrets auto-fire at nearest zombie in range); `stepSun(game, dt)`.
- Config: Peashooter range 25 m rate 1.5/s dmg 1 pea; Cactus range 50 m rate 0.8/s dmg 2 spike; costs Peashooter 50, Cactus 100; start sunshine 100; +25 per conversion; sun drop every 8 s at random yard point z ∈ [-30, 20], worth 25, picked up within 1.5 m, lifetime 30 s. Sunshine pooled per plant human player.
- Planting: nearest empty slot of matching `kind` within 4 m of player; plant only on that row's kind.

- [ ] **Step 1: Failing tests:** `initGarden plants 20`; `tryPlant succeeds near empty peashooter slot and costs 50`; `tryPlant with 40 sunshine is a no-op`; `tryPlant with no free slot in 4 m is a no-op`; `cactus turret hits zombie 40 m away`; `sun pickup adds 25`.
- [ ] **Step 2–5:** FAIL → implement → PASS → commit `feat: garden turrets and planting`.

### Task 5: Mower, waves, sunrise, win rules, bots

**Files:** Create `server/sim/mower.js`, `server/sim/rules.js`, `server/sim/bots.js`; Modify `game.js`; Test `test/rules.test.js`, `test/mower.test.js`, `test/bots.test.js`

**Interfaces:**
- `mower.js`: `stepMower(game, dt)`; mower entity states `idle|starting|driving`. Zombie within 2.5 m holding `use` → `starting` for `mowerStartTime` 3 s (cancel if zombie leaves/converted) → `driving`, mower follows driver (speed 7 m/s); any garden plant within 1.5 m destroyed (`mow` event, counts as kill). Driver converted → mower `idle` at current position.
- `rules.js`: `stepRules(game, dt)`; `roundLength` 480 s; waves every 45 s starting t=5 s, size `3 + wave` (easy: `2 + wave`), last wave at `roundLength - 60`; zombies win when garden count 0; plants win at roundLength with garden > 0, or when final wave spawned and no zombies remain; `ended` phase 10 s then auto-restart same mode with tiers reset.
- `bots.js`: `stepBots(game, dt)`. Zombie bots: walk toward nearest garden plant (some, 1 in 4, head for mower when idle and drive it into garden), shoot plants/players within 20 m with aim error (easy 0.15 rad, normal 0.07), weapon `goo_blaster`. Plant bots (converted zombies + coop-as-zombies defenders: 4 at round start respawning after 8 s): guard garden line z≈-4, shoot zombies within 30 m. Simple steering, no pathfinding beyond avoiding house/garage boxes.

- [ ] **Step 1: Failing tests:** `wave 1 spawns 4 zombies at gate at t=5`; `garden count 0 → zombie win`; `sunrise with garden → plant win`; `final wave cleared → plant win`; `ended restarts after 10 s with tiers reset`; mower: `start takes 3 s`, `driving mower destroys plant in path`, `driver converted → mower idle at current spot`; bots: `zombie bot moves toward garden over 2 s`.
- [ ] **Step 2–5:** FAIL → implement → PASS → commit `feat: mower, waves, win rules, bots`.

### Task 6: Browser client

**Files:** Create `client/index.html`, `client/style.css`, `client/main.js`, `client/net.js`, `client/input.js`, `client/scene.js`, `client/models.js`, `client/hud.js`, `client/lobby.js`

**Interfaces:** Consumes Protocol section. Import map `{"three": "/vendor/three.module.js"}`.

- [ ] **Step 1: Lobby** (`lobby.js`): name field, team buttons (🌻 Plants / 🧟 Zombies), mode (Co-op / Versus), difficulty (Easy default). Big friendly buttons, bright colors. "Play!" → join, request pointer lock.
- [ ] **Step 2: Net** (`net.js`): WS to `ws://${location.host}`, auto-reconnect to lobby on close; keeps last two snapshots, interpolates entities 100 ms behind.
- [ ] **Step 3: Input** (`input.js`): pointer lock mouse look (yaw/pitch, pitch clamped ±1.4), WASD, Space jump, left mouse fire, E use, 1/2 plant; sends input at 30 Hz. Own yaw/pitch applied to camera immediately.
- [ ] **Step 4: Scene/models** (`scene.js`, `models.js`): low-poly primitives. Grass plane w/ canvas noise texture, fence, house (walls, roof, windows), garage with open door, mower model, garden rows with dirt patches. Peashooter (green stem, head, mouth tube), Cactus (green capsule w/ spikes, flower), zombies (cartoon green skin, shirt, tie, outstretched arms, wobble walk), plant players/bots (sunflower-headed soldier). Projectiles: pea green sphere, spike = small cone, housepea big sphere, zombie bullet purple goo. Sky: night→sunrise color lerp by `roundTime/roundLength`, sun rising near end. First-person view model: held gun mesh by weapon id (color/shape varies). Conversion: green poof particles + leaf burst.
- [ ] **Step 5: HUD** (`hud.js`): crosshair, HP bar, weapon name + tier pips, upgrade progress bar and streak counter, sunshine counter + seed cards (1 Peashooter 50, 2 Cactus 100) for plants, wave / sunrise timer bar, garden count, big "UPGRADE! Pea Rifle" banner, sprout/wilted countdown overlay, end screen "PLANTS WIN! 🌞" / "ZOMBIES WIN! 🧟", controls help on first spawn.
- [ ] **Step 6: Verify:** `npm start`, then `curl -s localhost:8080/ | grep -q "<title>"` and `curl -sI localhost:8080/vendor/three.module.js | grep 200`; node smoke script (scratch) joins via `ws`, sends inputs 2 s, asserts receives `snap` with player entity. Optionally load page in headless Chrome if available and check no console errors.
- [ ] **Step 7:** Commit `feat: browser client`.

### Task 7: README + final verification

- [ ] `README.md`: how to run (`npm install`, `npm start`, open `http://localhost:8080` or LAN IP), controls, how to play.
- [ ] `npm test` all PASS; server smoke from Task 6 passes. Commit `docs: readme`.
