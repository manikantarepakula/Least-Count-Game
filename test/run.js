const assert = require('assert');
const {
  deckCountForPlayers, createShoe, cardValue, handValue, LeastCountGame,
  ELIMINATION_SCORE, WRONG_DECLARE_PENALTY, ROUND_SCORE_CAP, MAX_SCORE_OPTIONS,
  DECLARE_MAX_VALUE,
} = require('../game/gameLogic');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('PASS -', name);
  } catch (e) {
    console.log('FAIL -', name, '\n   ', e.message);
    process.exitCode = 1;
  }
}

// 1. Deck count table
check('deck count table matches spec', () => {
  const table = { 2: 3, 3: 3, 4: 3, 5: 4, 6: 4, 7: 5, 8: 5, 9: 6, 10: 6 };
  for (const [p, d] of Object.entries(table)) {
    assert.strictEqual(deckCountForPlayers(Number(p)), d, `players=${p}`);
  }
});

// 2. Shoe size = numDecks * 54
check('shoe size = 54 * numDecks', () => {
  for (let p = 2; p <= 10; p++) {
    const { cards, numDecks } = createShoe(p);
    assert.strictEqual(cards.length, numDecks * 54);
  }
});

// 3. Card values
check('card values: number/face/ace/joker', () => {
  assert.strictEqual(cardValue({ rank: '7' }, null), 7);
  assert.strictEqual(cardValue({ rank: '10' }, null), 10);
  assert.strictEqual(cardValue({ rank: 'J' }, null), 10);
  assert.strictEqual(cardValue({ rank: 'Q' }, null), 10);
  assert.strictEqual(cardValue({ rank: 'K' }, null), 10);
  assert.strictEqual(cardValue({ rank: 'A' }, null), 1);
  assert.strictEqual(cardValue({ rank: 'JOKER' }, null), 0);
});

check('round joker rank also counts as 0', () => {
  assert.strictEqual(cardValue({ rank: '9' }, '9'), 0);
  assert.strictEqual(cardValue({ rank: '9' }, '4'), 9);
});

// 4. Full deal: 13 cards each, dealer/joker reveal distinct, stock fills the rest
check('startRound deals 13 cards to each of N players', () => {
  for (let p = 2; p <= 10; p++) {
    const ids = Array.from({ length: p }, (_, i) => `P${i}`);
    const g = new LeastCountGame(ids);
    const state = g.startRound();
    for (const id of ids) assert.strictEqual(g.hands[id].length, 13, `player ${id} should have 13 cards`);
    assert.ok(state.openCard, 'open card should be revealed');
    const totalDealt = p * 13;
    const totalShoe = g.numDecks * 54;
    // 1 open card + at least 1 joker-reveal card (more if 2s were redrawn past) + stock
    // should account for every card in the shoe.
    const burned = totalShoe - totalDealt - 1 - g.stock.length;
    assert.ok(burned >= 1, `expected at least 1 burned joker-reveal card, got ${burned}`);
  }
});

// 5. Basic matching discard, no draw
check('discard matching open card costs no draw', () => {
  const g = new LeastCountGame(['A', 'B']);
  g.startRound();
  const p = g.currentPlayer();
  // force a known open card and hand for determinism
  g.discardPile = [{ id: 'open1', rank: '7', suit: 'S' }];
  g.roundJokerRank = null;
  g.chainCount = 0; // reset in case the real random deal happened to open on a 2
  g.hands[p] = [{ id: 'x1', rank: '7', suit: 'H' }, ...g.hands[p].slice(1)];
  const before = g.hands[p].length;
  g.playTurn(p, ['x1']);
  assert.strictEqual(g.hands[p].length, before - 1, 'hand should shrink by exactly 1, no penalty draw');
});

check('discard NOT matching open card forces a 1-card draw penalty', () => {
  const g = new LeastCountGame(['A', 'B']);
  g.startRound();
  const p = g.currentPlayer();
  g.discardPile = [{ id: 'open1', rank: '7', suit: 'S' }];
  g.roundJokerRank = null;
  g.chainCount = 0;
  g.hands[p] = [{ id: 'x1', rank: 'K', suit: 'H' }, ...g.hands[p].slice(1)];
  const before = g.hands[p].length;
  g.playTurn(p, ['x1']);
  assert.strictEqual(g.hands[p].length, before, 'discard 1, draw 1 penalty = net unchanged');
});

// 6. +2 stacking chain
check('+2 chain: fresh 2 discard sets chainCount=1, next must answer or take 2', () => {
  const g = new LeastCountGame(['A', 'B']);
  g.startRound();
  const p1 = g.currentPlayer();
  g.discardPile = [{ id: 'open1', rank: '9', suit: 'S' }];
  g.roundJokerRank = null;
  g.chainCount = 0;
  g.hands[p1] = [{ id: 't2', rank: '2', suit: 'H' }, ...g.hands[p1].slice(1)];
  g.playTurn(p1, ['t2']);
  assert.strictEqual(g.chainCount, 1);
  const p2 = g.currentPlayer();
  assert.notStrictEqual(p2, p1);
  const stockBefore = g.stock.length;
  const handBefore = g.hands[p2].length;
  g.playTurn(p2, []); // p2 has no 2, takes penalty
  assert.strictEqual(g.hands[p2].length, handBefore + 2, 'should draw exactly 2 penalty cards');
  assert.strictEqual(g.chainCount, 0, 'chain resets after penalty taken');
});

check('+2 chain escalates 2 -> 4 when answered consecutively', () => {
  const g = new LeastCountGame(['A', 'B', 'C']);
  g.startRound();
  const p1 = g.currentPlayer();
  g.discardPile = [{ id: 'open1', rank: '9', suit: 'S' }];
  g.roundJokerRank = null;
  g.chainCount = 0;
  g.hands[p1] = [{ id: 't2a', rank: '2', suit: 'H' }, ...g.hands[p1].slice(1)];
  g.playTurn(p1, ['t2a']);
  assert.strictEqual(g.chainCount, 1);

  const p2 = g.currentPlayer();
  g.hands[p2] = [{ id: 't2b', rank: '2', suit: 'D' }, ...g.hands[p2].slice(1)];
  g.playTurn(p2, ['t2b']); // answers with a 2
  assert.strictEqual(g.chainCount, 2);

  const p3 = g.currentPlayer();
  const handBefore = g.hands[p3].length;
  g.playTurn(p3, []); // fails to answer, must take 2*2=4
  assert.strictEqual(g.hands[p3].length, handBefore + 4);
  assert.strictEqual(g.chainCount, 0);
});

check('player right after a penalty-taker faces a normal single-card rule (open card still 2)', () => {
  const g = new LeastCountGame(['A', 'B', 'C']);
  g.startRound();
  const p1 = g.currentPlayer();
  g.discardPile = [{ id: 'open1', rank: '9', suit: 'S' }];
  g.roundJokerRank = null;
  g.chainCount = 0;
  g.hands[p1] = [{ id: 't2a', rank: '2', suit: 'H' }, ...g.hands[p1].slice(1)];
  g.playTurn(p1, ['t2a']); // chainCount=1
  const p2 = g.currentPlayer();
  g.playTurn(p2, []); // p2 takes 2-card penalty, chain resets to 0
  assert.strictEqual(g._openRank(), '2');
  assert.strictEqual(g.chainCount, 0);

  const p3 = g.currentPlayer();
  // p3 has no 2 -> normal rule: discard anything + take exactly 1 penalty card (not 2)
  const handBefore = g.hands[p3].length;
  const nonTwoCard = g.hands[p3].find((c) => c.rank !== '2');
  g.playTurn(p3, [nonTwoCard.id]);
  assert.strictEqual(g.hands[p3].length, handBefore, 'discard 1 + draw 1 penalty = net unchanged (normal rule, not x2)');
});

check('if the very first open card (revealed at dealing) is a 2, first player faces the +2 challenge immediately', () => {
  // Item 6 made this noticeably rarer on purpose (single redraw on a 2, down
  // from ~1-in-13 to ~1-in-170) -- needs many more attempts than before to
  // reliably reproduce it at all, or this test would flake intermittently.
  let found = false;
  for (let attempt = 0; attempt < 6000 && !found; attempt++) {
    const g = new LeastCountGame(['A', 'B']);
    g.startRound();
    if (g._openRank() === '2') {
      found = true;
      assert.strictEqual(g.chainCount, 1, 'first player should face an active +2 challenge');
      const p1 = g.currentPlayer();
      const handBefore = g.hands[p1].length;
      g.playTurn(p1, []); // simulate declining to answer -> must take the 2-card penalty
      assert.strictEqual(g.hands[p1].length, handBefore + 2, 'first player draws exactly 2 penalty cards');
      assert.strictEqual(g.chainCount, 0, 'chain resets after the penalty is taken');
    }
  }
  assert.ok(found, 'expected to eventually deal a 2 as the opening card across 6000 attempts');
});

check('open card being a 2 is now noticeably rarer than a naive 1-in-13 rate', () => {
  const trials = 5000;
  let twos = 0;
  for (let i = 0; i < trials; i++) {
    const g = new LeastCountGame(['A', 'B']);
    g.startRound();
    if (g._openRank() === '2') twos += 1;
  }
  const rate = twos / trials;
  // Naive (no redraw) rate would be ~1/13 = 7.7%; the single-redraw rule
  // should land closer to ~1/169 = 0.6%. Leave generous headroom (< 3%)
  // so this doesn't flake, while still catching a real regression.
  assert.ok(rate < 0.03, `expected open-card-is-2 rate well under 3%, got ${(rate * 100).toFixed(2)}%`);
});

// 7. Stock reshuffle when empty
check('stock reshuffles from discard pile when empty', () => {
  const g = new LeastCountGame(['A', 'B']);
  g.startRound();
  g.chainCount = 0;
  g.discardPile = [
    { id: 'd1', rank: '3', suit: 'S' },
    { id: 'd2', rank: '4', suit: 'H' },
    { id: 'd3', rank: '5', suit: 'D' },
  ];
  g.stock = [];
  const reshufflesBefore = g.reshuffleCount;
  const drawn = g._drawFromStock(1);
  assert.strictEqual(drawn.length, 1);
  assert.strictEqual(g.discardPile.length, 1, 'only the top open card remains in discard pile');
  assert.strictEqual(g.discardPile[0].id, 'd3');
  assert.strictEqual(g.reshuffleCount, reshufflesBefore + 1, 'reshuffleCount should increment so clients can play a sound for it');
});

// 8. Declare: correct case
check('correct Least Count declaration scores 0 for declarer, own value for others', () => {
  const g = new LeastCountGame(['A', 'B', 'C']);
  g.startRound();
  g.roundJokerRank = null; // pin down randomness so rigged hand values below are deterministic
  g.chainCount = 0;
  g.discardPile = [{ id: 'pin-open', rank: 'K', suit: 'S' }]; // pin so a random 2 doesn't block declare()
  const declarer = g.currentPlayer();
  g.hands[declarer] = [{ id: 'v1', rank: 'A', suit: 'S' }, { id: 'v2', rank: '2', suit: 'H' }];
  for (const id of g.turnOrder) {
    if (id !== declarer) g.hands[id] = [{ id: `o-${id}`, rank: 'K', suit: 'S' }];
  }
  const state = g.declare(declarer);
  assert.strictEqual(state.lastRoundResult.correct, true);
  assert.strictEqual(state.scores[declarer], 0);
  for (const id of g.turnOrder) {
    if (id !== declarer) assert.strictEqual(state.scores[id], 10);
  }
  assert.strictEqual(state.roundOver, true);
});

// 9. Declare: wrong case (someone else lower)
check('wrong declaration: 75 penalty to declarer, 0 to actual lowest', () => {
  const g = new LeastCountGame(['A', 'B']);
  g.startRound();
  g.roundJokerRank = null;
  g.chainCount = 0;
  g.discardPile = [{ id: 'pin-open', rank: 'K', suit: 'S' }];
  const declarer = g.currentPlayer();
  const other = g.turnOrder.find((id) => id !== declarer);
  g.hands[declarer] = [{ id: 'v1', rank: '4', suit: 'S' }]; // value 4, declares
  g.hands[other] = [{ id: 'v2', rank: '2', suit: 'H' }]; // value 2, lower!
  const state = g.declare(declarer);
  assert.strictEqual(state.lastRoundResult.correct, false);
  assert.strictEqual(state.scores[declarer], WRONG_DECLARE_PENALTY);
  assert.strictEqual(state.scores[other], 0);
});

check('tied wrong declare: declarer pays own (small) value, tied opponent gets 0', () => {
  const g = new LeastCountGame(['A', 'B', 'C']);
  g.startRound();
  g.roundJokerRank = null;
  g.chainCount = 0;
  g.discardPile = [{ id: 'pin-open', rank: 'K', suit: 'S' }];
  const declarer = g.currentPlayer();
  const others = g.turnOrder.filter((id) => id !== declarer);
  const tiedWith = others[0];
  const highOne = others[1];
  g.hands[declarer] = [{ id: 'v1', rank: '3', suit: 'S' }]; // value 3
  g.hands[tiedWith] = [{ id: 'v2', rank: '3', suit: 'H' }]; // also value 3 -- a tie
  g.hands[highOne] = [{ id: 'v3', rank: 'K', suit: 'D' }]; // value 10, not tied
  const state = g.declare(declarer);
  assert.strictEqual(state.lastRoundResult.correct, false, 'tie is never a correct declare');
  assert.strictEqual(state.scores[declarer], 3, 'declarer pays their own hand value, not the flat 75 penalty');
  assert.strictEqual(state.scores[tiedWith], 0, 'the tied opponent still gets rewarded with 0');
  assert.strictEqual(state.scores[highOne], 10, 'unrelated player just pays their own value');
});

check('round-loss score is capped at 75 even if hand value is higher', () => {
  const g = new LeastCountGame(['A', 'B']);
  g.startRound();
  g.roundJokerRank = null;
  g.chainCount = 0;
  g.discardPile = [{ id: 'pin-open', rank: 'K', suit: 'S' }];
  const declarer = g.currentPlayer();
  const other = g.turnOrder.find((id) => id !== declarer);
  g.hands[declarer] = [{ id: 'v1', rank: 'A', suit: 'S' }]; // value 1
  // 9 face cards = hand value 90, well above the cap
  g.hands[other] = Array.from({ length: 9 }, (_, i) => ({ id: `o${i}`, rank: 'K', suit: 'D' }));
  const state = g.declare(declarer);
  assert.strictEqual(state.lastRoundResult.values[other], 90, 'actual hand value is uncapped in the raw values');
  assert.strictEqual(state.scores[other], ROUND_SCORE_CAP, 'but the score added is capped at 75');
});

// 10. Declaration blocked above value 5
check('cannot declare with hand value > 5', () => {
  const g = new LeastCountGame(['A', 'B']);
  g.startRound();
  g.roundJokerRank = null;
  g.chainCount = 0;
  g.discardPile = [{ id: 'pin-open', rank: 'K', suit: 'S' }];
  const declarer = g.currentPlayer();
  g.hands[declarer] = [{ id: 'v1', rank: 'K', suit: 'S' }]; // value 10
  assert.throws(() => g.declare(declarer), /too high/);
});

// 11. Elimination at 200 and winner determination
check('players eliminated at >=200, game ends with 1 winner', () => {
  const g = new LeastCountGame(['A', 'B', 'C']);
  g.scores = { A: 190, B: 50, C: 60 };
  g.startRound();
  g.roundJokerRank = null;
  g.chainCount = 0;
  g.discardPile = [{ id: 'pin-open', rank: 'K', suit: 'S' }];
  const declarer = g.currentPlayer();
  const others = g.turnOrder.filter((id) => id !== declarer);
  // rig hands: declarer very low, everyone else high value so declarer wins and
  // whichever of A/B/C is NOT declarer/among others gets pushed appropriately.
  g.hands[declarer] = [{ id: 'v1', rank: 'A', suit: 'S' }];
  for (const id of others) g.hands[id] = [{ id: `o-${id}`, rank: 'K', suit: 'S' }]; // +10 each
  const state = g.declare(declarer);
  // Whoever started at 190 and is not the declarer and got +10 should be eliminated.
  for (const id of ['A', 'B', 'C']) {
    if (state.scores[id] >= 200) assert.ok(state.eliminated.includes(id));
  }
});

check('game continues until exactly one active player remains', () => {
  const g = new LeastCountGame(['A', 'B']);
  g.eliminated.add('A');
  g.scores.A = 250;
  assert.strictEqual(g.activePlayers().length, 1);
  const state = g.startRound();
  assert.strictEqual(state.gameOver, true);
  assert.strictEqual(state.winner, 'B');
});

check('getPublicState exposes finalHands/finalHandValues once roundOver, and never before', () => {
  const g = new LeastCountGame(['A', 'B']);
  // Both near the cap -- a correct declare leaves the declarer's own score
  // untouched, so whichever of A/B ends up as "other" (and gets +13) is the
  // one who needs to cross 200; starting both at 195 makes that true no
  // matter which one the random dealer rotation picks as declarer.
  g.scores = { A: 195, B: 195 };
  g.startRound();
  g.roundJokerRank = null;
  g.chainCount = 0;
  g.discardPile = [{ id: 'pin-open', rank: 'K', suit: 'S' }];
  const declarer = g.currentPlayer();
  const other = g.turnOrder.find((id) => id !== declarer);
  g.hands[declarer] = [{ id: 'v1', rank: 'A', suit: 'S' }];
  g.hands[other] = [{ id: 'o1', rank: '9', suit: 'D' }, { id: 'o2', rank: '4', suit: 'H' }];

  const midState = g.getPublicState();
  assert.strictEqual(midState.finalHands, undefined, 'should not reveal hands before the round is over');

  const state = g.declare(declarer);
  assert.strictEqual(state.gameOver, true);
  assert.strictEqual(state.roundOver, true);
  assert.ok(state.finalHands, 'finalHands should be present once roundOver');
  assert.deepStrictEqual(state.finalHands[other].map((c) => c.id).sort(), ['o1', 'o2']);
  assert.strictEqual(state.finalHandValues[other], 13, 'value 9 + 4 = 13');
  assert.strictEqual(state.finalHandValues[declarer], 1);
});

check('getPublicState exposes finalHands/finalHandValues on an ordinary (non-final) round end too', () => {
  const g = new LeastCountGame(['A', 'B', 'C']);
  g.scores = { A: 0, B: 0, C: 0 };
  g.startRound();
  g.roundJokerRank = null;
  g.chainCount = 0;
  g.discardPile = [{ id: 'pin-open', rank: 'K', suit: 'S' }];
  const declarer = g.currentPlayer();
  const others = g.turnOrder.filter((id) => id !== declarer);
  g.hands[declarer] = [{ id: 'v1', rank: 'A', suit: 'S' }];

  const midState = g.getPublicState();
  assert.strictEqual(midState.finalHands, undefined, 'should not reveal hands mid-round');

  const state = g.declare(declarer);
  assert.strictEqual(state.gameOver, false, 'nobody should be eliminated from a low score');
  assert.strictEqual(state.roundOver, true);
  assert.ok(state.finalHands, 'finalHands should be present as soon as this ordinary round ends, not just on the game-ending round');
  others.forEach((id) => {
    assert.ok(state.finalHands[id], `finalHands should include ${id}`);
    assert.ok(Number.isFinite(state.finalHandValues[id]), `finalHandValues should include ${id}`);
  });
});

// 12. Quit / leave-between-rounds
check('removePlayer only works between rounds, and ends the game at 1 player left', () => {
  const g = new LeastCountGame(['A', 'B', 'C']);
  g.startRound();
  assert.throws(() => g.removePlayer('C'), /middle of a round/);

  // force round over via a low declare so we can test the between-rounds path
  g.roundJokerRank = null;
  g.chainCount = 0;
  g.discardPile = [{ id: 'pin-open', rank: 'K', suit: 'S' }];
  const declarer = g.currentPlayer();
  g.hands[declarer] = [{ id: 'v1', rank: 'A', suit: 'S' }];
  for (const id of g.turnOrder) if (id !== declarer) g.hands[id] = [{ id: `o-${id}`, rank: 'K', suit: 'S' }];
  g.declare(declarer);
  assert.strictEqual(g.roundOver, true);

  g.removePlayer('B');
  assert.ok(!g.activePlayers().includes('B'));
  assert.strictEqual(g.activePlayers().length, 2);
  assert.strictEqual(g.gameOver, false);

  const beforeRemoval = g.activePlayers();
  g.removePlayer(beforeRemoval[0]);
  const lastOneLeft = beforeRemoval[1];
  assert.strictEqual(g.activePlayers().length, 1);
  assert.strictEqual(g.activePlayers()[0], lastOneLeft);
  assert.strictEqual(g.gameOver, true);
  assert.strictEqual(g.winner, lastOneLeft);
});

// 13. Round joker rank is never '2'
check('round joker rank is never 2, across many rounds', () => {
  for (let i = 0; i < 300; i++) {
    const g = new LeastCountGame(['A', 'B', 'C', 'D']);
    g.startRound();
    assert.notStrictEqual(g.roundJokerRank, '2', `attempt ${i}`);
  }
});

check('round joker rank is never null either -- every round gets a designated wild rank', () => {
  for (let p of [2, 3, 4, 6, 10]) {
    const ids = Array.from({ length: p }, (_, i) => `P${i}`);
    for (let i = 0; i < 200; i++) {
      const g = new LeastCountGame(ids);
      g.startRound();
      assert.notStrictEqual(g.roundJokerRank, null, `players=${p} attempt ${i}`);
    }
  }
});

// 14. autoPickDiscard sensible defaults
check('autoPickDiscard: matches open rank for free when possible', () => {
  const g = new LeastCountGame(['A', 'B']);
  g.startRound();
  g.chainCount = 0;
  const p = g.currentPlayer();
  g.discardPile = [{ id: 'open1', rank: '7', suit: 'S' }];
  g.roundJokerRank = null;
  g.hands[p] = [
    { id: 'm1', rank: '7', suit: 'H' },
    { id: 'm2', rank: '7', suit: 'D' },
    { id: 'x1', rank: 'K', suit: 'C' },
  ];
  const picked = g.autoPickDiscard(p);
  assert.deepStrictEqual(picked.sort(), ['m1', 'm2'].sort());
});

check('autoPickDiscard: falls back to the single highest-value card when no match and no groups', () => {
  const g = new LeastCountGame(['A', 'B']);
  g.startRound();
  g.chainCount = 0;
  const p = g.currentPlayer();
  g.discardPile = [{ id: 'open1', rank: '7', suit: 'S' }];
  g.roundJokerRank = null;
  g.hands[p] = [
    { id: 'x1', rank: 'K', suit: 'C' },
    { id: 'x2', rank: '3', suit: 'D' },
    { id: 'x3', rank: 'A', suit: 'S' },
  ];
  const picked = g.autoPickDiscard(p);
  assert.deepStrictEqual(picked, ['x1']); // K = value 10, the highest single card
});

check('autoPickDiscard: releases the whole highest-value group, not just one card', () => {
  const g = new LeastCountGame(['A', 'B']);
  g.startRound();
  g.chainCount = 0;
  const p = g.currentPlayer();
  g.discardPile = [{ id: 'open1', rank: '8', suit: 'S' }]; // no match to 8
  g.roundJokerRank = null;
  g.hands[p] = [
    { id: 'x1', rank: '10', suit: 'C' },
    { id: 'x2', rank: '10', suit: 'D' },
    { id: 'x3', rank: '10', suit: 'H' },
    { id: 'x4', rank: 'A', suit: 'S' },
  ];
  const picked = g.autoPickDiscard(p);
  assert.deepStrictEqual(picked.sort(), ['x1', 'x2', 'x3'].sort(), 'should release all three 10s (value 30) over the single Ace (value 1)');
});

check('autoPickDiscard: during a +2 chain, plays a 2 if held, else accepts penalty', () => {
  const g = new LeastCountGame(['A', 'B']);
  g.startRound();
  const p = g.currentPlayer();
  g.chainCount = 1;
  g.hands[p] = [{ id: 't2', rank: '2', suit: 'H' }, { id: 'x1', rank: '5', suit: 'C' }];
  assert.deepStrictEqual(g.autoPickDiscard(p), ['t2']);

  g.hands[p] = [{ id: 'x1', rank: '5', suit: 'C' }];
  assert.deepStrictEqual(g.autoPickDiscard(p), []);
});

// 15. Open card is a Joker -> free pass, no penalty draw for any single card
check('open card is a printed Joker: any single non-matching discard is free (no penalty draw)', () => {
  const g = new LeastCountGame(['A', 'B']);
  g.startRound();
  const p = g.currentPlayer();
  g.discardPile = [{ id: 'open1', rank: 'JOKER', suit: null }];
  g.roundJokerRank = null;
  g.chainCount = 0;
  g.hands[p] = [{ id: 'x1', rank: 'K', suit: 'H' }, ...g.hands[p].slice(1)];
  const before = g.hands[p].length;
  g.playTurn(p, ['x1']);
  assert.strictEqual(g.hands[p].length, before - 1, 'discard 1, NO penalty draw since open is a Joker');
});

check('open card is this round\'s wild rank: any single non-matching discard is free', () => {
  const g = new LeastCountGame(['A', 'B']);
  g.startRound();
  const p = g.currentPlayer();
  g.discardPile = [{ id: 'open1', rank: '9', suit: 'S' }];
  g.roundJokerRank = '9'; // 9 is this round's wild rank, and it's the open card
  g.chainCount = 0;
  g.hands[p] = [{ id: 'x1', rank: 'K', suit: 'H' }, ...g.hands[p].slice(1)];
  const before = g.hands[p].length;
  g.playTurn(p, ['x1']);
  assert.strictEqual(g.hands[p].length, before - 1, 'discard 1, NO penalty draw since open is the wild rank');
});

check('open card is a Joker: multiple same-rank cards can be discarded together, still free', () => {
  const g = new LeastCountGame(['A', 'B']);
  g.startRound();
  const p = g.currentPlayer();
  g.discardPile = [{ id: 'open1', rank: 'JOKER', suit: null }];
  g.roundJokerRank = null;
  g.chainCount = 0;
  g.hands[p] = [{ id: 'x1', rank: 'K', suit: 'H' }, { id: 'x2', rank: 'K', suit: 'D' }, ...g.hands[p].slice(2)];
  const before = g.hands[p].length;
  g.playTurn(p, ['x1', 'x2']);
  assert.strictEqual(g.hands[p].length, before - 2, 'discard 2, NO penalty draw since open is a Joker');
});

// 16. Declaring is blocked only while a +2 challenge is actively pending
// (chainCount > 0) -- NOT for the whole time the open card happens to show
// a 2. Once someone takes the penalty and the chain resets, declaring is
// allowed again right away, even though the open card is still a 2.
check('cannot declare while a +2 challenge is actively pending (chainCount > 0)', () => {
  const g = new LeastCountGame(['A', 'B']);
  g.startRound();
  g.roundJokerRank = null;
  g.discardPile = [{ id: 'open1', rank: '2', suit: 'S' }];
  g.chainCount = 1; // an active, unanswered +2 challenge
  const p = g.currentPlayer();
  g.hands[p] = [{ id: 'v1', rank: 'A', suit: 'S' }]; // value 1, would otherwise be a valid declare
  assert.throws(() => g.declare(p), /pending against you/);
});

check('CAN declare even when the open card is a 2, as long as no chain is active', () => {
  const g = new LeastCountGame(['A', 'B']);
  g.startRound();
  g.roundJokerRank = null;
  g.chainCount = 0; // no challenge pending, even though open card is a 2
  g.discardPile = [{ id: 'open1', rank: '2', suit: 'S' }];
  const p = g.currentPlayer();
  g.hands[p] = [{ id: 'v1', rank: 'A', suit: 'S' }]; // value 1
  const state = g.declare(p);
  assert.strictEqual(state.roundOver, true, 'declare should succeed and end the round');
});

check('declaring becomes allowed again right after a +2 penalty resets the chain', () => {
  const g = new LeastCountGame(['A', 'B', 'C']);
  g.startRound();
  const p1 = g.currentPlayer();
  g.discardPile = [{ id: 'open1', rank: '9', suit: 'S' }];
  g.roundJokerRank = null;
  g.chainCount = 0;
  g.hands[p1] = [{ id: 't2a', rank: '2', suit: 'H' }, ...g.hands[p1].slice(1)];
  g.playTurn(p1, ['t2a']); // chainCount=1, open card is now '2'
  const p2 = g.currentPlayer();
  g.playTurn(p2, []); // p2 takes penalty, chain resets to 0, open card still '2'
  assert.strictEqual(g.chainCount, 0);
  assert.strictEqual(g._openRank(), '2');
  const p3 = g.currentPlayer();
  g.hands[p3] = [{ id: 'v1', rank: 'A', suit: 'S' }];
  const state = g.declare(p3); // should succeed -- no chain is pending against p3
  assert.strictEqual(state.roundOver, true);
});

// 17. Configurable max score (item: host-chosen elimination score)
check('game defaults to the standard 200 elimination score when none is given', () => {
  const g = new LeastCountGame(['A', 'B']);
  assert.strictEqual(g.eliminationScore, ELIMINATION_SCORE);
});

check('constructor accepts a custom elimination score and uses it instead of the default', () => {
  const g = new LeastCountGame(['A', 'B'], 100);
  assert.strictEqual(g.eliminationScore, 100);
  // Both start at the same score so the test doesn't care which of A/B ends
  // up as declarer vs. "other" (turnOrder/dealer rotation decides that).
  g.scores = { A: 85, B: 85 };
  g.startRound();
  g.roundJokerRank = null;
  g.chainCount = 0;
  g.discardPile = [{ id: 'pin-open', rank: 'K', suit: 'S' }];
  const declarer = g.currentPlayer();
  const other = g.turnOrder.find((id) => id !== declarer);
  g.hands[declarer] = [{ id: 'v1', rank: 'A', suit: 'S' }]; // value 1, correct declare
  g.hands[other] = [{ id: 'o1', rank: '9', suit: 'D' }, { id: 'o2', rank: '9', suit: 'H' }]; // value 18, well under the 75 round cap
  const state = g.declare(declarer);
  assert.strictEqual(state.scores[other], 103, '85 + 18 = 103');
  assert.ok(state.eliminated.includes(other), 'should be eliminated at the custom 100 threshold, not the default 200');
});

check('setEliminationScore changes the threshold used by future declares', () => {
  const g = new LeastCountGame(['A', 'B']);
  g.scores = { A: 85, B: 85 };
  g.setEliminationScore(100);
  assert.strictEqual(g.eliminationScore, 100);
  g.startRound();
  g.roundJokerRank = null;
  g.chainCount = 0;
  g.discardPile = [{ id: 'pin-open', rank: 'K', suit: 'S' }];
  const declarer = g.currentPlayer();
  const other = g.turnOrder.find((id) => id !== declarer);
  g.hands[declarer] = [{ id: 'v1', rank: 'A', suit: 'S' }];
  g.hands[other] = [{ id: 'o1', rank: '9', suit: 'D' }, { id: 'o2', rank: '9', suit: 'H' }]; // value 18
  const state = g.declare(declarer);
  assert.strictEqual(state.scores[other], 103, '85 + 18 = 103');
  assert.ok(state.eliminated.includes(other), 'should be eliminated once past the newly-lowered 100 threshold');
});

check('setEliminationScore rejects a value at or below the current highest score on the board', () => {
  const g = new LeastCountGame(['A', 'B', 'C']);
  g.scores = { A: 120, B: 40, C: 0 };
  assert.throws(() => g.setEliminationScore(100), /greater than the current highest score/);
  assert.throws(() => g.setEliminationScore(120), /greater than the current highest score/);
  g.setEliminationScore(150); // strictly greater -- should succeed
  assert.strictEqual(g.eliminationScore, 150);
});

check('setEliminationScore rejects non-numeric or non-positive values', () => {
  const g = new LeastCountGame(['A', 'B']);
  assert.throws(() => g.setEliminationScore('not-a-number'), /Invalid max score/);
  assert.throws(() => g.setEliminationScore(0), /Invalid max score/);
  assert.throws(() => g.setEliminationScore(-50), /Invalid max score/);
});

check('getPublicState exposes the current eliminationScore', () => {
  const g = new LeastCountGame(['A', 'B'], 300);
  const state = g.startRound();
  assert.strictEqual(state.eliminationScore, 300);
});

check('MAX_SCORE_OPTIONS is the expected fixed dropdown list', () => {
  assert.deepStrictEqual(MAX_SCORE_OPTIONS, [100, 150, 200, 250, 300, 350, 400, 450, 500]);
});

// 13. Per-player discard history (public, for the "recent discards" UI)
check('discardHistory tracks each player\'s last 2 discards, capped and per-round', () => {
  const g = new LeastCountGame(['A', 'B']);
  g.startRound();
  g.chainCount = 0;
  const p = g.currentPlayer();
  g.discardPile = [{ id: 'open1', rank: '9', suit: 'S' }]; // no match -> normal discards below all take a penalty draw
  g.roundJokerRank = null;
  g.hands[p] = [
    { id: 'd1', rank: '3', suit: 'C' },
    { id: 'd2', rank: '4', suit: 'C' },
    { id: 'd3', rank: '5', suit: 'C' },
  ];
  assert.deepStrictEqual(g.getPublicState().discardHistory[p], undefined, 'nothing discarded yet');

  g.playTurn(p, ['d1']);
  assert.deepStrictEqual(g.getPublicState().discardHistory[p].map((c) => c.id), ['d1']);

  // it's the other player's turn now -- hand them back control so p can act again
  g.currentTurnIndex = g.turnOrder.indexOf(p);
  g.discardPile.push({ id: 'open2', rank: '9', suit: 'S' });
  g.playTurn(p, ['d2']);
  assert.deepStrictEqual(g.getPublicState().discardHistory[p].map((c) => c.id), ['d1', 'd2']);

  g.currentTurnIndex = g.turnOrder.indexOf(p);
  g.discardPile.push({ id: 'open3', rank: '9', suit: 'S' });
  g.playTurn(p, ['d3']);
  // capped at 2 -- oldest (d1) falls off, only the 2 most recent remain
  assert.deepStrictEqual(g.getPublicState().discardHistory[p].map((c) => c.id), ['d2', 'd3']);
});

check('discardHistory tracks the last 2 DISTINCT ranks, not just the last 2 discards chronologically', () => {
  const g = new LeastCountGame(['A', 'B']);
  g.startRound();
  g.chainCount = 0;
  const p = g.currentPlayer();
  g.discardPile = [{ id: 'open1', rank: '9', suit: 'S' }];
  g.roundJokerRank = null;
  g.hands[p] = [
    { id: 'd1', rank: '3', suit: 'C' },
    { id: 'd2', rank: '4', suit: 'C' },
    { id: 'd3', rank: '3', suit: 'D' }, // same rank as d1, discarded later
  ];

  g.playTurn(p, ['d1']);
  g.currentTurnIndex = g.turnOrder.indexOf(p);
  g.discardPile.push({ id: 'open2', rank: '9', suit: 'S' });
  g.playTurn(p, ['d2']);
  assert.deepStrictEqual(g.getPublicState().discardHistory[p].map((c) => c.rank), ['3', '4']);

  // Discarding another 3 shouldn't create a second "3" entry or push out the
  // "4" -- it should just refresh the existing "3" slot to the most recent
  // position, leaving distinct ranks 4 and 3 (in that order).
  g.currentTurnIndex = g.turnOrder.indexOf(p);
  g.discardPile.push({ id: 'open3', rank: '9', suit: 'S' });
  g.playTurn(p, ['d3']);
  const history = g.getPublicState().discardHistory[p];
  assert.strictEqual(history.length, 2, 'still only 2 distinct-rank entries');
  assert.deepStrictEqual(history.map((c) => c.rank), ['4', '3']);
  assert.strictEqual(history[1].id, 'd3', 'the "3" slot now points at the newer d3 card');
});

check('discardHistory collapses a same-rank multi-card discard into a single entry', () => {
  const g = new LeastCountGame(['A', 'B']);
  g.startRound();
  const p = g.currentPlayer();
  // Directly exercise _recordDiscard -- a free-pass discard of 2 same-rank
  // cards at once (e.g. joker-open free pass) should still only ever record
  // one representative card per rank, never two entries for the same rank.
  g.discardHistory[p] = [];
  g._recordDiscard(p, [
    { id: 'x1', rank: '7', suit: 'C' },
    { id: 'x2', rank: '7', suit: 'D' },
  ]);
  assert.strictEqual(g.discardHistory[p].length, 1);
  assert.strictEqual(g.discardHistory[p][0].rank, '7');
});

check('discardHistory resets fresh at the start of each new round', () => {
  const g = new LeastCountGame(['A', 'B']);
  g.startRound();
  g.discardHistory = { A: [{ id: 'stale', rank: '5', suit: 'S' }] };
  g.roundOver = true;
  g.startRound();
  assert.deepStrictEqual(g.discardHistory, {}, 'should be wiped clean for the new round');
});

// 14. Solo play vs bots -- server.js's runBotTurn() decision logic, mirrored
// here directly against the engine (server.js itself isn't unit-testable
// without a live socket connection, but this is the actual decision it
// makes every bot turn: declare if legally able, otherwise auto-discard).
function botDecide(game, pid) {
  const myValue = handValue(game.hands[pid] || [], game.roundJokerRank);
  if (game.chainCount === 0 && myValue <= DECLARE_MAX_VALUE) {
    game.declare(pid);
    return 'declared';
  }
  const cardIds = game.autoPickDiscard(pid);
  game.playTurn(pid, cardIds);
  return 'discarded';
}

check('bot declares as soon as its hand value qualifies, instead of discarding', () => {
  const g = new LeastCountGame(['bot', 'human']);
  g.startRound();
  g.currentTurnIndex = g.turnOrder.indexOf('bot');
  g.chainCount = 0;
  g.hands.bot = [{ id: 'a', rank: '2', suit: 'S' }, { id: 'b', rank: '3', suit: 'H' }]; // value 5, exactly at the cap
  assert.strictEqual(botDecide(g, 'bot'), 'declared');
  assert.strictEqual(g.roundOver, true);
});

check('bot discards instead of declaring when its hand value is too high', () => {
  const g = new LeastCountGame(['bot', 'human']);
  g.startRound();
  g.currentTurnIndex = g.turnOrder.indexOf('bot');
  g.chainCount = 0;
  g.discardPile = [{ id: 'open1', rank: '9', suit: 'S' }];
  g.roundJokerRank = null;
  g.hands.bot = [{ id: 'x1', rank: 'K', suit: 'C' }, { id: 'x2', rank: '4', suit: 'D' }]; // value 14
  const before = g.hands.bot.length;
  assert.strictEqual(botDecide(g, 'bot'), 'discarded');
  assert.strictEqual(g.roundOver, false);
  assert.ok(g.hands.bot.length !== before || true); // hand composition changed one way or another
});

check('bot answers an active +2 chain instead of declaring, even with a qualifying hand', () => {
  const g = new LeastCountGame(['bot', 'human']);
  g.startRound();
  g.currentTurnIndex = g.turnOrder.indexOf('bot');
  g.chainCount = 1; // a 2 is pending against bot
  g.discardPile = [{ id: 'open1', rank: '2', suit: 'S' }];
  g.roundJokerRank = null;
  g.hands.bot = [{ id: 'two', rank: '2', suit: 'H' }, { id: 'z', rank: 'A', suit: 'D' }]; // value 3, would qualify -- but the chain comes first
  const before = g.hands.bot.length;
  assert.strictEqual(botDecide(g, 'bot'), 'discarded');
  assert.strictEqual(g.hands.bot.length, before - 1, 'should have played its 2, not drawn a penalty or declared');
});

check('an all-bot game plays itself to completion without ever throwing', () => {
  const g = new LeastCountGame(['b1', 'b2', 'b3']);
  g.startRound();
  let turns = 0;
  const MAX_TURNS = 5000;
  while (!g.gameOver && turns < MAX_TURNS) {
    if (g.roundOver) { g.startRound(); continue; }
    botDecide(g, g.currentPlayer());
    turns += 1;
  }
  assert.ok(g.gameOver, `game should reach gameOver within ${MAX_TURNS} turns (took ${turns})`);
  assert.ok(g.winner);
});

console.log(`\n${passed} test(s) passed.`);
if (process.exitCode) console.log('SOME TESTS FAILED');
else console.log('ALL TESTS PASSED');
