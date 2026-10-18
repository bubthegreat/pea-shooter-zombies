# Backyard Battle — Design

Working title. A 3D first-person shooter in the style of Halo, with a Plants vs. Zombies theme, played in a web browser and hosted on the family's home computer.

## Why

Two kids (Jacob and J-Bob) want a game they can play together on their computers. It has to be free with no ads, and it should feel like Halo (first-person, 3D, guns, upgrades) with the look and theme of Plants vs. Zombies. Their parent can host web games from home, so it runs as a web page served from the house.

The parent also wants it to keep the excitement in balance. It should be fun without the compulsive hooks of commercial games.

## Goals

- First-person 3D shooter that runs in a desktop browser (Chrome), controlled with keyboard and mouse.
- Two teams, **Plants** and **Zombies**, and either kid can play either team.
- Two modes, picked at the start:
  - **Co-op:** both kids on the same team, against computer-controlled (bot) enemies.
  - **Versus:** one kid on each team, each on their own computer. Bots fill out both teams so the yard doesn't feel empty.
- Upgrades for both teams are the core reward.
- Served from a home machine. The kids' computers just open a URL.

## Non-goals (v1)

- Playing over the internet with people outside the house. LAN/home network only.
- Accounts, logins, saved progress between sessions, or leaderboards.
- Mobile or touch support, and gamepad support.
- Any original Plants vs. Zombies assets, names beyond generic ones (peashooter, cactus), or branding. All art and sound is original or freely licensed.

## Anti-goals (a failure even if it works)

- Ads, purchases, or anything that sends kids to an outside site.
- Gore, blood, or scary horror. Zombies are goofy and cartoonish, PvZ-style.
- Compulsion loops: loot boxes, daily rewards, endless grind, or "one more round" timers. Rounds have a clear end (sunrise or a team wiped out).
- Getting knocked out permanently and having to sit and watch. Every player is always back in the action within a few seconds.

## The world

One map: a made-up **backyard**.
- Grass yard, with zombies coming in from the far end (fence, gate, or woods).
- A **garden** near the house, where planted plants stand in rows. Front to back: **Peashooters, Cactus, Cactus, Peashooters**.
- A **house** with a **garage**. The **lawnmower** is in the garage.
- Bright and colorful, with a day/night sky. A round starts at night and ends at **sunrise**.

## Teams and core rules

### Hits and converting (the kids' rule)
- Plants shoot zombies. A zombie that takes enough hits (**5** with normal guns) **turns into a plant** and joins the plant team. This applies to bots and to kid players. A converted kid keeps playing, now as a plant.
- Some plant weapons convert in **1 hit** (the top upgrade, see House Gun). J-Bob asked for one-hit, Jacob asked for five, and this gives both.
- Zombies shoot plants. A plant player who takes too much damage "wilts" and respawns at the house after a few seconds. Plants never turn into zombies; conversion only goes one way.
- Zombies can also damage and destroy planted plants.

### How the Zombies win
*(Replaced by the Fridge Meter in Map v2, see `2026-10-18-map-v2-design.md`: zombies now win by raiding the fridge. The mower still exists but needs three parts and is only a weapon.)*
Get into the garage, grab the lawnmower, and **mow down the whole garden** (every planted plant).
- Starting the mower takes a few seconds, which gives plants a last chance to stop it.
- A zombie driving the mower can be shot. If that zombie is converted, the mower stops and stays where it is for another zombie to grab.
- Mowing plants earns zombies upgrades.

### How the Plants win
Either:
- **Convert every zombie** (bots and players) into a plant, or
- **Survive until sunrise** with at least some of the garden still standing. The round has a fixed length, and the sky brightens as it goes.

### Planting (J-Bob's request)
- Plant players earn **sunshine** by beating zombies and picking up sun drops in the yard.
- They spend sunshine to plant new Peashooters and Cactuses in the garden.
- Planted plants are stationary and shoot automatically:
  - **Peashooter:** medium range, steady fire.
  - **Cactus:** long range, shoots spiky balls. It's the "sniper" plant and J-Bob's favorite.

## Upgrades

Upgrades swap your gun for a better one, earned during a round. Both earning paths count:
- **Kills:** each zombie converted (plants) or plant destroyed or mowed (zombies) adds progress toward the next upgrade. This was J-Bob's ask.
- **Streak bonus:** beat 10 enemies in a row without being hurt and you get a big jump, skipping ahead an upgrade. This was Jacob's ask.
- Dying or wilting doesn't take upgrades away during a round. Everything resets at the start of the next round.

### Plant gun ladder (replaced by "Plant upgrades (2026-10-18)" below)
1. Pea Blaster (start)
2. Pea Rifle
3. Spike Shotgun (Jacob's shotgun; spiky cactus balls, close range)
4. **House Gun** (J-Bob's giant gun; converts a zombie in one hit). Top tier.

### Zombie gun ladder
1. Starter blaster
2. Rifle
3. Shotgun-type
4. **Auto-Shot Rifle**. Top tier.

Exact names, damage, fire rate, and upgrade thresholds are left to the builder to tune for fun. Aim for each kid reaching the top gun in most rounds.

## Modes in detail

- **Co-op:** before the round, the kids pick a team together. The other team is all bots.
- **Versus:** each kid picks a different team. Bots join both sides (for example, 3–5 zombie bots, plus plant bots and pre-planted garden plants).
- Bots need to be beatable by young kids: slow-ish, not pinpoint accurate. A simple difficulty setting (Easy / Normal) is welcome.

## How it gets made (my calls; the parent can override)

- **Client:** Three.js in the browser. Pointer-lock mouse look, WASD movement, mouse to shoot, keys for planting.
- **Server:** a small Node.js server with WebSockets, running on the home machine. It serves the game files and runs the authoritative game state (bots, hits, conversion, mower, timer). The kids' browsers connect to `http://<home-machine>:<port>`.
- **Hosting:** a single `npm start`, plus optionally a Dockerfile for the parent's setup. No internet connection is needed once installed.
- **Art:** simple stylized low-poly models built in code or from free CC0 assets. Charm over detail.
- **Lobby:** the landing page lets you type a name, pick a mode, and pick a team. No accounts.

## Calls made after review (approved by parent, 2026-10-18)

- **Zombie waves:** zombie bots arrive in waves from the far end of the yard until sunrise. The last wave comes just before sunrise. Plants win by converting the final wave, or by reaching sunrise with any garden left.
- **Converted kid players:** bots who get converted stay plants for good. A kid playing zombie who gets converted becomes a little sprout for about 5 seconds, then digs back up as a zombie at the gate. Upgrades are kept. This keeps Versus two-sided, and nobody sits out.
- **Converted bots** become walking plant-team bots that fight alongside the plants. They are not garden plants. *(Superseded by the playtest changes below: converted bots now poof into sunshine.)*
- **Garden loss:** zombies win the moment the garden has zero planted plants, no matter what destroyed them (mower or gunfire). Plants can replant any time with sunshine. The mower destroys any planted plant it drives over.
- **Players per game:** one game at a time, up to 2 human players.

## Left to the builder

- Exact numbers: health, damage, round length (suggested 6–10 minutes), mower start time, sunshine costs, bot counts.
- Visual style details, sounds, and music, keeping them cheerful and not scary.
- Network architecture details, as long as two home computers play smoothly together.
- Code structure, test approach, and build tooling.

## Playtest changes 2026-10-18

After the first family playtest ("Dad's list"), these changes replace or extend what is written above.

**A. No plant soldiers.** The walking plant-soldier bots are gone: no converted-zombie soldiers and no computer defenders.
The plant team is the human plant kids (who keep their guns and the whole upgrade ladder) plus the turrets they plant.
A converted zombie bot bursts into a flower poof and drops a sunshine pickup worth `sunValue` where it stood (a converted kid
still sprouts and digs back up as a zombie, and pays `sunPerConversion` directly). *Exception:* when nobody on the plant team is
human (for example both kids are zombies in co-op), exactly one computer **Gardener** appears. It walks the garden replanting empty
slots from its own passive sunshine income (about 10 per second), shoots only weakly, and comes back a few seconds after it wilts.
It leaves as soon as a human takes the plant side. Plants still win by clearing the final wave or reaching sunrise. A converted
kid who is still sprouting counts as a zombie for the "final wave cleared" check.

**B. Shotguns feel like upgrades.** Tight spread (about 0.045 rad) and 8 pellets: a whole Spike Shotgun blast under 10 m converts a
zombie, and headshot pellets do even more. The Zombie Shotgun is the same idea against plants.

**C. Enemy bullets you can dodge.** Zombie shots travel about 20 m/s (plant turret peas stay fast), are drawn big, bright and glowing
(purple/magenta goo with a short trail), and zombie bots fire about 40% less often. Hit radii are a bit larger so what you see is what
hurts you.

**D. Headshots.** The top 0.4 m of the 1.8 m body is the head: triple damage for shots from players and bots against players and bots
(not garden turrets, not splash). The `hit` event carries `head: true`; the shooter gets a "HEADSHOT!" pop and a ding.

**E. Eight-rung gun ladders** (the plant half was replaced by plant upgrades, see the last section). Kills needed (cumulative): 0, 2, 4, 7, 10, 14, 18, 23, so a decent kid reaches the top most rounds.
The 10-in-a-row no-hurt bonus still skips one rung.
Plants: Pea Blaster, Double Pea, Pea Rifle, Snow Pea (slows zombies 50% for 2 s), Spike Shotgun, Repeater (very fast), Melon Lobber
(arcing, splash), House Gun (one-hit convert).
Zombies: Goo Blaster, Slime Pistol, Zombie Rifle, Bone Burst (3-shot spread), Zombie Shotgun, Sludge Sprayer, Brain Cannon (big slow
splash orb), Auto-Shot Rifle. Every rung has its own first-person gun and its own shot look.

**F. The lawn mower driver is protected.** While driving, the zombie takes no damage; the mower has its own HP (40, shown over the
mower and on the driver's HUD). When it is destroyed it sputters out in a poof, the driver is dropped on foot unhurt, and a new mower
appears in the garage 20 seconds later. Pressing E again while driving hops off.

**G. Garage equipment rack (weed eater and friends).** Four lawn tools hang in the garage, one of each. A zombie presses E near a
hook to swap their gun for the tool, and Q (or E away from the rack) puts it down; E at the hook puts it straight back. A tool is
back on its hook 20 seconds after it is dropped, wrecked, or its holder is converted. Holders are not protected. About 1 in 4 zombie bots go for the mower and about 1 in 5 of the rest grab a tool
(the weed eater most often).
- *Weed Eater:* 3 m melee cone, shreds a garden plant in about 1.5 s (counts as a kill), moderate against plant kids. Very short range.
- *Leaf Blower:* 9 m cone, shoves plant kids backwards, swats light incoming shots, blows sunshine drops away. Almost no damage.
- *Hedge Trimmer:* 2 m, wilts a plant kid in about a second, chews turrets. The holder walks 25% slower.
- *Wheelbarrow:* pushed as a moving front shield that blocks plant shots from the front (30 HP); the pusher cannot attack and walks 15%
  slower; other zombies can hide behind it.
- *Lawn Mower* (unchanged apart from F): fastest way to clear the garden, but it is loud, a big target, and takes 3 s to start.

**H. Robustness fixes from review.** A throwing tick no longer stops the server loop; a join that times out retries on a fresh socket,
the server evicts a page's ghost connection by its client token and drops half-open sockets within about 6 s (3 s heartbeat);
planting uses a per-press counter (`plantSeq`) so rapid repeated presses all count; the mower snapshot names its driver.


**Balance after the changes** (`node scripts/balance.mjs`, seeded full rounds with scripted kids; no soldiers, so turrets carry the
defence). A plant kid who stands still all round: zombies win about 13% of Easy rounds and about 47% of Normal rounds; a plant kid who
shoots and replants wins every round. The mower is driven in most AFK rounds. Knobs: peashooter aim error 0.14, cactus damage 3
(range 50, aim error 0.12), bot aim error 0.16 / 0.14 (Easy / Normal) at fire scale 0.3, Easy waves 2+n and Normal waves 3+n, 25% of
bots chase the mower (via the right-hand flank).

## Plant upgrades (2026-10-18)

Feedback after the lobby playtest: "the planter has his own gun, but he shouldn't get an upgraded gun - he should be able to upgrade
his plants." This **replaces the plant gun ladder** (sections "Plant gun ladder" and playtest item E, plants half). The zombie gun
ladder is unchanged.

**One gun.** A plant kid has the Pea Blaster for the whole round. The kill meter (cumulative kills 0, 2, 4, 7, 10, 14, 18, 23, and the
10-in-a-row no-hurt bonus that skips one rung) is unchanged, but each rung now **unlocks a plant type** instead of a gun. Zombie kids
climb the gun ladder exactly as before.

| Tier (kills) | Unlocks | Cost | What it does |
|---|---|---|---|
| 0 (0) | Peashooter | 50 | medium range, steady fire (as before) |
| 0 (0) | Cactus | 100 | long range sniper, 3 damage (as before) |
| 1 (2) | Repeater | 125 | peas, twice the Peashooter's rate |
| 2 (4) | Snow Pea | 150 | frost peas, slow zombies 50% for 2 s |
| 3 (7) | Spike Squash | 175 | short range (12 m) shotgun spray: 8 spikes, tight spread |
| 4 (10) | Melon-pult | 200 | lobs an arcing melon (ballistic aim), 3.5 m splash, 7 damage |
| 5 (14) | Wall-nut | 150 | no attack, 400 HP, solid: blocks walking and soaks up shots |
| 6 (18) | Gatling Pea | 250 | 6 peas a second, long range |
| 7 (23) | House Plant | 300 | giant (3 m tall, 150 HP), slow fire, every shot converts a zombie in one hit |

Planting: the seed bar shows every unlocked plant with its cost; **keys 1-9** plant the nth one (nine plants, so nine keys; the
`plant` input is the key number 1-9, still sent with the `plantSeq` counter). **Any plant fits any slot** (the row kinds only decide
what the pre-planted garden and the Gardener put there); the nearest empty slot within 4 m is taken. Touch: the seed cards are the
buttons for the unlocked plants and the bar scrolls sideways.

Levels: a garden plant starts at level 1. **U** (touch: the UPGRADE button, which appears when it is offered) spends sunshine to raise
the plant you look at (30 degree cone) or, failing that, the nearest one within 3 m, to level 2 and then 3. Cost is 0.75x then 1.25x
the plant's price (Cactus 75 then 125). Each level above 1 adds **+40% damage, +25% fire rate and +50% max HP** (the plant is healed
to full). Level 3 is the top. Plants show their level: 1.15x / 1.3x model size and 2 / 3 gold stars (level 1 has none). The prompt
reads "Press U to upgrade Cactus ★★ - 75☀".

Protocol: the `upgrade` event for a plant kid is `{ id, tier, plantKind, plantKinds, name, bonus }` (newest unlock; HUD banner
"NEW PLANT! Snow Pea"); zombie kids still get `{ id, tier, weapon, name, bonus }`. Input gains `upgrade` (rising edge, like `use`).
Garden entities carry `level`; a successful upgrade emits `plantUp { id, plantKind, level, x, z, by }`. `publicConfig` carries all
nine `plantTypes` (`tier`, `name`, `cost`, `range`, `rate`, `damage`, `projKind`, `pellets`, `splash`, `slow`, `hp`, `radius`, `height`,
`noAttack`, `blocks`) and `plantLevels`. The Gardener (computer) only plants Peashooters and Cacti, and when the garden is full and it
has spare sunshine it levels one plant up now and then (at most every 45 s, keeping 100 sunshine back).

Sunshine is now the plant kids' power, so the economy is richer: start 200 (was 100), a sun drops every 3 s (was 8) with up to 10 on
the ground (was 6), 25 each as before. **Balance** (`node scripts/balance.mjs`, seeded full rounds): a plant kid who stands still:
zombies win about 10% of Easy rounds and 48% of Normal (Easy bot aim error 0.16 -> 0.15 keeps the old numbers); a scripted kid who
shoots, plants his three best unlocked plants and levels the weakest plant up: zombies win 0 of 100 co-op Normal rounds; versus
(scripted plant kid against a scripted zombie kid who shoots at the garden): zombies win about 48% (was about 45%).

