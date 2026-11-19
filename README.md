# Cat-astrophe

**[▶ Play the game](https://inspiring-chebakia-196f1c.netlify.app)**

https://inspiring-chebakia-196f1c.netlify.app

A real-time 3D party game for 2-8 players. Cats are trapped in a backyard and must survive
the dogs, then dash to the owner's van. Dogs are played by real people (AI terriers fill in
when the dog team is small). Players join from their own desktop browser with a 4-letter room code.

Stack: Vite, Three.js, PeerJS (WebRTC). There is no backend: the host's browser is the game
server, so the site is plain static files.

## Run locally

    npm install
    npm run dev          # http://127.0.0.1:5173
    npm run build        # outputs dist/
    npm run preview

Open one tab to create a room, then a second browser window to join with the room code.
Keep the host's tab visible. Add `?debug=1` to the address for debug tools (below).

## Controls (desktop)

WASD move · mouse aim · click/Space use item · E pick up / revive · Shift dodge ·
Q class ability · 1/2 or wheel switch items · Tab scoreboard · Esc menu.

## How a round works

1. Scavenge (15-20 s): cats gear up inside the fence, dogs gear up outside it.
2. Fence drop.
3. Hunt: dogs try to down every cat while chaos events strike (sprinklers, a runaway ball,
   a tipped trash can, a leaf gust).
4. Rescue dash: the van arrives at a random one of three spots; cats must reach it before
   the timer ends. Dogs cannot enter the ring around the van.
5. Results, then (optionally) a second round with sides swapped.

Cats win if at least one cat reaches the van. Dogs win if every cat is down at once or the
dash timer runs out. Stars: 1 = someone escaped, 2 = half, 3 = everyone.

## Classes

Cats: Scaredy Cat (Panic Yowl), Cool Cat (Slick Dodge), Chonk (Belly Bump), Sneaky Cat (Pounce).
Dogs: Terrier (Zoomies), Bulldog (Charge), Hound (Howl), Great Dane (Ground Slam).

## Tuning

All gameplay numbers live in `src/config.js` (classes, bots, events, difficulty timings).

## Debug tools (`?debug=1`)

- "Solo practice (debug)" on the landing page starts a room without networking, with AI dogs.
- In the arena: Skip phase, + Dog bot, Hurt me 40, Random event, Measure dash, Reset cooldowns.
- Console: `catDebug.checkVanSpots()` and `catDebug.measureDash()` (dash-timer ratios).

Measured dash ratios (walking time / dash timer): easy 0.36-0.38 (target <= 0.40),
normal 0.49-0.53 (<= 0.55), hard 0.62-0.67 (<= 0.70).

## Known limitations

- No sound or music yet; no mute toggle.
- Multiplayer uses PeerJS's free public signaling server with STUN only (no TURN relay), so some
  strict networks, VPNs, or school/work Wi-Fi may fail to connect.
- Class art is the same model for every class; limited animation polish.
- No emote wheel, spectator camera, or extra props.
