# Names and Lobbies Implementation Plan

**Goal:** Player names everywhere (tags, kill feed, rename mid-game), then multi-lobby play per `docs/superpowers/specs/2026-10-18-lobbies-design.md`.

**Architecture:** Sim (`server/sim/*`) stays pure. A new `server/lobby.js` (`LobbyManager`) owns many `Lobby` objects, each with its own `Game`, accumulator and member list; it talks to members through `member.send(obj)` / `member.raw(str)` so it is unit-testable without sockets. `server/index.js` stays transport only (HTTP, ws parsing, heartbeat, ghost eviction). Client `lobby.js` becomes a three-screen UI (browse / create / room) driven by `lobbies` and `lobbyState` messages.

**Constraints:** Balance and in-game sim unchanged. Names are always rendered via `textContent` or canvas text. Hidden caps: 50 players per lobby, 20 lobbies. No push; port 8092 for test servers.

## Part 1 - Names

### Task 1: Name sanitizer, rename, event names (server)
- `server/sim/names.js`: `sanitizeName(raw, fallback = 'Player', max = 16)` strips control and bidi/zero-width chars, trims, caps by code point, falls back. `sanitizeLobbyName` is the same with a 32 cap.
- `Game.renamePlayer(id, raw)`; `Game.addPlayer` uses `sanitizeName`.
- `combat.js` `nameOf(e)`; events `convert`, `wilt`, `mow`, `mower_destroyed` gain `byName`, `byKind`, `targetName`, `targetKind`; `convert`/`wilt` gain `head: true` when the killing blow was a headshot.
- Server (single game, pre-lobby): `setName` message.
- Tests: `test/names.test.js` (control chars, trim, 16 cap, surrogate pairs, non-strings, fallback); `test/feed-events.test.js` (names/kinds/head on each event); rename in `game-core`; `setName` over ws.

### Task 2: Name tags, kill feed, settings rename, touch HUD (client)
- `scene.js`: name tag texture cache (bounded), text fitted to the pill, per-tag material so opacity fades with distance (full to 28 m, gone by 70 m); not on own player.
- `client/feed.js`: pure `feedLine(ev)` -> `{ parts: [{text, team}], head }` or `null` (only lines with a human on either side). `hud.feed(line)` renders spans with `textContent`, max 5 lines, 6 s life.
- Settings panel: "Your name" input -> `setName`, saved in localStorage.
- `touch.css`: compact `#mowerbox`, `#itemhp`, kill feed.
- Tests: `test/feed.test.js`.

## Part 2 - Lobbies

### Task 3: Sim support for a waiting room
- Remove `maxPlayers` (config, `publicConfig`, `addPlayer`).
- `config.autoRestart` (default true: old tests and solo behaviour). When false, `stepRules` ends the ended screen with `game.endMatch()` -> phase `'lobby'`, entities cleared.
- `Game.startMatch({ mode, difficulty, players })` seats everyone and starts the round; mid-game join keeps using `addPlayer`.
- Tests in `game-core` / `rules`: no human cap, `startMatch`, `autoRestart:false` returns to `'lobby'`.

### Task 4: `LobbyManager` (`server/lobby.js`)
Interface (member = `{ id, cid, name, team, send(obj), raw(str), lastInputAt, inputActive, lobby }`):
- `create(member, { lobbyName, mode, difficulty, team, name })`, `join(member, lobbyId, { team, name })`, `leave(member, { remember })`, `setTeam`, `setName`, `setOptions` (host only, waiting only), `start` (host only, waiting only), `input(member, msg)`, `list()`, `step(now)` (per-lobby accumulators, stale-input release, snapshot fanout to that lobby only, round over -> waiting), `rejoin(member)` using the recent-departure map (cid -> lobby, 90 s).
- Host = first key of `lobby.members` (insertion order = presence order); leaving host hands over to the next; empty lobby is deleted at once.
- Errors returned as `{ error: 'lobby_full' | 'too_many_lobbies' | 'gone' | 'not_host' | 'busy' }`.
- Tests `test/lobby.test.js` with fake members: create defaults, caps (small caps via options), host-only start/options, host migration, empty close, two games isolated (snapshots only to own sockets), teams kept across round end, mid-game join, setName propagation, rejoin by cid, list contents.

### Task 5: Protocol in `server/index.js`
- Messages in: `listLobbies`, `createLobby`, `joinLobby`, `leaveLobby`, `setTeam`, `setOptions`, `startGame`, `setName`, `input`. Out: `lobbies`, `lobbyState` (`lobby: null` when not in one), `welcome` (when you enter a running game), `snap`, `error`. Old `join` removed.
- Browsing clients get `lobbies` whenever the list JSON changes (checked every 500 ms and on events).
- Ghost eviction by `cid` keeps working; a reconnecting cid is put back in its lobby.
- Update `server.test.js`, `reconnect.test.js`; new `test/lobby-ws.test.js` for the wire flow.

### Task 6: Client lobby UI
- `index.html`/`lobby.js`/`style.css`/`touch.css`: browse (name, team, live list with Join, Create lobby), create form, waiting room (players + teams, team pick, host-only Start/mode/difficulty, "Waiting for X to start"), Leave. Settings panel and end screen get Leave lobby.
- `main.js`: `welcome` enters the game, `lobbyState` drives screens, round end returns to the waiting room. `touch.js`: fullscreen on Join/Create/Start taps.
- Pure helpers (`lobbyStatusText`, `feedLine`) unit-tested.

### Task 7: Verify and docs
- `npm test`, `node --check client/*.js`, headless Chromium with 3 contexts + a phone context (create, see, join, non-host cannot start, start, tags, host leaves -> migration, round end -> waiting room, no console errors). README.
