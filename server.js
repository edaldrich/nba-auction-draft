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
let draftHistory = [];

// Dynamic Timer Configuration
let timerConfig = {
  nominationTime: 45,
  beginningBidTime: 45,
  additionalBidTime: 10
};

// Map socket id to authenticated team id
const socketSessions = new Map();

function getOnlineTeamIds() {
  return new Set(Array.from(socketSessions.values()));
}

function getPublicTeams() {
  const onlineIds = getOnlineTeamIds();
  return teams.map(t => {
    let status = 'offline';
    if (t.isAuto) {
      status = 'auto';
    } else if (onlineIds.has(t.id)) {
      status = 'online';
    }

    return {
      id: t.id,
      name: t.name,
      budget: t.budget,
      roster: t.roster,
      isAuto: t.isAuto,
      isCommish: !!t.isCommish,
      status: status
    };
  });
}

function getPublicPlayers() {
  return players.map(p => {
    const { autoCaps, ...publicFields } = p;
    return publicFields;
  });
}

function getTeamCaps(teamId) {
  const caps = {};
  players.forEach(p => {
    if (p.autoCaps && p.autoCaps[teamId]) {
      caps[p.id] = p.autoCaps[teamId];
    }
  });
  return caps;
}

function isTeamEligible(team) {
  return team.roster.length < MAX_ROSTER_SIZE && team.budget > 0;
}

function getNextNominatorId(currentId) {
  const total = teams.length;
  let nextId = (currentId % total) + 1;
  let attempts = 0;

  while (attempts < total) {
    const candidate = teams.find(t => t.id === nextId);
    if (candidate && isTeamEligible(candidate)) {
      return candidate.id;
    }
    nextId = (nextId % total) + 1;
    attempts++;
  }
  return null;
}

function getOnDeckNominatorId(currentNominatorId) {
  if (!currentNominatorId) return null;
  return getNextNominatorId(currentNominatorId);
}

let draftState = {
  isDraftActive: true,
  nominatedPlayer: null,
  currentBid: 0,
  highBidder: null,
  nominatingTeamId: 1,
  onDeckTeamId: getNextNominatorId(1),
  timerSeconds: timerConfig.nominationTime,
  timerMode: 'nomination', // 'nomination' or 'auction'
  isPaused: false
};

function saveStateToDisk() {
  fs.writeFileSync(path.join(__dirname, 'teams.json'), JSON.stringify(teams, null, 2));
  fs.writeFileSync(path.join(__dirname, 'players.json'), JSON.stringify(players, null, 2));
}

function getMaxAllowedBid(team) {
  const openSpots = MAX_ROSTER_SIZE - team.roster.length;
  if (openSpots <= 0) return 0;
  return team.budget - (openSpots - 1);
}

let timerInterval = null;
let autoBidTimeout = null;

function startTimer(mode, duration) {
  clearInterval(timerInterval);
  draftState.timerMode = mode;
  draftState.timerSeconds = duration;

  timerInterval = setInterval(() => {
    if (draftState.isPaused) return;

    draftState.timerSeconds -= 1;
    io.emit('timerTick', { seconds: draftState.timerSeconds, mode: draftState.timerMode });

    if (draftState.timerSeconds <= 0) {
      clearInterval(timerInterval);
      clearTimeout(autoBidTimeout);

      if (draftState.timerMode === 'nomination') {
        autoNominateCurrentTeam();
      } else {
        finalizeSale();
      }
    }
  }, 1000);
}

// Auto-nominate if team lets nomination clock hit zero
function autoNominateCurrentTeam() {
  const team = teams.find(t => t.id === draftState.nominatingTeamId);
  const available = players.filter(p => p.status === 'available');
  if (!available.length || !team) return;

  // Pick top available player
  const player = available[0];
  executeNomination(player.id, team.id, 1);
}

function executeNomination(playerId, teamId, openingBid) {
  const player = players.find(p => p.id === playerId && p.status === 'available');
  const team = teams.find(t => t.id === teamId);

  if (!player || !team || !isTeamEligible(team)) return;

  const bid = parseInt(openingBid, 10) || 1;
  const maxAllowed = getMaxAllowedBid(team);
  if (bid > maxAllowed) return;

  draftState.nominatedPlayer = player;
  draftState.currentBid = bid;
  draftState.highBidder = { id: team.id, name: team.name };

  startTimer('auction', timerConfig.beginningBidTime);
  io.emit('playerNominated', { draftState });
  triggerAutodraftCheck();
}

function finalizeSale() {
  const player = draftState.nominatedPlayer;
  const winner = draftState.highBidder;
  const price = draftState.currentBid;

  if (winner && player) {
    const winningTeam = teams.find(t => t.id === winner.id);
    const targetPlayer = players.find(p => p.id === player.id);

    winningTeam.budget -= price;
    winningTeam.roster.push({
      id: player.id,
      name: player.name,
      pos: player.pos,
      nbaTeam: player.nbaTeam,
      price: price
    });
    targetPlayer.status = 'drafted';
    targetPlayer.draftedBy = winningTeam.name;
    targetPlayer.draftedByTeamId = winningTeam.id;
    targetPlayer.price = price;

    draftHistory.push({
      playerId: targetPlayer.id,
      teamId: winningTeam.id,
      price: price,
      previousNominatorId: draftState.nominatingTeamId
    });

    saveStateToDisk();

    io.emit('playerSold', {
      player: targetPlayer,
      winningTeam: winningTeam,
      price: price
    });
  }

  const nextNom = getNextNominatorId(draftState.nominatingTeamId);
  draftState.nominatingTeamId = nextNom;
  draftState.onDeckTeamId = getOnDeckNominatorId(nextNom);

  draftState.nominatedPlayer = null;
  draftState.currentBid = 0;
  draftState.highBidder = null;

  startTimer('nomination', timerConfig.nominationTime);

  io.emit('stateUpdate', {
    draftState,
    teams: getPublicTeams(),
    players: getPublicPlayers()
  });
}

function triggerAutodraftCheck() {
  clearTimeout(autoBidTimeout);

  // Exact 3-second pause before autodraft bot bid executes
  autoBidTimeout = setTimeout(() => {
    if (!draftState.nominatedPlayer || draftState.isPaused || draftState.timerMode !== 'auction') return;

    const player = draftState.nominatedPlayer;
    const currentBid = draftState.currentBid;
    const nextBidRequired = currentBid + 1;

    // Filter eligible autodraft bots:
    // 1. isAuto = true
    // 2. Not already high bidder
    // 3. autoCap >= nextBidRequired
    // 4. Budget & roster space checks pass
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

    // Pick randomly if multiple bots qualify
    const randomIndex = Math.floor(Math.random() * eligibleBots.length);
    const winningBot = eligibleBots[randomIndex];

    draftState.currentBid = nextBidRequired;
    draftState.highBidder = { id: winningBot.id, name: winningBot.name };

    // Additional bid time logic: only bump up to minimum if currently below it
    if (draftState.timerSeconds < timerConfig.additionalBidTime) {
      draftState.timerSeconds = timerConfig.additionalBidTime;
    }

    io.emit('bidAccepted', { draftState, isAutoBid: true });

    triggerAutodraftCheck();
  }, 3000);
}

io.on('connection', (socket) => {
  draftState.onDeckTeamId = getOnDeckNominatorId(draftState.nominatingTeamId);

  socket.on('authTeam', ({ passcode }) => {
    const team = teams.find(t => t.passcode === passcode.trim());
    if (!team) {
      socket.emit('authError', { message: 'Invalid Team Passcode' });
      return;
    }

    socketSessions.set(socket.id, team.id);

    socket.emit('authSuccess', {
      myTeam: {
        id: team.id,
        name: team.name,
        isCommish: !!team.isCommish,
        isAuto: team.isAuto
      },
      myCaps: getTeamCaps(team.id),
      timerConfig,
      teams: getPublicTeams(),
      players: getPublicPlayers(),
      draftState
    });

    // Notify all rooms of updated presence
    io.emit('presenceUpdate', { teams: getPublicTeams() });
  });

  socket.on('toggleMyAutoDraft', () => {
    const teamId = socketSessions.get(socket.id);
    const team = teams.find(t => t.id === teamId);
    if (!team) return;

    team.isAuto = !team.isAuto;
    saveStateToDisk();

    io.emit('presenceUpdate', { teams: getPublicTeams() });
    socket.emit('myAutoDraftChanged', { isAuto: team.isAuto });

    if (team.isAuto && draftState.nominatedPlayer) {
      triggerAutodraftCheck();
    }
  });

  socket.on('nominatePlayer', ({ playerId, openingBid }) => {
    const teamId = socketSessions.get(socket.id);
    if (!teamId || draftState.nominatedPlayer || draftState.isPaused) return;
    if (teamId !== draftState.nominatingTeamId) return;

    executeNomination(playerId, teamId, openingBid);
  });

  socket.on('placeBid', ({ bidAmount }) => {
    const teamId = socketSessions.get(socket.id);
    if (!teamId || !draftState.nominatedPlayer || draftState.isPaused || draftState.timerMode !== 'auction') return;

    const team = teams.find(t => t.id === teamId);
    if (!team || !isTeamEligible(team)) return;

    const bid = parseInt(bidAmount, 10);
    const maxAllowed = getMaxAllowedBid(team);

    if (bid <= draftState.currentBid) return;
    if (bid > maxAllowed) return;
    if (draftState.highBidder && draftState.highBidder.id === team.id) return;

    draftState.currentBid = bid;
    draftState.highBidder = { id: team.id, name: team.name };

    // Anti-snipe clock extension
    if (draftState.timerSeconds < timerConfig.additionalBidTime) {
      draftState.timerSeconds = timerConfig.additionalBidTime;
    }

    io.emit('bidAccepted', { draftState, isAutoBid: false });
    triggerAutodraftCheck();
  });

  socket.on('updateAutoCap', ({ playerId, maxBid }) => {
    const teamId = socketSessions.get(socket.id);
    if (!teamId) return;

    const player = players.find(p => p.id === playerId);
    if (!player) return;

    if (!player.autoCaps) player.autoCaps = {};

    const cleanBid = parseInt(maxBid, 10);
    if (isNaN(cleanBid) || cleanBid <= 0) {
      delete player.autoCaps[teamId];
    } else {
      player.autoCaps[teamId] = cleanBid;
    }

    saveStateToDisk();
    socket.emit('capSavedConfirmation', {
      playerId,
      maxBid: cleanBid > 0 ? cleanBid : null
    });
  });

  // Commissioner Guard
  function isCommishSocket() {
    const teamId = socketSessions.get(socket.id);
    const team = teams.find(t => t.id === teamId);
    return team && team.isCommish;
  }

  socket.on('adminUpdateTimers', ({ nominationTime, beginningBidTime, additionalBidTime }) => {
    if (!isCommishSocket()) return;
    timerConfig.nominationTime = parseInt(nominationTime, 10) || 45;
    timerConfig.beginningBidTime = parseInt(beginningBidTime, 10) || 45;
    timerConfig.additionalBidTime = parseInt(additionalBidTime, 10) || 10;
    io.emit('timersUpdated', { timerConfig });
  });

  socket.on('adminToggleTeamAuto', ({ targetTeamId }) => {
    if (!isCommishSocket()) return;
    const team = teams.find(t => t.id === targetTeamId);
    if (!team) return;

    team.isAuto = !team.isAuto;
    saveStateToDisk();
    io.emit('presenceUpdate', { teams: getPublicTeams() });

    if (team.isAuto && draftState.nominatedPlayer) {
      triggerAutodraftCheck();
    }
  });

  socket.on('adminTogglePause', () => {
    if (!isCommishSocket()) return;
    draftState.isPaused = !draftState.isPaused;
    io.emit('adminStateChanged', { draftState });
  });

  socket.on('adminResetCurrentBlock', () => {
    if (!isCommishSocket()) return;
    clearInterval(timerInterval);
    clearTimeout(autoBidTimeout);
    draftState.nominatedPlayer = null;
    draftState.currentBid = 0;
    draftState.highBidder = null;
    draftState.isPaused = false;
    startTimer('nomination', timerConfig.nominationTime);
    io.emit('stateUpdate', {
      draftState,
      teams: getPublicTeams(),
      players: getPublicPlayers()
    });
  });

  socket.on('adminUndoLastSale', () => {
    if (!isCommishSocket() || draftHistory.length === 0 || draftState.nominatedPlayer) return;

    const lastSale = draftHistory.pop();
    const team = teams.find(t => t.id === lastSale.teamId);
    const player = players.find(p => p.id === lastSale.playerId);

    if (team && player) {
      team.budget += lastSale.price;
      team.roster = team.roster.filter(p => p.id !== player.id);
      player.status = 'available';
      player.draftedBy = null;
      player.draftedByTeamId = null;
      player.price = 0;

      draftState.nominatingTeamId = lastSale.previousNominatorId;
      draftState.onDeckTeamId = getOnDeckNominatorId(draftState.nominatingTeamId);

      saveStateToDisk();
      startTimer('nomination', timerConfig.nominationTime);

      io.emit('saleUndone', { player, team, price: lastSale.price });
      io.emit('stateUpdate', {
        draftState,
        teams: getPublicTeams(),
        players: getPublicPlayers()
      });
    }
  });

  socket.on('adminResetAllDraftData', () => {
    if (!isCommishSocket()) return;
    clearInterval(timerInterval);
    clearTimeout(autoBidTimeout);
    draftHistory = [];

    teams.forEach(t => {
      t.budget = 200;
      t.roster = [];
    });

    players.forEach(p => {
      p.status = 'available';
      p.draftedBy = null;
      p.draftedByTeamId = null;
      p.price = 0;
    });

    draftState = {
      isDraftActive: true,
      nominatedPlayer: null,
      currentBid: 0,
      highBidder: null,
      nominatingTeamId: 1,
      onDeckTeamId: getNextNominatorId(1),
      timerSeconds: timerConfig.nominationTime,
      timerMode: 'nomination',
      isPaused: false
    };

    saveStateToDisk();
    startTimer('nomination', timerConfig.nominationTime);
    io.emit('stateUpdate', {
      draftState,
      teams: getPublicTeams(),
      players: getPublicPlayers()
    });
  });

  socket.on('disconnect', () => {
    socketSessions.delete(socket.id);
    io.emit('presenceUpdate', { teams: getPublicTeams() });
  });
});

// Start with initial nomination clock
startTimer('nomination', timerConfig.nominationTime);

server.listen(PORT, () => {
  console.log(`🚀 NBA Auction Draft Server running on http://localhost:${PORT}`);
});