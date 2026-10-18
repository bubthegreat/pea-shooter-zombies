# Backyard Battle

First-person plants-vs-zombies backyard shooter. Free, no ads, runs on your home network.

## Run

```bash
npm install
npm start
```

Open http://localhost:8080 (or `http://<this-computer's-LAN-IP>:8080` from another computer in the house). `PORT=9000 npm start` to change port.

## Play

- The front page is a **lobby browser**: pick a name and a team (Plants or Zombies), then **Join** a lobby from the live list (name, host, players, Co-op/Versus, bot difficulty, Waiting or Playing with the time left) or press **Create lobby** (it starts as "<your name>'s Backyard"; you choose Co-op or Versus and the bots).
- In the **waiting room** everyone sees who is in and on which team and can switch teams. Only the host sees **Start** and can change the game mode and bots; everybody else sees "Waiting for <host> to start". Joining a lobby that is already playing drops you straight into the game on the team you picked.
- If the host leaves, the player who has been there longest becomes host; when the last player leaves the lobby closes. When a round ends, everyone goes back to the waiting room (keeping their team) and the host starts the next one.
- There is no password and no account: the lobby name is all that identifies a lobby. Names are cut to 16 letters (lobby names to 32), invisible characters are removed, and they are only ever shown as plain text. Change your name any time from the settings panel (O).
- Other kids' names float over their heads (green for Plants, purple for Zombies, fading with distance), and the kill feed in the top right says who turned, wilted or mowed whom (with a target icon for headshots).
- **The big backyard.** A house in the middle with four doors (front, back, side, garage), a hilly yard with a creek and footbridge, a raised deck, stone terraces, a storm cellar, a shed, gravestones, rocks, trees and hedges. Everything in the yard can be shot to bits; broken doors and cover stay broken until the next round.
- **Plants** ("Plant your garden, guard every door, and hold on until sunrise!") start with 300 sunshine and an empty yard and get a **15 second head start**: the zombies wait behind the gate with a big countdown. Every door has its own garden plot of 16 empty slots; any plant goes in any slot. Plants win by turning the final wave or holding the fridge until sunrise. Zombies that get converted burst into a flower and leave sunshine to grab. Plant kids keep one gun (the Pea Blaster); their upgrades are **plants**: every few conversions unlock a new plant to put in the garden (Repeater, Snow Pea, Spike Squash, Melon-pult, Wall-nut, Gatling Pea, House Plant), and sunshine levels planted plants up to level 3.
- **Zombies** ("Break into the house and raid the fridge!") come out of the gate by three routes: the open front lawn, the gravel path round the left to the back door, or the hedge-lined path past the shed to the garage. Shoot a door down, get to the kitchen and stand by the fridge: every zombie there fills the **Fridge Meter** (10 seconds for one zombie, up to four count); an alarm rings and the plants have to shoot them off, because the meter never drains. A full meter is a zombie win.
- **Forts.** Press **B** to build: plants pay sunshine (Hedge Wall, Wooden Fence), zombie kids pay **brains** (Tombstone Wall, Junk Barricade, Trash-can Tower) that they earn by hitting plants, doors and walls. Up to 12 each; doorways, plots and the house stay free.
- **Mower parts.** The lawn mower and the garage tools start without power. Batteries, Gas Cans and a Spark Plug lie around the garage, basement, shed and yard (new places every round): carry one (E), put it in a tool hook or the mower (E), and the item works for the rest of the round (the mower needs all three). Shoot a zombie who is carrying one and he drops it.
- Zombie kids beat plants to upgrade their gun (8 guns); plant kids unlock plants instead (9 plants). Hit the head (top of the body) for triple damage. Beat 10 in a row without getting hurt for a bonus jump.
- If both kids play zombies, a computer Gardener plants the plots.

## Controls

| Key | Action |
|---|---|
| W A S D / arrows | Move |
| Mouse | Look (click to lock, Esc to free) |
| Left click | Shoot |
| Space | Jump |
| 1-9 | Plants: plant the nth plant from the seed bar (1 Peashooter 50, 2 Cactus 100, then 3 Repeater, 4 Snow Pea, 5 Spike Squash, 6 Melon-pult, 7 Wall-nut, 8 Gatling Pea, 9 House Plant as you unlock them) in the nearest empty garden spot |
| U | Plants: upgrade the garden plant you look at (or the nearest within 3 m) to level 2, then 3 (costs sunshine). On a phone: the UPGRADE button |
| B | Open the build wheel (1-5 or the scroll wheel picks, click places, R turns, B cancels). On a phone: BUILD, then PLACE / TURN / BACK |
| E | Zombies: pick up a part, put a part into the mower or a tool hook; hold near the lawnmower to start it (needs all three parts), press again while driving to hop off; press at a powered garage hook to grab a lawn tool (press again away from the rack to drop it) |
| Q | Zombies: put down the lawn tool or the part you are holding |
| Left click (hold) | Use the lawn tool you are holding (Weed Eater / Leaf Blower / Hedge Trimmer; the Wheelbarrow just blocks shots) |
| M / H | Mute / help |
| O | Settings: your name, invert up/down, invert left/right, mouse speed (0.25x-3x), Leave lobby. Also the gear button, or "Settings" in the lobby screens. Saved in your browser. |

## Lobbies (for developers)

One server process holds many independent games. `server/lobby.js` (`LobbyManager`) owns the lobbies; each has its own `Game`, tick accumulator and snapshot fan-out (only to its own sockets), so bots and waves are per lobby. `server/index.js` is transport only. State is in memory, so a restart or deploy drops every lobby. Hidden safety caps: 50 players per lobby, 20 lobbies per server (`MAX_PLAYERS_PER_LOBBY`, `MAX_LOBBIES` in `server/lobby.js`).

WebSocket messages (JSON). Client to server: `listLobbies` (also carries the page's client token `cid` and name; a token that was in a lobby a moment ago is put back into it), `createLobby {lobbyName, mode, difficulty, team, name, cid}`, `joinLobby {lobbyId, team, name, cid}`, `leaveLobby`, `setTeam {team}`, `setOptions {mode, difficulty}` (host, waiting room), `startGame` (host), `setName {name}`, and `input` (unchanged). Server to client: `lobbies {lobbies}` (pushed to browsing clients whenever the list changes), `lobbyState {you, lobby}` (`lobby: null` when you are not in one), `welcome {id, config}` (you are now in a running game), `snap` (unchanged), `error {reason, message}`. The old `join` message is gone.

## Develop

`npm test` runs the server simulation tests. Tunables live in `server/sim/config.js`. `node scripts/balance.mjs [seeds] [scenario...]` plays seeded rounds headlessly (AFK kid, a front-lawn-only kid, a scripted decent kid, an autopilot zombie kid, versus) and prints win rates, door and route usage and fridge stats; `BAL_CFG='{"fridge":{"fillSeconds":12}}'` overrides config values for an experiment. Design and plan in `docs/superpowers/` (the map v2 spec ends with an "As built" section).

### The map (for developers)

`server/sim/world.js` (layout constants), `terrain.js` (the heightmap grid), `map.js` (walls, furniture, doors, cover layout via `cover-layout.js`, waypoint graph, routes, part spots), `collide.js` (spatial hash of box / cylinder colliders: movement, ground height, projectile and line-of-sight tests), `cover.js` (HP, break, builds), `build.js` (placement rules), `parts.js`, `fridge.js`, `nav.js`. The static map goes to the client once in `welcome.config.map` and `welcome.state` carries what changed since the round began (broken pieces, damage, builds); afterwards changes arrive as events (`coverHit`, `coverBreak`, `build`, `buildFail`, `partTake`, `partDrop`, `install`, `fridgeAlarm`, `release`). Snapshots add `round`, `headStart`, `fridge {m, n}` and the entities `part` / `carry` / `brains`. Input adds `build`, `bx`, `bz`, `br`, `buildSeq`. The client mirrors the build rules for the ghost preview in `client/map.js`; `client/level.js` and `client/cover3d.js` draw the level.
