# Lobbies — Design

Build after the current playtest, touch and names work lands. Approved by the parent on 2026-10-18 ("make assumptions and go").

## Why
Friends and family visit pea-shooter.bubtaylor.com from different houses. They need to find each other's games, join one, and let the person who made it decide when to start.

## Behaviour
- **Front page = lobby browser.** It shows a name field (the existing one), a live list of lobbies, and a **Create lobby** button.
  - Each row shows the lobby name, host name, player count, mode (Co-op/Versus), difficulty, and status (Waiting / Playing, with the round timer).
  - Each row has a **Join** button.
  - The list updates live.
- **Create lobby:** pick a lobby name (default "<name>'s Backyard"), mode, and difficulty. The creator becomes the **host**.
- **Waiting room:**
  - Lists the players and their team, and each player picks Plants or Zombies.
  - Only the host sees **Start**, and only the host can change mode or difficulty.
  - Everyone sees a "Waiting for <host> to start" message.
- **Joining a game that's already playing** drops you straight in on the team you pick.
- **Host leaves:** the longest-present remaining player becomes host. When the last player leaves, the lobby closes immediately.
- **Round end:** after the winner screen, everyone goes back to the waiting room, keeping their teams. The host presses Start for the next round.
- **No player cap.** The only limit is a hidden safety cap of 50 players per lobby and 20 lobbies per server. The previous 2-human `maxPlayers` limit is removed.
- No passwords and no accounts. The lobby name is the only identification.

## Constraints
- **One server process holds many independent games.** Each lobby owns its own `Game` instance and tick, and snapshots go only to that lobby's sockets.
  - Game state stays in memory, so a deploy rollout drops lobbies, and that is accepted.
  - Bots and waves are per lobby.
- **Protocol:**
  - New messages: `listLobbies`, `lobbies`, `createLobby`, `joinLobby`, `leaveLobby`, `setTeam`, `startGame`, `lobbyState`.
  - The existing `join` becomes internal to `joinLobby`.
  - Input and snapshot messages are unchanged within a lobby.
- **Reconnect** with the existing client token rejoins the same lobby if it still exists.
- Text input (lobby and player names) is length-capped and stripped of control characters. Names are rendered as text, never as HTML.

## Left to the builder
UI layout (kid-friendly and big, working on both phone and desktop), the exact message shapes, and test structure.
