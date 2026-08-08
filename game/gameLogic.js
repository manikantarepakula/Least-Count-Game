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
// A losing player's round score is never more than this, no matter how high
// their hand value actually is -- they pay the lower of the two.
const ROUND_SCORE_CAP = 75;
// The fixed set of elimination-score choices offered to the host, both when
// creating the game and again after every round. Kept as a small fixed list
// (rather than free-form input) since it's picked from a dropdown on a
// phone screen.
const MAX_SCORE_OPTIONS = [100, 150, 200, 250, 300, 350, 400, 450, 500];

class LeastCountGame {
  constructor(playerIds, eliminationScore) {
    if (playerIds.length < 2 || playerIds.length > 10) {
      throw new Error('Least Count supports 2-10 players');
    }
    this.playerIds = playerIds.slice();
    this.scores = Object.fromEntries(this.playerIds.map((id) => [id, 0]));
    // Configurable per-game "max score" -- reaching or passing this ends a
    // player's game. Defaults to the original fixed value if the host didn't
    // pick one (e.g. older clients, or direct engine use in tests).
    this.eliminationScore = eliminationScore || ELIMINATION_SCORE;
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
    // Increments every time the discard pile gets reshuffled back into the
    // stock. It's public (doesn't reveal anyone's hand), so every client can
    // compare this against their last-seen value and play a reshuffle sound
    // whenever it changes.
    this.reshuffleCount = 0;
    // Recent discards per player, this round only -- see startRound().
    this.discardHistory = {};
  }

  // Records card(s) a player just discarded into their rolling recent-discard
  // history (public info -- these cards are already face-up on the pile),
  // keeping only the last 2. Called from both a normal discard and a single
  // 2 played mid-chain.
  _recordDiscard(playerId, cards) {
    const existing = this.discardHistory[playerId] || [];
    this.discardHistory[playerId] = [...existing, ...cards].slice(-2);
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

  /**
   * Changes the elimination ("max") score between rounds, so the host can
   * extend or shorten the game based on how it's going. Must be strictly
   * greater than every score on the board right now (including already-
   * eliminated players) -- otherwise raising it to something at or below an
   * existing score would retroactively make no sense (or, for an active
   * player, would eliminate them out of nowhere without a round being played).
   */
  setEliminationScore(newScore) {
    const n = Number(newScore);
    if (!Number.isFinite(n) || n <= 0) throw new Error('Invalid max score.');
    const maxCurrentScore = Math.max(0, ...Object.values(this.scores));
    if (n <= maxCurrentScore) {
      throw new Error(`Max score must be greater than the current highest score (${maxCurrentScore}).`);
    }
    this.eliminationScore = n;
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

    let openCard = shuffled[cursor];
    cursor += 1;
    // A 2 as the very first open card forces the first player straight into
    // a +2 challenge with no real turn of their own -- not banned outright
    // (it's still a normal rank), but redraw once to make it noticeably
    // rarer (roughly 1-in-170 instead of 1-in-13). Whatever comes up on the
    // redraw is accepted either way, even if it's a 2 again.
    if (openCard.rank === '2' && cursor < shuffled.length) {
      openCard = shuffled[cursor];
      cursor += 1;
    }
    this.discardPile = [openCard];

    // Draw a card to fix this round's wild joker rank. A 2 is never allowed
    // to become the wild rank (it already has its own +2 rule), and a printed
    // Joker isn't a rank at all -- so redraw past either of those until a
    // normal rank card comes up. Every round always gets a designated wild
    // rank this way; those burned cards don't return to play.
    let jokerRevealCard = shuffled[cursor];
    cursor += 1;
    while ((jokerRevealCard.rank === '2' || jokerRevealCard.rank === 'JOKER') && cursor < shuffled.length) {
      jokerRevealCard = shuffled[cursor];
      cursor += 1;
    }
    // Fallback for the practically-impossible case of running out of stock
    // mid-redraw: leaves roundJokerRank unset (null) rather than crashing.
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

    // Recent discards per player, this round only -- lets players track what
    // opponents have been throwing away (same info they'd naturally pick up
    // watching a real discard pile), reset fresh every round since hands and
    // the pile itself reset too. Capped to the last 2 cards per player.
    this.discardHistory = {};

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
    this.reshuffleCount += 1;
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

    for (const c of discarded) this.discardPile.push(c);
    this._recordDiscard(playerId, discarded);

    // Open card is a Joker (printed, or this round's wild rank): free pass --
    // any group of same-rank cards can be discarded together with no penalty
    // draw, exactly like a normal rank-match, even though the ranks differ.
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
      this._recordDiscard(playerId, discarded);
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

    // No direct match to the open card. Whether or not this incurs a
    // penalty draw (it doesn't if the open card is a Joker/wild rank), the
    // discard penalty is always a fixed 1 card no matter how many cards get
    // released together -- so the best default is always to unload the
    // single highest-total-value same-rank group in hand, not just the
    // lowest single card. E.g. releasing three 10s for one penalty card is
    // strictly better than giving up one low card and keeping the 10s.
    const groups = new Map();
    for (const c of hand) {
      if (!groups.has(c.rank)) groups.set(c.rank, []);
      groups.get(c.rank).push(c);
    }
    let bestGroup = null;
    let bestValue = -1;
    for (const cards of groups.values()) {
      const totalValue = cards.reduce((sum, c) => sum + cardValue(c, this.roundJokerRank), 0);
      if (totalValue > bestValue) {
        bestValue = totalValue;
        bestGroup = cards;
      }
    }
    return bestGroup.map((c) => c.id);
  }

  declare(playerId) {
    this._assertTurn(playerId);
    // Declaring is only blocked while a +2 challenge is actively pending
    // against this player (chainCount > 0). Once someone takes the penalty
    // and the chain resets, declaring is allowed again immediately, even
    // though the open card itself still visually shows a 2.
    if (this.chainCount > 0) {
      throw new Error('Cannot declare while a +2 challenge is pending against you');
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
    const minHolderCount = Object.values(values).filter((v) => v === minValue).length;
    const correct = myValue === minValue && minHolderCount === 1;
    // A wrong declare where the declarer actually tied with someone else at
    // the true minimum (rather than being nowhere close to it at all).
    const tiedWrongDeclare = !correct && myValue === minValue;

    const roundScores = {};
    if (correct) {
      // Sole minimum holder: declarer scores 0, everyone else pays their own
      // hand value (capped -- see ROUND_SCORE_CAP).
      for (const id of this.turnOrder) {
        roundScores[id] = id === playerId ? 0 : Math.min(ROUND_SCORE_CAP, values[id]);
      }
    } else if (tiedWrongDeclare) {
      // Tied with at least one other player at the true minimum -- still a
      // wrong declare (you must be the SOLE minimum to win), but gentler
      // than a genuinely bad declare: the declarer pays their own (small,
      // since declaring itself requires hand value <= DECLARE_MAX_VALUE)
      // hand value instead of the flat penalty, while whoever they tied
      // with still gets the usual reward of 0.
      for (const id of this.turnOrder) {
        if (id === playerId) roundScores[id] = myValue;
        else if (values[id] === minValue) roundScores[id] = 0;
        else roundScores[id] = Math.min(ROUND_SCORE_CAP, values[id]);
      }
    } else {
      // Genuinely bad declare: the declarer's hand wasn't even tied for the
      // true minimum, so the flat wrong-declare penalty applies.
      for (const id of this.turnOrder) {
        if (values[id] === minValue) roundScores[id] = 0;
        else if (id === playerId) roundScores[id] = WRONG_DECLARE_PENALTY;
        else roundScores[id] = Math.min(ROUND_SCORE_CAP, values[id]);
      }
    }

    const preScores = { ...this.scores };
    for (const id of this.turnOrder) {
      this.scores[id] += roundScores[id];
      if (this.scores[id] >= this.eliminationScore) this.eliminated.add(id);
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
      reshuffleCount: this.reshuffleCount,
      scores: { ...this.scores },
      eliminationScore: this.eliminationScore,
      eliminated: [...this.eliminated],
      quit: [...this.quit],
      roundOver: this.roundOver,
      gameOver: this.gameOver,
      winner: this.winner,
      lastRoundResult: this.lastRoundResult,
      handCounts: this.hands
        ? Object.fromEntries(Object.entries(this.hands).map(([id, h]) => [id, h.length]))
        : {},
      // Public -- these cards are already face-up on the discard pile, so
      // there's no hidden info here, just a convenience so the client doesn't
      // have to replay the whole discard pile to know who threw what recently.
      discardHistory: this.discardHistory || {},
    };
    if (forPlayerId && this.hands && this.hands[forPlayerId]) {
      state.yourHand = this.hands[forPlayerId];
      state.yourHandValue = handValue(this.hands[forPlayerId], this.roundJokerRank);
    }
    // Once a round is over, there's no more strategic reason to keep hands
    // private for that round -- reveal everyone's actual final cards (and
    // their point value) to every player, for the dramatic reveal shown
    // after every round (not just the game-ending one).
    if (this.roundOver && this.hands) {
      state.finalHands = this.hands;
      state.finalHandValues = Object.fromEntries(
        Object.entries(this.hands).map(([id, h]) => [id, handValue(h, this.roundJokerRank)])
      );
    }
    return state;
  }
}

module.exports = {
  SUITS, RANKS, DECK_COUNT_TABLE,
  deckCountForPlayers, createShoe, shuffle,
  rankValue, cardValue, handValue,
  LeastCountGame,
  ELIMINATION_SCORE, WRONG_DECLARE_PENALTY, DECLARE_MAX_VALUE, ROUND_SCORE_CAP,
  MAX_SCORE_OPTIONS,
};
