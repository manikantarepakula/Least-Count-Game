// --------------------------------------------------------------------------
// Player rating (Nov 2026) -- chess-style, for a game of 2 to 10 players.
//
// The rules, as agreed with Mani:
//   - Everyone starts at 300. A rating never goes below 100.
//   - A game counts ("is rated") when at least one person with an account
//     plays at least 3 rounds against anyone -- friends, bots, or both.
//   - Bots (Nov 2026, second step): every bot character has a FIXED rating,
//     measured by letting the bots play each other (tools/bot-ratings-sim.js;
//     the numbers live on BOT_ARCHETYPES in server.js). A bot is compared
//     like any other player, but its own number never moves.
//   - Places: the winner is 1st; then the players knocked out by the max
//     score, the later one placed higher (same round: the lower score is
//     higher; equal = a draw between them); players who LEFT come last, the
//     later leaver above the earlier one. (The engine works the places out:
//     LeastCountGame.standings().)
//   - Every pair of players is compared like one chess game (finishing higher
//     is a win), and the results are averaged:
//         change = K x average over opponents of (result - expected)
//         expected = 1 / (1 + 10^((their rating - your rating) / 400))
//   - K = 40 for a player's first 10 rated games ("new player"), then 20.
//   - A settled player (10+ rated games) gets only half the change from each
//     NEW player at the table, so fresh accounts can't be farmed for points.
//     (Bots are never "new".)
//   - After 5 rated games with exactly the same people on one day, the 6th
//     and later count half, so friends can't push one person up by losing.
//     Only between people: there is no daily limit against bots -- beating
//     the same weak bots again pays less and less on its own.
//   - One person against bots: the rating is worked out as soon as that
//     person is out (knocked out, or left) -- the bots still in finish above
//     them whatever happens next, so nobody has to watch the bots finish.
//     With two or more people it waits for the end (one could rejoin).
//
// Pure functions only: no Firestore, no sockets. server.js does the reading
// and writing; this file is what the tests check.
// --------------------------------------------------------------------------

const START_RATING = 300;
const RATING_FLOOR = 100;
const NEW_PLAYER_GAMES = 10;
const K_NEW = 40;
const K_SETTLED = 20;
const MIN_ROUNDS = 3;
const SAME_GROUP_FULL_GAMES = 5;

function expectedScore(rating, opponentRating) {
  return 1 / (1 + Math.pow(10, (opponentRating - rating) / 400));
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// A user's stored rating fields, with the defaults for someone who has never
// played a rated game.
function ratingOf(doc) {
  const d = doc || {};
  return {
    rating: Math.max(RATING_FLOOR, Math.round(num(d.rating, START_RATING))),
    ratedGames: Math.max(0, Math.floor(num(d.ratedGames, 0))),
    peakRating: Math.round(num(d.peakRating, num(d.rating, START_RATING))),
  };
}

function isNewPlayer(ratedGames) {
  return ratedGames < NEW_PLAYER_GAMES;
}

/**
 * players: [{ key, rating, ratedGames, place, fixed }]  (place 1 = best; ties share)
 *   fixed: a bot -- compared against at its set rating like anyone else, but
 *   its own number never moves, so it gets no entry in the result.
 * opts.sameGroupGamesToday: rated games these exact people already played
 *   together today (before this one).
 * Returns { [key]: { before, after, delta, ratedGames, newPlayer } }, where
 * ratedGames / newPlayer describe the player AFTER this game.
 */
function computeRatingChanges(players, opts) {
  const o = opts || {};
  const n = players.length;
  const out = {};
  if (n < 2) return out;
  const halfForGroup = num(o.sameGroupGamesToday, 0) >= SAME_GROUP_FULL_GAMES;
  for (const p of players) {
    if (p.fixed) continue;
    const settled = !isNewPlayer(p.ratedGames);
    const k = settled ? K_SETTLED : K_NEW;
    let sum = 0;
    for (const q of players) {
      if (q === p) continue;
      const result = p.place < q.place ? 1 : (p.place > q.place ? 0 : 0.5);
      const weight = settled && !q.fixed && isNewPlayer(q.ratedGames) ? 0.5 : 1;
      sum += k * weight * (result - expectedScore(p.rating, q.rating));
    }
    let change = sum / (n - 1);
    if (halfForGroup) change /= 2;
    const after = Math.max(RATING_FLOOR, Math.round(p.rating + change));
    const ratedGames = p.ratedGames + 1;
    out[p.key] = {
      before: p.rating,
      after,
      delta: after - p.rating,
      ratedGames,
      newPlayer: isNewPlayer(ratedGames),
    };
  }
  return out;
}

/**
 * Why a game does NOT count, or null when it does.
 *   'people'  -- nobody to rate (no person with an account), or nobody for
 *                them to be compared with (no other person, no bot)
 *   'short'   -- fewer than MIN_ROUNDS rounds were played
 */
function unratedReason(peopleWithAccounts, bots, roundsPlayed) {
  if (peopleWithAccounts < 1 || peopleWithAccounts + bots < 2) return 'people';
  if (roundsPlayed < MIN_ROUNDS) return 'short';
  return null;
}

module.exports = {
  START_RATING, RATING_FLOOR, NEW_PLAYER_GAMES, K_NEW, K_SETTLED, MIN_ROUNDS, SAME_GROUP_FULL_GAMES,
  expectedScore, ratingOf, isNewPlayer, computeRatingChanges, unratedReason,
};
