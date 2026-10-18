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
