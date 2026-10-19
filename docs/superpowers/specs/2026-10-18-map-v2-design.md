# Map v2: The Big Backyard — Design

Build after Lobbies. Approved by the parent on 2026-10-18 ("make something up that's easy for kids to understand and go for it").

## Why
The current yard is flat and open. The kids want a real 3D place:
- hills to jump on and stuff to hide behind
- forts they build themselves
- sneaky routes around the house
- treasure-hunting for mower parts

Plants should have to *plant* their defense, not get one for free.

## The one-sentence rules (shown on the loading screen)
- **Zombies:** "Break into the house and raid the fridge!"
- **Plants:** "Plant your garden, guard every door, and hold on until sunrise!"

## How a round goes
1. **Head start (15 s).** Plants spawn at the house with **300 sunshine** and an empty map. There are **no default plants**. Zombies wait behind the gate, and a big countdown shows on their screen ("Zombies come out in 10…").
2. **Waves** come as they do now. Zombies may come through any route.
3. **Zombies win** by filling the **Fridge Meter**:
   - The fridge is in the kitchen, in the middle of the house.
   - Every zombie standing next to the open fridge fills the meter (about 10 s for one zombie, faster with more).
   - Plants shoot them off it. The meter never drains, so every snack counts.
   - The meter is shown as a big snack bar on everyone's HUD, with an alarm sound when a zombie is at the fridge.
4. **Plants win** at sunrise, or by clearing the final wave (unchanged).

The old "garden wiped out = zombies win" rule is removed.

## The map
- **Size:** about 1.5x the current yard. The house sits in the middle-back, with yard wrapping around the front, both sides and the back.
- **Terrain:**
  - A heightmap with rolling hills, two big mounds, a ditch or creek bed with a little footbridge, a raised back deck with steps, and retaining walls.
  - Ledges are about 1 m, so you need a jump to get up them.
  - Movement and bots follow the ground height, and bots use simple waypoint paths.
- **Routes from the zombie gate:**
  - the open front lawn (fast, exposed)
  - a **gravel path** looping around the left side to the back door (sneaky, longer)
  - a hedge-lined path past the shed to the garage on the right
- **House entrances, four doors, each with its own garden plot of empty slots in front of it:**
  - Front door
  - Back door (off the deck)
  - Side door
  - Garage door
  - Each door has HP and can be shot down; it breaks into planks and stays broken for the round.
  - The garden plot is where plants can grow. Turrets can only be planted in garden plots, and every plot follows the same row pattern as today (Peashooter / Cactus / Cactus / Peashooter).
  - If nobody planted at the back, nothing stops you there.
- **Inside the house:** hallway, kitchen (with the fridge), living room, and a door to the garage. It's walk-through and simple, with low-poly furniture as cover.
- **Cover that can be destroyed:**
  - Gravestones (lots, zombie side), rocks, trees, hedges, trash cans, a picnic table, a kiddie pool, and the shed walls.
  - Each piece has HP and breaks into chunks. Rocks are tough; gravestones and fences are medium.
  - Destroyed pieces stay destroyed for the round.

## Building forts (both teams)
- Press **B** (or the touch Build button) to open a build wheel. A ghost preview snaps to a 1 m grid; click or tap to place it.
- Building has a short build-up animation, and each structure has HP.
- **Plants** pay sunshine:
  - Hedge Wall (cheap, low HP)
  - Wooden Fence (medium)
  - Wall-nut (a tough plant barrier that grows only in garden plots)
- **Zombies** pay **brains**, a new zombie currency:
  - +5 per hit on a plant, door or structure
  - +10 per turret destroyed
  - Builds: Tombstone Wall (medium), Junk Barricade (cheap), Trash-can Tower (tall cover)
- Each player can have a limited number of builds standing (for example 12), so nobody walls off the whole map.
- Builds can't block a doorway completely, and placement rejects spots inside a door's frame.

## Mower parts and powered equipment
- The garage rack still holds the equipment, but the powered items start **unpowered**.
- **Parts** are glowing pickups that respawn at random spots each round:
  - in the garage
  - in a basement reached by outside storm-cellar doors on the side of the house
  - in the shed
  - around the yard
- Parts:
  - **Battery:** powers the Leaf Blower or the Hedge Trimmer
  - **Gas Can:** fuels the Weed Eater
  - **Battery + Gas Can + Spark Plug:** start the Lawn Mower
- A zombie carrying a part walks to the rack or mower and presses E to install it, and the item stays powered for the round.
- Parts show on the HUD as a "Mower: 🔋 ⛽ 🔌" checklist for the zombie team.
- The Wheelbarrow needs no parts.
- Plants can shoot a carried part to make the carrier drop it.

## What changes from v1
- No pre-planted garden. There are multiple garden plots, one per door.
- The win condition is the Fridge Meter instead of the garden wipe.
- New: terrain height, destructible cover, forts, doors, the house interior, parts.
- Everything else stays the same: waves, the sunrise win, the gun ladders, the equipment, the protected mower driver, and headshots.

## Left to the builder
- Exact layout coordinates, HP values, costs and timers.
- Bot waypoint graph design.
- Performance budget: keep phones at 30+ fps by instancing cover and merging static terrain.
- Balance target: a decent kid wins on Easy most rounds, and zombies use all three routes.
- Prove the balance with headless sims, as before.

## As built (2026-10-18)

Everything in the spec is in. The numbers and the few places where the builder decided something different:

**Map.** Yard x -40..40, z -52..46 (about 1.6x the old 4800 m²). House x -14..8, z 6..24 (living room, kitchen with the fridge against its back wall, hall), garage x 8..20 attached on the right with an open doorway to the hall. Doors: front and back (3 m, 220 HP), side (west wall, 3 m, 220 HP), **garage door on the garage's east wall, facing the right-hand side yard** (5 m, 360 HP). Plants walk and shoot through their own doors; zombie shots hurt them. The heightmap is a 1 m grid (cm precision, sent once in the welcome as base64) sampled with the same triangles on both sides; ledges (deck 0.9 m with steps, three stone terraces 0.9-1.0 m, bridge rails) are colliders you jump onto. Walkers step up 0.5 m and climb terrain faces up to a 1.2 slope; steeper terrain faces are walls in both directions. The storm-cellar basement is a pit in the heightmap under the living room, reached by a stair trench on the west side of the house (1 m parapet).
**Plots.** Four plots of 4 x 4 slots (3.5 m apart) instead of one wide garden; rows outermost first are Peashooter / Cactus / Cactus / Peashooter, any plant fits any slot. Plants spawn on the front porch (and wilted kids respawn there); the Gardener rests there.
**Round.** `headStart` 15 s: zombies (bots and kids) wait in a fenced gate pen behind a wooden gate, cannot fire and cannot be hit; wave times are shifted by it. Plants start with 300 sunshine and an empty map (`features.initialGarden` stays as a test switch). Fridge Meter: `fillSeconds` 10 for one zombie, at most four count at once, within 2 m of the spot in front of the fridge inside the kitchen; it never drains; the HUD draws it as "Fridge snacks left" (a full meter = empty fridge).
**Cover.** About 115 pieces from a seeded layout: ~50 gravestones, 16 rocks, 22 trees, 18 hedge segments (the hedge-lined right path), cans, a picnic table, a kiddie pool, 5 shed wall segments. HP: gravestone 60, rock 420, tree 240, hedge 70, trash can 45, picnic table 110, pool 50, shed wall 130. Anything that is not owned by the shooter's team damages it (peas too), splash and melee tools (weed eater 22 dps, hedge trimmer 40 dps) chew it, it stays broken for the round and comes back next round. Pieces lower than a step are walked over; pieces up to ~1.5 m can be hopped onto.
**Builds.** Plants (sunshine): Hedge Wall 25 (60 HP), Wooden Fence 45 (150 HP), plus the Wall-nut entry in the wheel (it plants a Wall-nut in the nearest slot). Zombie kids (brains): Tombstone Wall 25 (140 HP), Junk Barricade 10 (60 HP), Trash-can Tower 15 (90 HP). 3 x 1 / 2 x 1 / 1 x 1 footprints, rotate with R, 12 standing per player, within 14 m. Never inside plots, the house and garage, a 3.2 m strip in front of every door, the deck, the stairwell, the bridge, the shed, the gate pen, ditches or steep ground, never on top of people or turrets. Zombie kids start with 10 brains, earn 5 per hit (at most once per 0.5 s per target) on a plant, plant kid, door or plant-built wall, and 10 for a destroyed turret (cap 150).
**Parts.** 3 Batteries, 2 Gas Cans and 1 Spark Plug at random distinct spots out of 14 (garage 3, basement 3, shed 2, yard 6) every round. The Leaf Blower and Hedge Trimmer need a Battery, the Weed Eater a Gas Can, the mower all three; tools cannot be taken until powered, the Wheelbarrow needs nothing. A plant hit on the carrier knocks the part out of his hands (he cannot pick up for 2 s); Q drops it. About 1 in 5 zombie bots run a part errand (fetch, install, take the tool it powered), so bots wield tools again.
**Zombie bots** pick a route at spawn (front lawn 40 % - front door 60 % / side door 40 %; left gravel path 30 % - back door 70 % / side door 30 %; right hedge path 30 % - garage door), walk its waypoints, shoot whatever destructible thing blocks them (a closed door, a fort wall, a gravestone) and then head for the fridge on a hand-placed waypoint graph. They no longer stop to snipe turrets: the plants win by shooting them on the way.
**Balance** (`node scripts/balance.mjs 30`): a plant kid who never plants loses the fridge in about 75 s. A scripted decent kid (plants all four plots, gets sunshine, shoots, upgrades, a hedge now and then, with human-sized lapses) loses the fridge in 10 % of Easy rounds and 40 % of Normal rounds; versus on Normal (that kid against an autopilot zombie kid) 47 %, Easy 27 %. A defence of the front lawn only loses about 95 % of the time. Knobs: Normal waves 4 + n (Easy 2 + n, as before), doors 220 / 360 HP, fridge 10 s. About 10 / 40 % of the zombie bots on a route reach its door on a good defence.
**Client.** One merged terrain mesh, painted gravel ribbons, merged static decor (plain coloured parts share one vertex-coloured material) and instanced cover and builds: 40-60 draw calls and about 100 k triangles in game views (150 for the whole yard from the air). Phones: Build / Place / Turn / Back buttons, wheel buttons tap-to-pick. Loading screen shows the one-sentence rule of your team (and both in the waiting room).

## Seven levels, flower pots, door repair, a smarter Gardener, loop sounds (2026-10-18, second pass)

Plan: `docs/superpowers/plans/2026-10-18-difficulty-and-pots.md`. Everything below is in the code; the numbers are in `server/sim/config.js`.

### Difficulty levels: Easy, Normal, Hard, Very Hard, Expert, Nightmare, Insane

**A level toughens the team the kids are fighting** (`game.recomputeScaling()`, `game.scaling`):

| Kids are on | Level scales | Stays at |
|---|---|---|
| only the plants | the **zombie bots**: wave size, HP, aim error, fire rate, reaction time, speed, shoot range, shot lead, how smartly they pick a door, how many of a wave go for the weakest door together, parts / mower errands | the plant side (no toughness) |
| only the zombies | the **plant side**: door HP and repair speed, garden plant HP / damage / fire rate, flower pot HP, and the Gardeners (count, HP, aim, speed, smarts, passive sunshine) | the zombie bots (the kid's allies) at Normal numbers |
| both (versus) | the zombie bots in full **and** the plant side's toughness at half (`config.versusToughShare` 0.5; there is no Gardener) | |

It is recomputed when the round starts and whenever a kid joins or leaves; things that already exist keep the numbers they were made with (doors and bots at round start, plants and pots when they are planted), so a change mid-round shows in what is created from then on. Easy and Normal toughen nothing (Easy's plant side is Normal's, Easy's zombie bots are the old Easy bots). A level is a row of `config.difficulties`; old `easy` / `normal` ids stay valid, `normalizeDifficulty()` also takes "Very Hard". The lobby create form and the host's waiting-room options show the 7 levels as a 4 + 3 button grid (heat-coloured, labelled "Difficulty - makes the other team tougher"); the lobby list shows the level name.

Zombie side (plants-only kids), per level Easy / Normal / Hard / Very Hard / Expert / Nightmare / Insane:

| | Easy | Normal | Hard | Very Hard | Expert | Nightmare | Insane |
|---|---|---|---|---|---|---|---|
| wave size (n = wave number) | 2+n | 4+n | 4.35+1.05n | 4.42+1.06n | 4.53+1.07n | 4.77+1.11n | 5.19+1.17n |
| zombie bot HP (x5) | 1 | 1 | 1 | 1.05 | 1.1 | 1.2 | 1.3 |
| aim error (rad) | 0.15 | 0.14 | 0.135 | 0.134 | 0.132 | 0.128 | 0.122 |
| fire rate (x weapon) | 0.3 | 0.3 | 0.323 | 0.327 | 0.334 | 0.349 | 0.377 |
| reaction (s) | 0.8 | 0.4 | 0.385 | 0.382 | 0.378 | 0.367 | 0.349 |
| speed / shoot range | 1 / 1 | 1 / 1 | 1.02 / 1.05 | 1.02 / 1.1 | 1.03 / 1.15 | 1.04 / 1.2 | 1.07 / 1.3 |
| shot lead / door smartness | 0 / 0 | 0 / 0 | .2 / .25 | .4 / .45 | .6 / .65 | .8 / .85 | 1 / 1 |
| wave focus on the weakest door | 0 | 0 | .04 | .048 | .06 | .088 | .136 |
| parts / mower errand chance x | 1 | 1 | 1.2 | 1.4 | 1.7 | 2 | 2.4 |

The raw numbers look close together on purpose: the system is very sensitive (the sims show a few percent more fire rate or one more zombie per wave moves a scripted kid from "holds" to "collapses"), so the ladder is a series of small steps plus behaviour that scripted kids cannot show but people feel (leading your shots, going for your weakest door together, a longer reach, tougher zombies). The "smart" bots weigh the five routes by how weak each door is (plants in its plot, door health, broken = weakest); `focus` sends a share of every wave to the wave's weakest door together.

Plant side (zombie-only kids), insane = doors x3 HP, repair x1.5, plants x2 HP x1.5 damage x1.25 fire rate, pots x3 HP; the other levels are fractions of that (Hard 7 %, Very Hard 15 %, Expert 30 %, Nightmare 40 % of the way from x1). Gardeners: see below.

Autopilot zombie kids (the harness's scripted kid) keep one fixed skill (`config.autopilot`), so a level changes the computer players, never the "player".

### The Gardener

Easy / Normal keep the old basic Gardener untouched. Hard and up use the planner in `server/sim/gardener.js` (`brain: 'smart'`):

- **Watches all four doors.** Each door's need = (zombies near it + zombies routed to it, including ones still held in the gate pen, + the route odds) / (its plot's firepower + 5). It spends where the need is greatest, with a bias for the door it is at (and for its own half when there are two Gardeners).
- **A sensible mix** by slot role (row 0 faces the zombies): snipers at the back (Melon-pult, House Plant, Cactus), repeaters / Gatling in the middle, Snow Peas in the second row (they slow), Spike Squash and repeaters in front, Wall-nuts only at the two chokepoint slots of the front row. Better plants unlock over the round (one tier per `tierEvery` seconds up to the level's cap: tier 2 at Hard .. 7 at Insane). Replants what dies, then **upgrades** the plant that gains the most firepower per sunshine in the busiest plot.
- **Forts** (Very Hard and up): Wooden Fences across the zombies' routes 18-38 m from the door, never inside a plot (the normal build rules), at most `forts` standing.
- **Doors**: repairs a door below the level's threshold and rebuilds a broken one (Very Hard and up), at the repair pile, only when nobody is near the door; two Gardeners never mend the same door.
- **The last line** (Expert and up): `pots` flower pots with plants in them in the kitchen and hall (best spots first: clear line to the fridge and the doorways), placed once a door is down or the outside is planted; **when zombies are inside the house one Gardener falls back to the kitchen** and shoots the fridge raiders first (the other keeps working outdoors).
- **Collects sunshine** (Expert and up, within `collect` metres: 6 / 14 / 24): what converted zombies leave behind.
- **Shoots** with the level's aim error, fire rate, reaction time, shot lead, headshot share (aims for the head with probability `head`, 3x damage) and strafing (`strafe`), prefers raiders at the fridge, then anyone inside the house, then the closest; it shoots the mower and zombie forts in its way, and hops up decks and terraces.
- **Count and HP**: one Gardener from Hard to Nightmare, **two at Insane** (one is not enough against the strongest allies; they split the doors and the work). A wilted Gardener comes back after `respawn` seconds (8 .. 4) with the sunshine it had - dying costs time, not a refill. HP 100 / 110 / 125 / 150 / 200. The passive sunshine trickle *shrinks* as the Gardeners get better at earning it (4, 3.5, 1.4, 0, 0.5 per second): the levels differ in capability, and the trickle is the knob that keeps the ladder smooth.

### Flower pots

A pot is a plant build kind (`config.builds.plant`, `pot: true`; **P** key, the build wheel's third entry, the touch POT button), 25 sunshine, 90 HP, at most 10 per kid (apart from the 12-fort cap), placed on the 1 m grid from **inside the house** on the living room, kitchen or hall floor (not the garage). Rules (`server/sim/pots.js`, mirrored by `client/map.js potProblem` and tested against each other): never within 1.5 m of a bot walkway (every waypoint edge that touches the house, which covers the doorways and the way to the fridge), within 1.7 m of the fridge spot, within 1.3 m of a repair pile, nor closer than 2.2 m to another pot, so no layout of pots can wall a room off (tested with a flood fill). A pot is a garden slot: any unlocked plant can be planted in it (`tryPlant` / seed keys / seed cards) and levelled up (U); a Wall-nut in a pot does not block by itself. The pot is solid, takes zombie shots, tools and splash, and its plant dies with it. Client: round ghost, terracotta pot with a cream band, "Press 1-n to plant in this pot!", the build bar counts "3 / 10".

### Door repair and health bars

Every door has a **repair pile** just inside it (planks leaning on a crate, a stack of boards, a red toolbox, a hammer, a small sign; `WORLD.repair`). A plant kid or Gardener standing within 1.8 m of the pile and **holding E** (touch: hold USE; prompt "Hold E to repair Back Door") without moving, jumping or shooting heals the door **9 HP/s** (x the level's repair factor), free; two repairers add up. A broken door is **rebuilt** after 3 s of work (a hammer every half second) and comes back with 25 % HP; it cannot finish while a zombie stands in the doorway. Being hit pauses the work for 1.2 s (a rebuild starts over). Snapshots carry `doors` (HP of front, side, back, garage; 0 = broken) and `doorMax`, entities carry `repairing` (door id) and `rebuild` (0..1); events `repair` and `doorUp` drive the hammer sound and sparkles.

Every door shows a **health bar on both faces** (one canvas atlas texture with a row per door and one merged mesh of 8 quads = one draw call; a row is redrawn only when its bar moves a pixel or the door breaks / is rebuilt; green -> amber -> red, "BROKEN" on a red bar) and a small **door card** under the crosshair (name, bar, "180 / 660" or BROKEN) for the door within 8 m, for both teams.

### Looping sounds (the fridge alarm bug)

The alarm level was driven by `snap.fridge.n`, which the sim freezes when a round ends with zombies at the fridge, and the "not in a round" branch of the render loop stopped the tool loops but never the alarm; leaving a lobby only stopped the mower. `client/soundstate.js` (`LoopMixer`, `loopsAllowed`, `alarmTarget`) is now the only thing that drives the loops (alarm, mower engine, weed eater, blower, trimmer, wheelbarrow squeak): they may sound only while we are in the game and the phase is `playing`; every other moment (round over, back in a lobby, lost connection) cuts them dead (`Sound.stopAll()`, no fade) and they cannot restart. The server also zeroes `fridge.n` and the tools' `using` when a round ends. Unit tested with a fake sound (`test/soundstate.test.js`).

### Balance (`node scripts/balance.mjs 96`)

Zombie win % (mean round length) over 96 seeded rounds per cell. `afk` = a plant kid who never plants, `decent` = the scripted kid (plants every plot, collects sun, shoots, upgrades, rebuilds a broken door), `good` = a plant kid played by the Gardener's planner with a human's gun, `versus` = decent kid vs the autopilot zombie kid (both sides get the level), `zraid` = the autopilot zombie kid + **Normal** bots vs the Gardener(s) and toughened plant side, `zpro` = a superhuman zombie kid (1.2x fire rate, aim error 0.03, instant reactions) with Normal bots, `zsolo` = a strong kid alone, no bots.

```
zombie win % (mean round s)         easy      normal        hard    veryhard      expert   nightmare      insane
afk                           100% (86s)  100% (76s)  100% (74s)  100% (74s)  100% (70s)  100% (70s)  100% (69s)
decent                        16% (446s)  47% (410s)  75% (354s)  89% (313s)  96% (259s) 100% (253s) 100% (164s)
good                           1% (457s)   4% (454s)  25% (434s)  59% (388s)  68% (377s)  92% (308s)  99% (164s)
versus                        15% (458s)  54% (396s)  77% (347s)  89% (293s)  89% (278s)  92% (263s)  93% (251s)
zraid                         78% (188s)  78% (188s)  71% (390s)  42% (454s)  27% (459s)  14% (469s)   0% (480s)
zpro                          98% (107s)  98% (107s) 100% (161s)  95% (280s)  78% (341s)  59% (408s)   0% (480s)
zsolo                         30% (353s)  30% (353s)  11% (442s)  10% (452s)   0% (480s)   0% (480s)   0% (480s)
```

Both ladders are monotone, loosely asserted by `test/balance.test.js`: plant kids lose more and sooner level by level (decent, good); zombie kids beat the Gardeners less and less (zraid, zsolo; Easy and Normal are the very same rounds because the plant side and the allies are the same). `versus` is informational: both sides get tougher (the bots in full, the plant side at half), so it climbs and then flattens. Sensitivity is high (a few percent more fire rate or one more sunshine per second moves a scripted kid from "holds" to "collapses"), which is why the table was tuned with 48-96 seed cells and the guard-rails leave room.

### Deviations from the brief

- Zombie bots do not build forts (they have no brains); the harder levels instead break forts the same way as before, but with more bots at once, better aim and weakest-door focus.
- The decent scripted kid only rebuilds a *broken* door (mending hurt doors cost it more defence than it saved in the sims).
- The passive sunshine trickle of the Gardeners falls with the level (see above) instead of rising; capability rises.
- Insane is two Gardeners; Expert and Nightmare are one Gardener with more tools (pots / retreat / collect), not two (two Gardeners is a step that no income tuning could smooth).
