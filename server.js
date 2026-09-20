const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const Parser = require('rss-parser');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const rssParser = new Parser({
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const PROD_ROSTER_SIZE = 13;
const DEMO_ROSTER_SIZE = 4;

let isDemoMode = false;
let maxRosterSize = PROD_ROSTER_SIZE;

let prodTeams = JSON.parse(fs.readFileSync(path.join(__dirname, 'teams.json'), 'utf8'));
let prodPlayers = JSON.parse(fs.readFileSync(path.join(__dirname, 'players.json'), 'utf8'));

let teams = JSON.parse(JSON.stringify(prodTeams));
let players = JSON.parse(JSON.stringify(prodPlayers));

// Private nomination queues map: teamId -> [playerId1, playerId2, ...]
let nominationQueues = {};

let draftHistory = [];

let timerConfig = {
  nominationTime: 45,
  beginningBidTime: 45,
  additionalBidTime: 10
};

// RSS News and Injury Ingestion
async function fetchPlayerNews() {
  const feedUrls = [
    'https://www.espn.com/espn/rss/nba/news',
    'https://sports.yahoo.com/nba/rss.xml',
    'https://www.rotowire.com/rss/news.php?sport=nba'
  ];

  let matchesFound = 0;

  for (const url of feedUrls) {
    try {
      const feed = await rssParser.parseURL(url);
      if (!feed || !feed.items || feed.items.length === 0) continue;

      feed.items.forEach(item => {
        const title = item.title || '';
        const snippet = (item.contentSnippet || item.content || '').replace(/<[^>]+>/g, '').trim();
        const pubDate = item.pubDate ? new Date(item.pubDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'Recent';
        const combinedText = (title + ' ' + snippet).toLowerCase();

        for (let p of players) {
          if (!p.name) continue;
          const nameLower = p.name.toLowerCase();

          if (title.toLowerCase().includes(nameLower) || snippet.toLowerCase().includes(nameLower)) {
            let tag = 'UPDATE';
            if (combinedText.includes('out') || combinedText.includes('surgery') || combinedText.includes('tear') || combinedText.includes('fracture') || combinedText.includes('achilles') || combinedText.includes('sidelined')) {
              tag = 'OUT';
            } else if (combinedText.includes('questionable') || combinedText.includes('doubtful') || combinedText.includes('sprain') || combinedText.includes('strain') || combinedText.includes('injury') || combinedText.includes('day-to-day')) {
              tag = 'INJURY';
            }

            p.news = {
              tag: tag,
              headline: title,
              snippet: snippet.slice(0, 260) + (snippet.length > 260 ? '...' : ''),
              date: pubDate
            };
            matchesFound++;
          }
        }
      });

      if (matchesFound > 0) {
        console.log(`[News Feed] Updated ${matchesFound} player notes.`);
        io.emit('stateUpdate', {
          draftState,
          teams: getPublicTeams(),
          players: getPublicPlayers()
        });
        break;
      }
    } catch (err) {}
  }
}

fetchPlayerNews();
setInterval(fetchPlayerNews, 15 * 60 * 1000);

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
    const { autoCaps, autoRanks, ...publicFields } = p;
    return publicFields;
  });
}

function getTeamCapsAndRanks(teamId) {
  const caps = {};
  const ranks = {};
  players.forEach(p => {
    if (p.autoCaps && p.autoCaps[teamId] !== undefined) {
      caps[p.id] = p.autoCaps[teamId];
    }
    if (p.autoRanks && p.autoRanks[teamId] !== undefined) {
      ranks[p.id] = p.autoRanks[teamId];
    }
  });
  return { caps, ranks };
}

function isTeamEligible(team) {
  return team.roster.length < maxRosterSize;
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
  isDraftStarted: false,
  isDraftActive: true,
  nominatedPlayer: null,
  currentBid: 0,
  highBidder: null,
  nominatingTeamId: 1,
  onDeckTeamId: getNextNominatorId(1),
  timerSeconds: timerConfig.nominationTime,
  timerMode: 'nomination',
  isPaused: false,
  isDemoMode: false
};

function saveStateToDisk() {
  if (!isDemoMode) {
    fs.writeFileSync(path.join(__dirname, 'teams.json'), JSON.stringify(teams, null, 2));
    fs.writeFileSync(path.join(__dirname, 'players.json'), JSON.stringify(players, null, 2));
  }
}

let timerInterval = null;
let autoBidTimeout = null;

function startTimer(mode, duration) {
  clearInterval(timerInterval);
  if (!draftState.isDraftStarted) return;

  draftState.timerMode = mode;
  draftState.timerSeconds = duration;

  timerInterval = setInterval(() => {
    if (draftState.isPaused || !draftState.isDraftStarted) return;

    draftState.timerSeconds -= 1;
    io.emit('timerTick', { seconds: draftState.timerSeconds, mode: draftState.timerMode });

    if (draftState.timerSeconds <= 0) {
      clearInterval(timerInterval);
      clearTimeout(autoBidTimeout);

      if (draftState.timerMode === 'nomination') {
        resolveAutoNomination();
      } else {
        finalizeSale();
      }
    }
  }, 1000);
}

// Queue-aware Auto-Nomination Resolution
function resolveAutoNomination() {
  const teamId = draftState.nominatingTeamId;
  const team = teams.find(t => t.id === teamId);
  if (!team || !isTeamEligible(team)) return;

  const available = players.filter(p => p.status === 'available');
  if (available.length === 0) return;

  let selectedPlayer = null;

  // 1. Check Nomination Queue first
  const queue = nominationQueues[teamId] || [];
  for (let queuedId of queue) {
    const candidate = available.find(p => String(p.id) === String(queuedId));
    if (candidate) {
      selectedPlayer = candidate;
      // Pop from queue
      nominationQueues[teamId] = queue.filter(id => String(id) !== String(queuedId));
      break;
    }
  }

  // 2. Fallback logic if queue is empty
  if (!selectedPlayer) {
    if (team.budget > 0) {
      // Highest remaining FP/G
      available.sort((a, b) => (b.fppg || 0) - (a.fppg || 0));
      selectedPlayer = available[0];
    } else {
      // $0 budget: highest manual cap, then priority rank, then fallback to FP/G
      const cappedPlayers = available.filter(p => p.autoCaps && p.autoCaps[teamId] !== undefined);
      if (cappedPlayers.length > 0) {
        cappedPlayers.sort((a, b) => {
          const capDiff = (b.autoCaps[teamId] || 0) - (a.autoCaps[teamId] || 0);
          if (capDiff !== 0) return capDiff;
          const rankA = (a.autoRanks && a.autoRanks[teamId] !== undefined) ? a.autoRanks[teamId] : 9999;
          const rankB = (b.autoRanks && b.autoRanks[teamId] !== undefined) ? b.autoRanks[teamId] : 9999;
          return rankA - rankB;
        });
        selectedPlayer = cappedPlayers[0];
      } else {
        available.sort((a, b) => (b.fppg || 0) - (a.fppg || 0));
        selectedPlayer = available[0];
      }
    }
  }

  if (selectedPlayer) {
    const openingBid = team.budget > 0 ? 1 : 0;
    executeNomination(selectedPlayer.id, team.id, openingBid);
  }
}

function executeNomination(playerId, teamId, openingBid) {
  const player = players.find(p => p.id === playerId && p.status === 'available');
  const team = teams.find(t => t.id === teamId);

  if (!player || !team || !isTeamEligible(team)) return;

  let bid = parseInt(openingBid, 10);
  if (isNaN(bid)) bid = (team.budget > 0 ? 1 : 0);

  if (team.budget > 0 && bid < 1) bid = 1;
  if (team.budget === 0) bid = 0;
  if (bid > team.budget) bid = team.budget;

  draftState.nominatedPlayer = player;
  draftState.currentBid = bid;
  draftState.highBidder = { id: team.id, name: team.name };

  // Remove player from user's queue if present
  if (nominationQueues[teamId]) {
    nominationQueues[teamId] = nominationQueues[teamId].filter(id => String(id) !== String(player.id));
  }

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

    // Full Roster Rule: if roster hits cap, zero remaining budget
    if (winningTeam.roster.length >= maxRosterSize) {
      winningTeam.budget = 0;
    }

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

  // Check if active nominator is on auto-draft
  checkIfNominatorNeedsAutoNomination();
}

function checkIfNominatorNeedsAutoNomination() {
  if (!draftState.nominatingTeamId) return;
  const nomTeam = teams.find(t => t.id === draftState.nominatingTeamId);
  if (nomTeam && nomTeam.isAuto) {
    setTimeout(() => {
      if (!draftState.nominatedPlayer && draftState.isDraftStarted && !draftState.isPaused) {
        resolveAutoNomination();
      }
    }, 1500);
  }
}

function triggerAutodraftCheck() {
  clearTimeout(autoBidTimeout);

  autoBidTimeout = setTimeout(() => {
    if (!draftState.nominatedPlayer || draftState.isPaused || draftState.timerMode !== 'auction' || !draftState.isDraftStarted) return;

    const player = draftState.nominatedPlayer;
    const currentBid = draftState.currentBid;
    const nextBidRequired = currentBid === 0 ? 1 : currentBid + 1;

    const eligibleBots = teams.filter(t => {
      if (!t.isAuto) return false;
      if (draftState.highBidder && draftState.highBidder.id === t.id) return false;
      if (!isTeamEligible(t)) return false;
      if (t.budget < nextBidRequired) return false;

      const playerCap = player.autoCaps ? player.autoCaps[t.id] : null;
      if (playerCap === undefined || playerCap === null) return false;
      if (playerCap < nextBidRequired) return false;

      return true;
    });

    if (eligibleBots.length === 0) return;

    eligibleBots.sort((a, b) => {
      const capA = player.autoCaps[a.id];
      const capB = player.autoCaps[b.id];
      if (capB !== capA) return capB - capA;

      const rankA = (player.autoRanks && player.autoRanks[a.id] !== undefined) ? player.autoRanks[a.id] : 9999;
      const rankB = (player.autoRanks && player.autoRanks[b.id] !== undefined) ? player.autoRanks[b.id] : 9999;
      if (rankA !== rankB) return rankA - rankB;

      return Math.random() - 0.5;
    });

    const winningBot = eligibleBots[0];

    draftState.currentBid = nextBidRequired;
    draftState.highBidder = { id: winningBot.id, name: winningBot.name };

    if (draftState.timerSeconds < timerConfig.additionalBidTime) {
      draftState.timerSeconds = timerConfig.additionalBidTime;
    }

    io.emit('bidAccepted', { draftState, isAutoBid: true });
    triggerAutodraftCheck();
  }, 3000);
}

// Setup Demo Environment
function initDemoMode() {
  isDemoMode = true;
  maxRosterSize = DEMO_ROSTER_SIZE;

  teams = [
    { id: 1, name: "Commish Team", budget: 50, roster: [], isAuto: false, passcode: "commish1", isCommish: true },
    { id: 2, name: "Demo Team 2", budget: 50, roster: [], isAuto: false, passcode: "demo2", isCommish: false },
    { id: 3, name: "Demo Team 3", budget: 50, roster: [], isAuto: false, passcode: "demo3", isCommish: false },
    { id: 4, name: "Demo Team 4", budget: 50, roster: [], isAuto: false, passcode: "demo4", isCommish: false },
    { id: 5, name: "AutoBot 5", budget: 50, roster: [], isAuto: true, passcode: "none_auto5", isCommish: false },
    { id: 6, name: "AutoBot 6", budget: 50, roster: [], isAuto: true, passcode: "none_auto6", isCommish: false }
  ];

  players = JSON.parse(JSON.stringify(prodPlayers));
  players.forEach(p => {
    p.status = 'available';
    p.draftedBy = null;
    p.draftedByTeamId = null;
    p.price = 0;
    p.autoCaps = {};
    p.autoRanks = {};
  });

  // Assign random budgets respecting $50 max budget to bots 5 and 6 on top 50 players
  const top50 = [...players].sort((a, b) => (b.fppg || 0) - (a.fppg || 0)).slice(0, 50);
  [5, 6].forEach(botId => {
    let budgetAssigned = 0;
    top50.forEach((p, idx) => {
      if (budgetAssigned < 45 && Math.random() > 0.45) {
        const bid = Math.min(Math.floor(Math.random() * 15) + 2, 50 - budgetAssigned);
        if (bid > 0) {
          const target = players.find(x => x.id === p.id);
          if (target) {
            target.autoCaps[botId] = bid;
            target.autoRanks[botId] = idx + 1;
            budgetAssigned += bid;
          }
        }
      }
    });
  });

  nominationQueues = {};
  draftHistory = [];

  draftState = {
    isDraftStarted: false,
    isDraftActive: true,
    nominatedPlayer: null,
    currentBid: 0,
    highBidder: null,
    nominatingTeamId: 1,
    onDeckTeamId: 2,
    timerSeconds: timerConfig.nominationTime,
    timerMode: 'nomination',
    isPaused: false,
    isDemoMode: true
  };
}

function initProdMode() {
  isDemoMode = false;
  maxRosterSize = PROD_ROSTER_SIZE;
  teams = JSON.parse(fs.readFileSync(path.join(__dirname, 'teams.json'), 'utf8'));
  players = JSON.parse(fs.readFileSync(path.join(__dirname, 'players.json'), 'utf8'));
  nominationQueues = {};
  draftHistory = [];

  draftState = {
    isDraftStarted: false,
    isDraftActive: true,
    nominatedPlayer: null,
    currentBid: 0,
    highBidder: null,
    nominatingTeamId: 1,
    onDeckTeamId: getNextNominatorId(1),
    timerSeconds: timerConfig.nominationTime,
    timerMode: 'nomination',
    isPaused: false,
    isDemoMode: false
  };
}

io.on('connection', (socket) => {
  draftState.onDeckTeamId = getOnDeckNominatorId(draftState.nominatingTeamId);

  socket.on('authTeam', ({ passcode }) => {
    const cleanPass = (passcode || '').trim();
    const team = teams.find(t => t.passcode === cleanPass);
    if (!team) {
      socket.emit('authError', { message: 'Invalid Team Passcode' });
      return;
    }

    socketSessions.set(socket.id, team.id);

    const { caps, ranks } = getTeamCapsAndRanks(team.id);

    socket.emit('authSuccess', {
      myTeam: {
        id: team.id,
        name: team.name,
        isCommish: !!team.isCommish,
        isAuto: team.isAuto
      },
      myCaps: caps,
      myRanks: ranks,
      myQueue: nominationQueues[team.id] || [],
      timerConfig,
      teams: getPublicTeams(),
      players: getPublicPlayers(),
      draftState,
      maxRosterSize
    });

    io.emit('presenceUpdate', { teams: getPublicTeams() });
  });

  // Nomination Queue Handlers
  socket.on('updateMyQueue', ({ queue }) => {
    const teamId = socketSessions.get(socket.id);
    if (!teamId || !Array.isArray(queue)) return;
    nominationQueues[teamId] = queue;
    socket.emit('queueUpdatedConfirmation', { myQueue: queue });
  });

  socket.on('toggleMyAutoDraft', () => {
    const teamId = socketSessions.get(socket.id);
    const team = teams.find(t => t.id === teamId);
    if (!team) return;

    team.isAuto = !team.isAuto;
    saveStateToDisk();

    io.emit('presenceUpdate', { teams: getPublicTeams() });
    socket.emit('myAutoDraftChanged', { isAuto: team.isAuto });

    if (team.isAuto) {
      if (draftState.nominatedPlayer) {
        triggerAutodraftCheck();
      } else if (draftState.nominatingTeamId === team.id && draftState.isDraftStarted && !draftState.isPaused) {
        resolveAutoNomination();
      }
    }
  });

  socket.on('nominatePlayer', ({ playerId }) => {
    if (!draftState.isDraftStarted) return;
    const teamId = socketSessions.get(socket.id);
    if (!teamId || draftState.nominatedPlayer || draftState.isPaused) return;
    if (teamId !== draftState.nominatingTeamId) return;

    const team = teams.find(t => t.id === teamId);
    const openingBid = (team && team.budget > 0) ? 1 : 0;
    executeNomination(playerId, teamId, openingBid);
  });

  socket.on('placeBid', ({ bidAmount }) => {
    if (!draftState.isDraftStarted) return;
    const teamId = socketSessions.get(socket.id);
    if (!teamId || !draftState.nominatedPlayer || draftState.isPaused || draftState.timerMode !== 'auction') return;

    const team = teams.find(t => t.id === teamId);
    if (!team || !isTeamEligible(team)) return;

    const bid = parseInt(bidAmount, 10);
    if (isNaN(bid)) return;

    if (draftState.currentBid === 0 && bid < 1) return;
    if (draftState.currentBid > 0 && bid <= draftState.currentBid) return;
    if (bid > team.budget) return;
    if (draftState.highBidder && draftState.highBidder.id === team.id) return;

    draftState.currentBid = bid;
    draftState.highBidder = { id: team.id, name: team.name };

    if (draftState.timerSeconds < timerConfig.additionalBidTime) {
      draftState.timerSeconds = timerConfig.additionalBidTime;
    }

    io.emit('bidAccepted', { draftState, isAutoBid: false });
    triggerAutodraftCheck();
  });

  socket.on('updateAutoCap', ({ playerId, maxBid, rank }) => {
    const teamId = socketSessions.get(socket.id);
    if (!teamId) return;

    const player = players.find(p => p.id === playerId);
    if (!player) return;

    if (!player.autoCaps) player.autoCaps = {};
    if (!player.autoRanks) player.autoRanks = {};

    const cleanBid = parseInt(maxBid, 10);
    if (isNaN(cleanBid) || cleanBid < 0) {
      delete player.autoCaps[teamId];
    } else {
      player.autoCaps[teamId] = cleanBid;
    }

    const cleanRank = parseInt(rank, 10);
    if (isNaN(cleanRank) || cleanRank <= 0) {
      delete player.autoRanks[teamId];
    } else {
      player.autoRanks[teamId] = cleanRank;
    }

    saveStateToDisk();
    socket.emit('capSavedConfirmation', {
      playerId,
      maxBid: cleanBid >= 0 ? cleanBid : null,
      rank: cleanRank > 0 ? cleanRank : null
    });
  });

  socket.on('batchImportCaps', ({ records }) => {
    const teamId = socketSessions.get(socket.id);
    if (!teamId || !Array.isArray(records)) return;

    let updatedCount = 0;
    records.forEach(r => {
      const targetId = String(r.playerId || '').trim();
      const targetName = String(r.name || '').trim().toLowerCase();

      const player = players.find(p => (targetId && String(p.id).trim() === targetId) || (targetName && p.name.toLowerCase() === targetName));
      if (player) {
        if (!player.autoCaps) player.autoCaps = {};
        if (!player.autoRanks) player.autoRanks = {};

        if (r.maxBid !== undefined && r.maxBid !== null && r.maxBid !== '') {
          const val = parseInt(r.maxBid, 10);
          if (!isNaN(val) && val >= 0) player.autoCaps[teamId] = val;
        }

        if (r.rank !== undefined && r.rank !== null && r.rank !== '') {
          const val = parseInt(r.rank, 10);
          if (!isNaN(val) && val > 0) player.autoRanks[teamId] = val;
        }
        updatedCount++;
      }
    });

    saveStateToDisk();
    const { caps, ranks } = getTeamCapsAndRanks(teamId);
    socket.emit('batchImportSuccess', { caps, ranks, count: updatedCount });
  });

  function isCommishSocket() {
    const teamId = socketSessions.get(socket.id);
    const team = teams.find(t => t.id === teamId);
    return team && team.isCommish;
  }

  // Commissioner Demo Mode Controls
  socket.on('adminSwitchMode', ({ targetMode }) => {
    if (!isCommishSocket()) return;
    clearInterval(timerInterval);
    clearTimeout(autoBidTimeout);

    if (targetMode === 'demo') {
      initDemoMode();
    } else {
      initProdMode();
    }

    io.emit('modeSwitched', {
      isDemoMode,
      maxRosterSize,
      draftState,
      teams: getPublicTeams(),
      players: getPublicPlayers()
    });
  });

  socket.on('adminStartDraft', () => {
    if (!isCommishSocket()) return;
    draftState.isDraftStarted = true;
    startTimer('nomination', timerConfig.nominationTime);
    io.emit('draftStartedNotice', { draftState });
    io.emit('stateUpdate', {
      draftState,
      teams: getPublicTeams(),
      players: getPublicPlayers()
    });
    checkIfNominatorNeedsAutoNomination();
  });

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

    if (team.isAuto) {
      if (draftState.nominatedPlayer) {
        triggerAutodraftCheck();
      } else if (draftState.nominatingTeamId === team.id && draftState.isDraftStarted && !draftState.isPaused) {
        resolveAutoNomination();
      }
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

    const defaultBudget = isDemoMode ? 50 : 200;
    teams.forEach(t => {
      t.budget = defaultBudget;
      t.roster = [];
    });

    players.forEach(p => {
      p.status = 'available';
      p.draftedBy = null;
      p.draftedByTeamId = null;
      p.price = 0;
    });

    draftState = {
      isDraftStarted: false,
      isDraftActive: true,
      nominatedPlayer: null,
      currentBid: 0,
      highBidder: null,
      nominatingTeamId: 1,
      onDeckTeamId: getNextNominatorId(1),
      timerSeconds: timerConfig.nominationTime,
      timerMode: 'nomination',
      isPaused: false,
      isDemoMode: isDemoMode
    };

    saveStateToDisk();
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

server.listen(PORT, () => {
  console.log(`🚀 NBA Auction Draft Server running on http://localhost:${PORT}`);
});