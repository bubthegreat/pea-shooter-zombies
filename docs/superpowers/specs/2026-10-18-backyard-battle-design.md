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

### Plant gun ladder
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
- **Converted bots** become walking plant-team bots that fight alongside the plants. They are not garden plants.
- **Garden loss:** zombies win the moment the garden has zero planted plants, no matter what destroyed them (mower or gunfire). Plants can replant any time with sunshine. The mower destroys any planted plant it drives over.
- **Players per game:** one game at a time, up to 2 human players.

## Left to the builder

- Exact numbers: health, damage, round length (suggested 6–10 minutes), mower start time, sunshine costs, bot counts.
- Visual style details, sounds, and music, keeping them cheerful and not scary.
- Network architecture details, as long as two home computers play smoothly together.
- Code structure, test approach, and build tooling.
