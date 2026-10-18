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
- **Plants** win by turning every zombie into a plant, or holding the garden until sunrise. Zombies that get converted burst into a flower and leave sunshine to grab. Plant kids keep one gun (the Pea Blaster); their upgrades are **plants**: every few conversions unlock a new plant to put in the garden (Repeater, Snow Pea, Spike Squash, Melon-pult, Wall-nut, Gatling Pea, House Plant), and sunshine levels planted plants up to level 3.
- **Zombies** win by wrecking the whole garden. The garage has a lawnmower (the driver can't be hurt, but the mower can be wrecked) and a rack of lawn tools: Weed Eater, Leaf Blower, Hedge Trimmer, Wheelbarrow.
- Zombie kids beat plants to upgrade their gun (8 guns); plant kids unlock plants instead (9 plants). Hit the head (top of the body) for triple damage. Beat 10 in a row without getting hurt for a bonus jump.
- If both kids play zombies, a computer Gardener tends the garden.

## Controls

| Key | Action |
|---|---|
| W A S D / arrows | Move |
| Mouse | Look (click to lock, Esc to free) |
| Left click | Shoot |
| Space | Jump |
| 1-9 | Plants: plant the nth plant from the seed bar (1 Peashooter 50, 2 Cactus 100, then 3 Repeater, 4 Snow Pea, 5 Spike Squash, 6 Melon-pult, 7 Wall-nut, 8 Gatling Pea, 9 House Plant as you unlock them) in the nearest empty garden spot |
| U | Plants: upgrade the garden plant you look at (or the nearest within 3 m) to level 2, then 3 (costs sunshine). On a phone: the UPGRADE button |
| E | Zombies: hold near the lawnmower to start it, press again while driving to hop off; press at a garage hook to grab a lawn tool (press again away from the rack to drop it) |
| Q | Zombies: put down the lawn tool you are holding (back to your gun) |
| Left click (hold) | Use the lawn tool you are holding (Weed Eater / Leaf Blower / Hedge Trimmer; the Wheelbarrow just blocks shots) |
| M / H | Mute / help |
| O | Settings: your name, invert up/down, invert left/right, mouse speed (0.25x-3x), Leave lobby. Also the gear button, or "Settings" in the lobby screens. Saved in your browser. |

## Lobbies (for developers)

One server process holds many independent games. `server/lobby.js` (`LobbyManager`) owns the lobbies; each has its own `Game`, tick accumulator and snapshot fan-out (only to its own sockets), so bots and waves are per lobby. `server/index.js` is transport only. State is in memory, so a restart or deploy drops every lobby. Hidden safety caps: 50 players per lobby, 20 lobbies per server (`MAX_PLAYERS_PER_LOBBY`, `MAX_LOBBIES` in `server/lobby.js`).

WebSocket messages (JSON). Client to server: `listLobbies` (also carries the page's client token `cid` and name; a token that was in a lobby a moment ago is put back into it), `createLobby {lobbyName, mode, difficulty, team, name, cid}`, `joinLobby {lobbyId, team, name, cid}`, `leaveLobby`, `setTeam {team}`, `setOptions {mode, difficulty}` (host, waiting room), `startGame` (host), `setName {name}`, and `input` (unchanged). Server to client: `lobbies {lobbies}` (pushed to browsing clients whenever the list changes), `lobbyState {you, lobby}` (`lobby: null` when you are not in one), `welcome {id, config}` (you are now in a running game), `snap` (unchanged), `error {reason, message}`. The old `join` message is gone.

## Develop

`npm test` runs the server simulation tests. Tunables live in `server/sim/config.js`. `node scripts/balance.mjs [seeds] [scenario...]` plays seeded rounds headlessly (AFK kids, scripted kids) and prints win rates, mower and tool usage; `BAL_CFG='{"mowerBotChance":0.4}'` overrides config values for an experiment. Design and plan in `docs/superpowers/`.
