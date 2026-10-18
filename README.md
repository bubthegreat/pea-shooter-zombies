# Backyard Battle

First-person plants-vs-zombies backyard shooter. Free, no ads, runs on your home network.

## Run

```bash
npm install
npm start
```

Open http://localhost:8080 (or `http://<this-computer's-LAN-IP>:8080` from another computer in the house). `PORT=9000 npm start` to change port.

## Play

- Pick a name, team (Plants or Zombies), mode (Co-op or Versus), difficulty. First player picks the mode.
- **Plants** win by turning every zombie into a plant, or holding the garden until sunrise. Zombies that get converted burst into a flower and leave sunshine to grab. Plant sunshine to grow more Peashooters and Cacti.
- **Zombies** win by wrecking the whole garden. The garage has a lawnmower (the driver can't be hurt, but the mower can be wrecked) and a rack of lawn tools: Weed Eater, Leaf Blower, Hedge Trimmer, Wheelbarrow.
- Beat enemies to upgrade your gun (8 guns each way). Hit the head (top of the body) for triple damage. Beat 10 in a row without getting hurt for a bonus jump.
- If both kids play zombies, a computer Gardener tends the garden.

## Controls

| Key | Action |
|---|---|
| W A S D / arrows | Move |
| Mouse | Look (click to lock, Esc to free) |
| Left click | Shoot |
| Space | Jump |
| 1 / 2 | Plant Peashooter (50 sun) / Cactus (100 sun) |
| E | Zombies: hold near the lawnmower to start it, press again while driving to hop off; press at a garage hook to grab a lawn tool (press again away from the rack to drop it) |
| Q | Zombies: put down the lawn tool you are holding (back to your gun) |
| Left click (hold) | Use the lawn tool you are holding (Weed Eater / Leaf Blower / Hedge Trimmer; the Wheelbarrow just blocks shots) |
| M / H | Mute / help |
| O | Look settings: invert up/down, invert left/right, mouse speed (0.25x-3x). Also the gear button, or "Look settings" in the lobby. Saved in your browser. |

## Develop

`npm test` runs the server simulation tests. Tunables live in `server/sim/config.js`. `node scripts/balance.mjs [seeds] [scenario...]` plays seeded rounds headlessly (AFK kids, scripted kids) and prints win rates, mower and tool usage; `BAL_CFG='{"mowerBotChance":0.4}'` overrides config values for an experiment. Design and plan in `docs/superpowers/`.
