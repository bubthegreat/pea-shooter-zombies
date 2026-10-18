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
- **Plants** win by turning every zombie into a plant, or holding the garden until sunrise.
- **Zombies** win by wrecking the whole garden — grab the lawnmower from the garage to mow it down fast.
- Beat enemies to upgrade your gun. Beat 10 in a row without getting hurt for a bonus jump.

## Controls

| Key | Action |
|---|---|
| W A S D / arrows | Move |
| Mouse | Look (click to lock, Esc to free) |
| Left click | Shoot |
| Space | Jump |
| 1 / 2 | Plant Peashooter (50 sun) / Cactus (100 sun) |
| E (hold) | Start the lawnmower (zombies) |
| M / H | Mute / help |

## Develop

`npm test` runs the server simulation tests. Tunables live in `server/sim/config.js`. Design and plan in `docs/superpowers/`.
