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
