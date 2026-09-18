const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

let teams = JSON.parse(fs.readFileSync(path.join(__dirname, 'teams.json'), 'utf8'));
let players = JSON.parse(fs.readFileSync(path.join(__dirname, 'players.json'), 'utf8'));

const MAX_ROSTER_SIZE = 13;
const RESET_SECONDS_ON_BID = 8;

let draftState = {
  isDraftActive: true,
  nominatedPlayer: null,
  currentBid: 0,
  highBidder: null,
  nominatingTeamId: 1,
  timerSeconds: 15,
  isPaused: false
};

let timerInterval = null;
let autoBidTimeout = null;

function saveStateToDisk() {
  fs.writeFileSync(path.join(__dirname, 'teams.json'), JSON.stringify(teams, null, 2));
  fs.writeFileSync(path.join(__dirname, 'players.json'), JSON.stringify(players, null, 2));
}

function getMaxAllowedBid(team) {
  const openSpots = MAX_ROSTER_SIZE - team.roster.length;
  if (openSpots <= 0) return 0;
  return team.budget - (openSpots - 1);
}

function startAuctionClock() {
  clearInterval(timerInterval);
  draftState.timerSeconds = 15;

  timerInterval = setInterval(() => {
    if (draftState.isPaused || !draftState.nominatedPlayer) return;

    draftState.timerSeconds -= 1;
    io.emit('timerTick', { seconds: draftState.timerSeconds });

    if (draftState.timerSeconds <= 0) {
      clearInterval(timerInterval);
      clearTimeout(autoBidTimeout);
      finalizeSale();
    }
  }, 1000);
}

function finalizeSale() {
  const player = draftState.nominatedPlayer;
  const winner = draftState.highBidder;
  const price = draftState.currentBid;

  if (winner && player) {
    const winningTeam = teams.find(t => t.id === winner.id);
    const targetPlayer = players.find(p => p.id === player.id);

    winningTeam.budget -= price;
    winningTeam.roster.push({ id: player.id, name: player.name, price: price });
    targetPlayer.status = 'drafted';
    targetPlayer.draftedBy = winningTeam.name;
    targetPlayer.price = price;

    saveStateToDisk();

    io.emit('playerSold', {
      player: targetPlayer,
      winningTeam: winningTeam,
      price: price
    });
  }

  draftState.nominatedPlayer = null;
  draftState.currentBid = 0;
  draftState.highBidder = null;
  draftState.timerSeconds = 15;
  draftState.nominatingTeamId = (draftState.nominatingTeamId % teams.length) + 1;

  io.emit('stateUpdate', { draftState, teams, players });
}

function triggerAutodraftCheck() {
  clearTimeout(autoBidTimeout);

  autoBidTimeout = setTimeout(() => {
    if (!draftState.nominatedPlayer || draftState.isPaused) return;

    const player = draftState.nominatedPlayer;
    const currentBid = draftState.currentBid;
    const nextBidRequired = currentBid + 1;

    const eligibleBots = teams.filter(t => {
      if (!t.isAuto) return false;
      if (draftState.highBidder && draftState.highBidder.id === t.id) return false;

      const playerCap = player.autoCaps ? player.autoCaps[t.id] : null;
      if (!playerCap || playerCap < nextBidRequired) return false;

      const maxAllowed = getMaxAllowedBid(t);
      if (nextBidRequired > maxAllowed) return false;

      return true;
    });

    if (eligibleBots.length === 0) return;

    eligibleBots.sort((a, b) => {
      const capA = player.autoCaps[a.id];
      const capB = player.autoCaps[b.id];
      return capB - capA;
    });

    const winningBot = eligibleBots[0];

    draftState.currentBid = nextBidRequired;
    draftState.highBidder = { id: winningBot.id, name: winningBot.name };

    if (draftState.timerSeconds < RESET_SECONDS_ON_BID) {
      draftState.timerSeconds = RESET_SECONDS_ON_BID;
    }

    io.emit('bidAccepted', { draftState, isAutoBid: true });

    triggerAutodraftCheck();
  }, 1200);
}

io.on('connection', (socket) => {
  socket.emit('initData', { teams, players, draftState });

  socket.on('nominatePlayer', ({ playerId, teamId, openingBid }) => {
    if (draftState.nominatedPlayer || draftState.isPaused) return;

    const player = players.find(p => p.id === playerId && p.status === 'available');
    const team = teams.find(t => t.id === teamId);

    if (!player || !team) return;

    const bid = parseInt(openingBid, 10) || 1;
    const maxAllowed = getMaxAllowedBid(team);

    if (bid > maxAllowed) return;

    draftState.nominatedPlayer = player;
    draftState.currentBid = bid;
    draftState.highBidder = { id: team.id, name: team.name };

    startAuctionClock();
    io.emit('playerNominated', { draftState });
    triggerAutodraftCheck();
  });

  socket.on('placeBid', ({ teamId, bidAmount }) => {
    if (!draftState.nominatedPlayer || draftState.isPaused) return;

    const team = teams.find(t => t.id === teamId);
    const bid = parseInt(bidAmount, 10);
    const maxAllowed = getMaxAllowedBid(team);

    if (bid <= draftState.currentBid) return;
    if (bid > maxAllowed) return;
    if (draftState.highBidder && draftState.highBidder.id === team.id) return;

    draftState.currentBid = bid;
    draftState.highBidder = { id: team.id, name: team.name };

    if (draftState.timerSeconds < RESET_SECONDS_ON_BID) {
      draftState.timerSeconds = RESET_SECONDS_ON_BID;
    }

    io.emit('bidAccepted', { draftState, isAutoBid: false });
    triggerAutodraftCheck();
  });

  socket.on('updateAutoCap', ({ teamId, playerId, maxBid }) => {
    const player = players.find(p => p.id === playerId);
    if (!player) return;

    if (!player.autoCaps) {
      player.autoCaps = {};
    }

    const cleanBid = parseInt(maxBid, 10);
    if (isNaN(cleanBid) || cleanBid <= 0) {
      delete player.autoCaps[teamId];
    } else {
      player.autoCaps[teamId] = cleanBid;
    }

    saveStateToDisk();
    io.emit('capsUpdated', { playerId: player.id, autoCaps: player.autoCaps });
  });

  // Commissioner Controls
  socket.on('adminTogglePause', () => {
    draftState.isPaused = !draftState.isPaused;
    io.emit('adminStateChanged', { draftState });
  });

  socket.on('adminResetCurrentBlock', () => {
    clearInterval(timerInterval);
    clearTimeout(autoBidTimeout);
    draftState.nominatedPlayer = null;
    draftState.currentBid = 0;
    draftState.highBidder = null;
    draftState.timerSeconds = 15;
    draftState.isPaused = false;
    io.emit('stateUpdate', { draftState, teams, players });
  });

  socket.on('adminResetAllDraftData', () => {
    clearInterval(timerInterval);
    clearTimeout(autoBidTimeout);

    teams.forEach(t => {
      t.budget = 200;
      t.roster = [];
    });

    players.forEach(p => {
      p.status = 'available';
      p.draftedBy = null;
      p.price = 0;
    });

    draftState = {
      isDraftActive: true,
      nominatedPlayer: null,
      currentBid: 0,
      highBidder: null,
      nominatingTeamId: 1,
      timerSeconds: 15,
      isPaused: false
    };

    saveStateToDisk();
    io.emit('stateUpdate', { draftState, teams, players });
  });
});

server.listen(PORT, () => {
  console.log(`🚀 NBA Auction Draft Server is running on http://localhost:3000`);
});