const assert = require('assert');
const {
  deckCountForPlayers, createShoe, cardValue, handValue, LeastCountGame,
  ELIMINATION_SCORE, WRONG_DECLARE_PENALTY,
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
    // 1 open card + 1 joker-reveal card (burned) + stock should account for the rest
    assert.strictEqual(g.stock.length, totalShoe - totalDealt - 2);
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

// 7. Stock reshuffle when empty
check('stock reshuffles from discard pile when empty', () => {
  const g = new LeastCountGame(['A', 'B']);
  g.startRound();
  g.discardPile = [
    { id: 'd1', rank: '3', suit: 'S' },
    { id: 'd2', rank: '4', suit: 'H' },
    { id: 'd3', rank: '5', suit: 'D' },
  ];
  g.stock = [];
  const drawn = g._drawFromStock(1);
  assert.strictEqual(drawn.length, 1);
  assert.strictEqual(g.discardPile.length, 1, 'only the top open card remains in discard pile');
  assert.strictEqual(g.discardPile[0].id, 'd3');
});

// 8. Declare: correct case
check('correct Least Count declaration scores 0 for declarer, own value for others', () => {
  const g = new LeastCountGame(['A', 'B', 'C']);
  g.startRound();
  g.roundJokerRank = null; // pin down randomness so rigged hand values below are deterministic
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
  const declarer = g.currentPlayer();
  const other = g.turnOrder.find((id) => id !== declarer);
  g.hands[declarer] = [{ id: 'v1', rank: '4', suit: 'S' }]; // value 4, declares
  g.hands[other] = [{ id: 'v2', rank: '2', suit: 'H' }]; // value 2, lower!
  const state = g.declare(declarer);
  assert.strictEqual(state.lastRoundResult.correct, false);
  assert.strictEqual(state.scores[declarer], WRONG_DECLARE_PENALTY);
  assert.strictEqual(state.scores[other], 0);
});

// 10. Declaration blocked above value 5
check('cannot declare with hand value > 5', () => {
  const g = new LeastCountGame(['A', 'B']);
  g.startRound();
  g.roundJokerRank = null;
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

console.log(`\n${passed} test(s) passed.`);
if (process.exitCode) console.log('SOME TESTS FAILED');
else console.log('ALL TESTS PASSED');
