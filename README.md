# Least Count — Multiplayer Card Game

A private, real-time multiplayer version of **Least Count** for you, your family, and friends.
Everyone plays from their own phone/browser; card hands stay private to each player.

## Rules implemented

- 13 cards dealt to each player. Number of card decks used scales with player count:

  | Players | Decks |
  |---|---|
  | 2–4 | 3 |
  | 5–6 | 4 |
  | 7–8 | 5 |
  | 9–10 | 6 |

- Card values: number cards = face value, J/Q/K = 10, A = 1, printed Jokers = 0.
- One extra card is drawn at dealing time to fix that round's wild **Joker rank** (also worth 0).
- On your turn: discard card(s) matching the open card's rank for free, or discard anything you like and draw 1 penalty card if it doesn't match.
- **+2 rule**: discarding a 2 forces the next player to play a 2 too, or draw 2 (then 4, then 6…) penalty cards. Whoever takes the penalty ends the chain; the following player just faces a normal single-card rule.
- Stock pile reshuffles from the discard pile automatically if it runs out.
- Declare **"Least Count"** before drawing if your hand value is 5 or less. If you truly have the lowest value: you score 0, everyone else scores their own hand value. If you're wrong: you get a 75-point penalty, the real lowest scores 0, everyone else scores their own hand value.
- Scores are cumulative across rounds. Reach 200 and you're eliminated. Last player standing wins.

## Running it yourself (optional, for testing before you deploy)

You'll need [Node.js](https://nodejs.org) installed (version 18 or newer).

```
cd least-count
npm install
npm start
```

Then open `http://localhost:3000` in a few different browser tabs to try it out with "players."

## Deploying so family/friends can play from anywhere (Render.com, free)

This app needs a small server running somewhere so everyone's phones can connect to the same
game in real time. **Render** offers a free tier that works well for this. Steps:

1. **Put the code on GitHub** (a free account at github.com if you don't have one).
   - Create a new repository (e.g. `least-count-game`).
   - Upload this entire `least-count` folder to it (GitHub's website lets you drag-and-drop files
     if you'd rather not use git commands — use "Add file → Upload files").

2. **Sign up at [render.com](https://render.com)** (free, no credit card needed for this tier).

3. Click **New +** → **Web Service**, and connect the GitHub repository you just created.

4. Fill in these settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free

5. Click **Create Web Service**. Render will build and start it — takes a couple of minutes.

6. Once it's live, Render gives you a URL like `https://least-count-game.onrender.com`.
   That's the link you share with family and friends — anyone with it can open it on their phone,
   enter their name, and create/join a room.

**Note on the free tier:** Render's free web services "sleep" after 15 minutes of no traffic, and
take ~30–60 seconds to wake up on the next visit. That's fine for occasional family game nights —
just give it a moment to load if it's been idle.

## How to play (for your group)

1. One person opens the link, enters their name, and taps **Create Room**. They get a 4-letter room code.
2. Everyone else opens the same link, enters their name, and taps **Join Room** with that code.
3. Once everyone's in, the room creator (host) taps **Start Game**.
4. Play proceeds automatically — your turn, your cards, your call to declare Least Count.
