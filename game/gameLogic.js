// ---------------------------------------------------------------------------
// Least Count - core game engine (pure logic, zero dependencies)
// ---------------------------------------------------------------------------

const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

const DECK_COUNT_TABLE = {
  2: 3, 3: 3, 4: 3,
  5: 4, 6: 4,
  7: 5, 8: 5,
  9: 6, 10: 6,
};

function deckCountForPlayers(numPlayers) {
  if (DECK_COUNT_TABLE[numPlayers]) return DECK_COUNT_TABLE[numPlayers];
  if (numPlayers < 2) return 3;
  return 6 + Math.ceil((numPlayers - 10) / 2);
}

function rankValue(rank) {
  if (rank === 'JOKER') return 0;
  if (rank === 'A') return 1;
  if (rank === 'J' || rank === 'Q' || rank === 'K') return 10;
  return parseInt(rank, 10);
}

let _cardIdCounter = 0;
function makeCard(rank, suit, deckIndex) {
  _cardIdCounter += 1;
  return { id: `c${_cardIdCounter}`, rank, suit, deckIndex };
}

function createShoe(numPlayers) {
  _cardIdCounter = 0;
  const numDecks = deckCountForPlayers(numPlayers);
  const cards = [];
  for (let d = 0; d < numDecks; d++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        cards.push(makeCard(rank, suit, d));
      }
    }
    cards.push(makeCard('JOKER', null, d));
    cards.push(makeCard('JOKER', null, d));
  }
  return { cards, numDecks };
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function cardValue(card, roundJokerRank) {
  if (card.rank === 'JOKER') return 0;
  if (roundJokerRank && card.rank === roundJokerRank) return 0;
  return rankValue(card.rank);
}

function handValue(hand, roundJokerRank) {
  return hand.reduce((sum, c) => sum + cardValue(c, roundJokerRank), 0);
}

const ELIMINATION_SCORE = 200;
const WRONG_DECLARE_PENALTY = 75;
const DECLARE_MAX_VALUE = 5;

class LeastCountGame {
  constructor(playerIds) {
    if (playerIds.length < 2 || playerIds.length > 10) {
      throw new Error('Least Count supports 2-10 players');
    }
    this.playerIds = playerIds.slice();
    this.scores = Object.fromEntries(this.playerIds.map((id) => [id, 0]));
    this.eliminated = new Set(); // out due to reaching the score limit
    this.quit = new Set(); // voluntarily left between rounds
    this.roundNumber = 0;
    this.dealerIndex = -1;
    this.log = [];
    this.roundOver = true;
    this.gameOver = false;
    this.winner = null;
    // Transient: which player just drew penalty card(s) and what they got,
    // so the server can privately reveal it to them. Cleared/reset on every
    // playTurn()/_playDuring2Chain() call.
    this.lastDraw = null;
  }

  activePlayers() {
    return this.playerIds.filter((id) => !this.eliminated.has(id) && !this.quit.has(id));
  }

  _nextActiveIndexFrom(startIdx) {
    const n = this.playerIds.length;
    for (let step = 1; step <= n; step++) {
      const idx = (startIdx + step) % n;
      const id = this.playerIds[idx];
      if (!this.eliminated.has(id) && !this.quit.has(id)) return idx;
    }
    return -1;
  }

  /**
   * Voluntarily remove a player from the game. Only allowed between rounds
   * (i.e. while roundOver is true), so nobody's mid-hand cards vanish.
   */
  removePlayer(playerId) {
    if (this.gameOver) throw new Error('Game already over');
    if (!this.roundOver) throw new Error('Cannot leave in the middle of a round');
    if (this.eliminated.has(playerId) || this.quit.has(playerId)) return this.getPublicState();

    this.quit.add(playerId);
    this.log.push({ type: 'quit', round: this.roundNumber, playerId });

    const stillActive = this.activePlayers();
    if (stillActive.length <= 1) {
      this.gameOver = true;
      this.winner = stillActive[0] || null;
    }
    return this.getPublicState();
  }

  startRound() {
    if (this.gameOver) throw new Error('Game already over');
    const active = this.activePlayers();
    if (active.length < 2) {
      this.gameOver = true;
      this.winner = active[0] || null;
      return this.getPublicState();
    }

    this.roundNumber += 1;
    // The player who starts each round rotates chronologically through the
    // seating order: player 1 starts round 1, player 2 starts round 2, and
    // so on (wrapping around, and skipping anyone eliminated/quit).
    this.dealerIndex = this._nextActiveIndexFrom(this.dealerIndex);

    const { cards, numDecks } = createShoe(active.length);
    const shuffled = shuffle(cards);

    this.hands = {};
    for (const id of active) this.hands[id] = [];

    let cursor = 0;
    let idx = this.dealerIndex;
    const order = [this.playerIds[idx]];
    for (let i = 1; i < active.length; i++) {
      idx = this._nextActiveIndexFrom(idx);
      order.push(this.playerIds[idx]);
    }
    this.turnOrder = order;

    for (let r = 0; r < 13; r++) {
      for (const id of order) {
        this.hands[id].push(shuffled[cursor]);
        cursor += 1;
      }
    }

    const openCard = shuffled[cursor];
    cursor += 1;
    this.discardPile = [openCard];

    // Draw a card to fix this round's wild joker rank. A 2 is never allowed
    // to become the wild rank (it already has its own +2 rule), so redraw
    // past any 2s that come up; those burned cards don't return to play.
    let jokerRevealCard = shuffled[cursor];
    cursor += 1;
    while (jokerRevealCard.rank === '2' && cursor < shuffled.length) {
      jokerRevealCard = shuffled[cursor];
      cursor += 1;
    }
    this.roundJokerRank = (jokerRevealCard.rank === 'JOKER' || jokerRevealCard.rank === '2')
      ? null
      : jokerRevealCard.rank;
    this.jokerRevealCard = jokerRevealCard;

    this.stock = shuffled.slice(cursor);
    this.numDecks = numDecks;

    this.currentTurnIndex = 0;
    // If the very first open card revealed at dealing time is a 2, the first
    // player immediately faces the +2 challenge (play a 2 or draw 2 cards),
    // exactly as if someone had just discarded a 2 mid-game.
    this.chainCount = openCard.rank === '2' ? 1 : 0;
    this.roundOver = false;
    this.lastRoundResult = null;

    return this.getPublicState();
  }

  currentPlayer() {
    return this.turnOrder[this.currentTurnIndex];
  }

  _openRank() {
    return this.discardPile[this.discardPile.length - 1].rank;
  }

  // True when the open card is a Joker: either a printed Joker, or a card of
  // this round's randomly-selected wild rank.
  _openIsJoker() {
    const r = this._openRank();
    return r === 'JOKER' || (this.roundJokerRank !== null && r === this.roundJokerRank);
  }

  _drawFromStock(count) {
    const drawn = [];
    for (let i = 0; i < count; i++) {
      if (this.stock.length === 0) this._reshuffleDiscardIntoStock();
      if (this.stock.length === 0) break;
      drawn.push(this.stock.pop());
    }
    return drawn;
  }

  _reshuffleDiscardIntoStock() {
    if (this.discardPile.length <= 1) return;
    const top = this.discardPile[this.discardPile.length - 1];
    const rest = this.discardPile.slice(0, -1);
    this.stock = shuffle(rest);
    this.discardPile = [top];
    this.log.push({ type: 'reshuffle', round: this.roundNumber });
  }

  _advanceTurn() {
    this.currentTurnIndex = (this.currentTurnIndex + 1) % this.turnOrder.length;
  }

  _removeCardsFromHand(playerId, cardIds) {
    const hand = this.hands[playerId];
    const idSet = new Set(cardIds);
    const removed = hand.filter((c) => idSet.has(c.id));
    if (removed.length !== cardIds.length) {
      throw new Error('One or more cards not found in hand');
    }
    this.hands[playerId] = hand.filter((c) => !idSet.has(c.id));
    return removed;
  }

  playTurn(playerId, cardIds) {
    this._assertTurn(playerId);
    this.lastDraw = null;
    if (this.chainCount > 0) {
      return this._playDuring2Chain(playerId, cardIds);
    }
    if (!cardIds || cardIds.length === 0) throw new Error('Must discard at least one card');

    const discarded = this._removeCardsFromHand(playerId, cardIds);
    const rank = discarded[0].rank;
    if (!discarded.every((c) => c.rank === rank)) {
      throw new Error('All discarded cards must share the same rank');
    }

    const openRank = this._openRank();
    const matchesOpen = rank === openRank;
    const openIsJoker = this._openIsJoker();

    // Open card is a Joker (printed, or this round's wild rank): free pass,
    // any ONE card can be discarded with no penalty draw.
    if (openIsJoker && !matchesOpen && discarded.length > 1) {
      this.hands[playerId].push(...discarded);
      throw new Error('Open card is a Joker: you may discard only one card');
    }

    for (const c of discarded) this.discardPile.push(c);

    let penaltyDrawn = [];
    if (!matchesOpen && !openIsJoker) {
      penaltyDrawn = this._drawFromStock(1);
      this.hands[playerId].push(...penaltyDrawn);
      this.lastDraw = { playerId, cards: penaltyDrawn };
    }

    if (rank === '2') {
      this.chainCount = 1;
    } else {
      this.chainCount = 0;
    }

    this.log.push({
      type: 'discard', round: this.roundNumber, playerId,
      rank, count: discarded.length, matchedOpen: matchesOpen,
      penaltyDrawn: penaltyDrawn.length,
    });

    if (!this.roundOver) this._advanceTurn();
    return this.getPublicState();
  }

  _playDuring2Chain(playerId, cardIds) {
    if (cardIds && cardIds.length > 0) {
      const discarded = this._removeCardsFromHand(playerId, cardIds);
      if (discarded.length !== 1 || discarded[0].rank !== '2') {
        this.hands[playerId].push(...discarded);
        throw new Error('While facing a +2 challenge you must play exactly one 2, or draw the penalty');
      }
      this.discardPile.push(discarded[0]);
      this.chainCount += 1;
      this.log.push({ type: '2-chain-extend', round: this.roundNumber, playerId, chainCount: this.chainCount });
      if (!this.roundOver) this._advanceTurn();
      return this.getPublicState();
    }

    const penalty = 2 * this.chainCount;
    const drawn = this._drawFromStock(penalty);
    this.hands[playerId].push(...drawn);
    this.lastDraw = { playerId, cards: drawn };
    this.log.push({ type: '2-chain-penalty', round: this.roundNumber, playerId, penalty: drawn.length });
    this.chainCount = 0;
    this._advanceTurn();
    return this.getPublicState();
  }

  _assertTurn(playerId) {
    if (this.roundOver) throw new Error('Round is over, start a new round');
    if (this.currentPlayer() !== playerId) throw new Error('Not your turn');
  }

  /**
   * Picks a sensible default action for a player who ran out of time on their
   * turn. Never auto-declares (that's always a deliberate, riskier choice).
   * Returns the card id(s) that would be passed to playTurn().
   */
  autoPickDiscard(playerId) {
    const hand = this.hands[playerId] || [];
    if (hand.length === 0) return [];

    if (this.chainCount > 0) {
      const two = hand.find((c) => c.rank === '2');
      return two ? [two.id] : []; // [] means: accept the +2 penalty
    }

    const openRank = this._openRank();
    const matching = hand.filter((c) => c.rank === openRank);
    if (matching.length > 0) return matching.map((c) => c.id);

    // No free match available: give up the single lowest-value card.
    let lowest = hand[0];
    for (const c of hand) {
      if (cardValue(c, this.roundJokerRank) < cardValue(lowest, this.roundJokerRank)) lowest = c;
    }
    return [lowest.id];
  }

  declare(playerId) {
    this._assertTurn(playerId);
    if (this.chainCount > 0) {
      throw new Error('Cannot declare while a +2 challenge is pending against you');
    }
    // Even after a +2 chain resets (someone accepted the penalty instead of
    // playing a 2), the open card itself is still a 2 until someone plays a
    // non-2 discard on top of it. Declaring is blocked for that whole time.
    if (this._openRank() === '2') {
      throw new Error('Cannot declare Least Count while the open card is a 2');
    }
    const myValue = handValue(this.hands[playerId], this.roundJokerRank);
    if (myValue > DECLARE_MAX_VALUE) {
      throw new Error(`Hand value ${myValue} is too high to declare (must be <= ${DECLARE_MAX_VALUE})`);
    }

    const values = {};
    for (const id of this.turnOrder) {
      values[id] = handValue(this.hands[id], this.roundJokerRank);
    }
    const minValue = Math.min(...Object.values(values));
    const correct = myValue === minValue && Object.values(values).filter((v) => v === minValue).length === 1;

    const roundScores = {};
    if (correct) {
      for (const id of this.turnOrder) {
        roundScores[id] = id === playerId ? 0 : values[id];
      }
    } else {
      for (const id of this.turnOrder) {
        if (values[id] === minValue) roundScores[id] = 0;
        else if (id === playerId) roundScores[id] = WRONG_DECLARE_PENALTY;
        else roundScores[id] = values[id];
      }
    }

    const preScores = { ...this.scores };
    for (const id of this.turnOrder) {
      this.scores[id] += roundScores[id];
      if (this.scores[id] >= ELIMINATION_SCORE) this.eliminated.add(id);
    }

    this.lastRoundResult = {
      declaredBy: playerId, correct, values, roundScores,
      cumulativeScores: { ...this.scores },
      newlyEliminated: this.turnOrder.filter((id) => this.eliminated.has(id) && preScores[id] < ELIMINATION_SCORE),
    };
    this.roundOver = true;

    const stillActive = this.activePlayers();
    if (stillActive.length <= 1) {
      this.gameOver = true;
      this.winner = stillActive[0] || null;
    }

    this.log.push({ type: 'declare', round: this.roundNumber, playerId, correct, roundScores });
    return this.getPublicState();
  }

  getPublicState(forPlayerId) {
    const state = {
      roundNumber: this.roundNumber,
      turnOrder: this.turnOrder,
      currentPlayer: this.roundOver ? null : this.currentPlayer(),
      openCard: this.discardPile ? this.discardPile[this.discardPile.length - 1] : null,
      roundJokerRank: this.roundJokerRank,
      chainCount: this.chainCount,
      stockCount: this.stock ? this.stock.length : 0,
      scores: { ...this.scores },
      eliminated: [...this.eliminated],
      quit: [...this.quit],
      roundOver: this.roundOver,
      gameOver: this.gameOver,
      winner: this.winner,
      lastRoundResult: this.lastRoundResult,
      handCounts: this.hands
        ? Object.fromEntries(Object.entries(this.hands).map(([id, h]) => [id, h.length]))
        : {},
    };
    if (forPlayerId && this.hands && this.hands[forPlayerId]) {
      state.yourHand = this.hands[forPlayerId];
      state.yourHandValue = handValue(this.hands[forPlayerId], this.roundJokerRank);
    }
    return state;
  }
}

module.exports = {
  SUITS, RANKS, DECK_COUNT_TABLE,
  deckCountForPlayers, createShoe, shuffle,
  rankValue, cardValue, handValue,
  LeastCountGame,
  ELIMINATION_SCORE, WRONG_DECLARE_PENALTY, DECLARE_MAX_VALUE,
};
