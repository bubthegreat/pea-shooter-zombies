# Plant upgrades - implementation plan (2026-10-18)

Feedback: "the planter has his own gun, but he shouldn't get an upgraded gun - he should be able to upgrade his plants."

## Design

- Plant humans keep ONE gun all round: the Pea Blaster. The zombie gun ladder is unchanged.
- The kill meter (`tierThresholds`, streak +1 bonus) is unchanged but a plant kid's **tier unlocks plant types** (not guns):
  tier 0 Peashooter + Cactus, 1 Repeater, 2 Snow Pea, 3 Spike Squash, 4 Melon-pult, 5 Wall-nut, 6 Gatling Pea, 7 House Plant.
  The `upgrade` event for plant kids is `{ id, tier, plantKind, name, bonus }` (`plantKind` = newest unlock).
- `config.plantTypes` holds all nine types (`tier`, `name`, `cost`, stats; optional `pellets`, `spread`, `splash`, `gravity`,
  `lob`, `slow`, `life`, `hp`, `radius`, `height`, `blocks`, `noAttack`). Key order is the planting order: **key / `input.plant` 1..9**
  (nine plants, so digit 9 too).
- Any plant can go in any slot; `slot.kind` stays only as the default for the pre-planted garden and the Gardener.
  Planting takes the nearest empty slot within `plantRange` (4 m).
- Plant levels 1..3: `upgrade` input edge (key U) -> `tryUpgrade`: the garden plant within 3 m that the kid looks at (30 deg cone),
  else the nearest. Cost 0.75x / 1.25x the base cost. Each level above 1: +40% damage, +25% fire rate, +50% max HP (healed to full).
  Entity gets `level`; event `plantUp { id, plantKind, level, x, z, by }`.
- Wall-nut: no attack, big HP, solid for movement (push-out circle) and, like every garden plant, a projectile target.
- Turrets get the full weapon vocabulary (pellets, splash/gravity lob with a ballistic aim solve, slow).
- Gardener bot: plants its default kind in a slot, and upgrades a plant when it has spare sunshine and nothing to plant.

## Steps (TDD, one commit each)

1. Sim: plant types, tiers -> unlocks, `upgrade` event, single plant gun, planting any kind in any slot, input range 0..9, `upgrade` edge,
   `tryUpgrade`, level multipliers, turret features (pellets/splash/lob/slow), wall-nut blocking, Gardener upgrades, serialize `level`.
2. Balance: scripted plant kid plants and upgrades; `scripts/balance.mjs` retune; `test/balance.test.js` thresholds.
3. Client logic: `client/plants.js` (order, names, upgrade target, upgrade prompt), `PlantSender` kinds 1-9, U key, seed bar for unlocked
   plants, Upgrade touch button, HUD copy, banners, `plantUp` fx/sound.
4. Client art (models.js): nine plant models, level scale + stars, only Pea Blaster plant gun view model remains.
5. Docs: spec section "Plant upgrades (2026-10-18)", README controls.
6. Verify: `npm test`, `node --check client/*.js`, headless Chromium desktop + phone.
