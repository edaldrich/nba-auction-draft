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

let isDemoMode = false;
let maxRosterSize = PROD_ROSTER_SIZE;

let prodTeams = JSON.parse(fs.readFileSync(path.join(__dirname, 'teams.json'), 'utf8'));
let prodPlayers = JSON.parse(fs.readFileSync(path.join(__dirname, 'players.json'), 'utf8'));

let teams = JSON.parse(JSON.stringify(prodTeams));
let players = JSON.parse(JSON.stringify(prodPlayers));

let nominationQueues = {};
let draftHistory = [];

let timerConfig = {
  nominationTime: 45,
  beginningBidTime: 45,
  additionalBidTime: 10
};

// Map storing base starting funds per team to cleanly calculate budgets
let teamBaseBudgets = {};
prodTeams.forEach(t => { teamBaseBudgets[t.id] = t.budget; });

let saveTimeout = null;
function saveStateToDisk() {
  if (isDemoMode) return;
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    fs.promises.writeFile(path.join(__dirname, 'teams.json'), JSON.stringify(teams, null, 2)).catch(err => console.error('Disk save teams error:', err));
    fs.promises.writeFile(path.join(__dirname, 'players.json'), JSON.stringify(players, null, 2)).catch(err => console.error('Disk save players error:', err));
  }, 300);
}

function recalculateTeamBudget(team) {
  const spent = team.roster.reduce((sum, p) => sum + (p.price || 0), 0);
  const base = teamBaseBudgets[team.id] !== undefined ? teamBaseBudgets[team.id] : 200;
  if (team.roster.length >= maxRosterSize) {
    team.budget = 0;
  } else {
    team.budget = Math.max(0, base - spent);
  }
}

// RSS Ingestion
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
  if (total === 0) return null;

  let currentIndex = teams.findIndex(t => t.id === currentId);
  if (currentIndex === -1) currentIndex = 0;

  for (let i = 1; i <= total; i++) {
    const candidate = teams[(currentIndex + i) % total];
    if (candidate && isTeamEligible(candidate)) {
      return candidate.id;
    }
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

function resolveAutoNomination() {
  const teamId = draftState.nominatingTeamId;
  const team = teams.find(t => t.id === teamId);
  if (!team || !isTeamEligible(team)) return;

  const available = players.filter(p => p.status === 'available');
  if (available.length === 0) return;

  let selectedPlayer = null;

  const queue = nominationQueues[teamId] || [];
  for (let queuedId of queue) {
    const candidate = available.find(p => String(p.id) === String(queuedId));
    if (candidate) {
      selectedPlayer = candidate;
      nominationQueues[teamId] = queue.filter(id => String(id) !== String(queuedId));
      break;
    }
  }

  if (!selectedPlayer) {
    if (team.budget > 0) {
      available.sort((a, b) => (b.fppg || 0) - (a.fppg || 0));
      selectedPlayer = available[0];
    } else {
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

  Object.keys(nominationQueues).forEach(tId => {
    if (Array.isArray(nominationQueues[tId])) {
      nominationQueues[tId] = nominationQueues[tId].filter(id => String(id) !== String(player.id));
    }
  });

  socketSessions.forEach((tId, sId) => {
    const s = io.sockets.sockets.get(sId);
    if (s && nominationQueues[tId]) {
      s.emit('queueUpdatedConfirmation', { myQueue: nominationQueues[tId] });
    }
  });

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

    winningTeam.roster.push({
      id: player.id,
      name: player.name,
      pos: player.pos,
      nbaTeam: player.nbaTeam,
      price: price
    });
    recalculateTeamBudget(winningTeam);

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

let bidLock = false;

function handleBidSubmission(teamId, bidAmount, isAutoBid = false) {
  if (bidLock) return false;
  bidLock = true;

  try {
    if (!draftState.isDraftStarted || !draftState.nominatedPlayer || draftState.isPaused || draftState.timerMode !== 'auction') {
      return false;
    }

    const team = teams.find(t => t.id === teamId);
    if (!team || !isTeamEligible(team)) return false;

    const bid = parseInt(bidAmount, 10);
    if (isNaN(bid)) return false;

    if (draftState.currentBid === 0 && bid < 1) return false;
    if (draftState.currentBid > 0 && bid <= draftState.currentBid) return false;
    if (bid > team.budget) return false;
    if (draftState.highBidder && draftState.highBidder.id === team.id) return false;

    draftState.currentBid = bid;
    draftState.highBidder = { id: team.id, name: team.name };

    if (draftState.timerSeconds < timerConfig.additionalBidTime) {
      draftState.timerSeconds = timerConfig.additionalBidTime;
    }

    io.emit('bidAccepted', { draftState, isAutoBid });
    return true;
  } finally {
    bidLock = false;
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
      const capA = Math.min(player.autoCaps[a.id], a.budget);
      const capB = Math.min(player.autoCaps[b.id], b.budget);
      if (capB !== capA) return capB - capA;

      const rankA = (player.autoRanks && player.autoRanks[a.id] !== undefined) ? player.autoRanks[a.id] : 9999;
      const rankB = (player.autoRanks && player.autoRanks[b.id] !== undefined) ? player.autoRanks[b.id] : 9999;
      return rankA - rankB;
    });

    const topBot = eligibleBots[0];
    const topCap = Math.min(player.autoCaps[topBot.id], topBot.budget);

    if (eligibleBots.length > 1) {
      const secondBot = eligibleBots[1];
      const secondCap = Math.min(player.autoCaps[secondBot.id], secondBot.budget);
      const escalatedBid = Math.min(topCap, secondCap + 1);

      handleBidSubmission(topBot.id, escalatedBid, true);
    } else {
      handleBidSubmission(topBot.id, nextBidRequired, true);
    }

    triggerAutodraftCheck();
  }, 1200);
}

// Configurable Dynamic Demo Initializer
function initDynamicDemoMode({ selectedTeamIds, demoBudget, demoRosterLimit, botTeamIds }) {
  isDemoMode = true;
  maxRosterSize = parseInt(demoRosterLimit, 10) || 4;
  const budget = parseInt(demoBudget, 10) || 50;

  // Filter and configure selected teams
  teams = prodTeams
    .filter(t => selectedTeamIds.includes(t.id))
    .map(t => {
      const isBot = botTeamIds.includes(t.id);
      return {
        id: t.id,
        name: t.name,
        budget: budget,
        roster: [],
        isAuto: isBot,
        passcode: t.passcode,
        isCommish: !!t.isCommish
      };
    });

  // Re-map base budgets
  teamBaseBudgets = {};
  teams.forEach(t => { teamBaseBudgets[t.id] = budget; });

  // Fresh player clone without production caps or ranks
  players = JSON.parse(JSON.stringify(prodPlayers));
  players.forEach(p => {
    p.status = 'available';
    p.draftedBy = null;
    p.draftedByTeamId = null;
    p.price = 0;
    p.autoCaps = {};
    p.autoRanks = {};
  });

  // Tiered Autodraft Bot Bids (Top 10: $10-$20, Top 11-30: $0-$10)
  const top30 = [...players].sort((a, b) => (b.fppg || 0) - (a.fppg || 0)).slice(0, 30);
  const top10 = top30.slice(0, 10);
  const next20 = top30.slice(10, 30);

  botTeamIds.forEach(botId => {
    // Top 10 ($10 - $20)
    top10.forEach((p, idx) => {
      const target = players.find(x => x.id === p.id);
      if (target) {
        const randBid = Math.floor(Math.random() * 11) + 10; // $10 to $20
        target.autoCaps[botId] = Math.min(randBid, budget);
        target.autoRanks[botId] = idx + 1;
      }
    });

    // Top 11-30 ($0 - $10)
    next20.forEach((p, idx) => {
      const target = players.find(x => x.id === p.id);
      if (target) {
        const randBid = Math.floor(Math.random() * 11); // $0 to $10
        target.autoCaps[botId] = randBid;
        target.autoRanks[botId] = 10 + idx + 1;
      }
    });
  });

  nominationQueues = {};
  draftHistory = [];

  const firstTeamId = teams[0]?.id || 1;
  draftState = {
    isDraftStarted: false,
    isDraftActive: true,
    nominatedPlayer: null,
    currentBid: 0,
    highBidder: null,
    nominatingTeamId: firstTeamId,
    onDeckTeamId: getNextNominatorId(firstTeamId),
    timerSeconds: timerConfig.nominationTime,
    timerMode: 'nomination',
    isPaused: false,
    isDemoMode: true
  };
}

function initProdMode() {
  isDemoMode = false;
  maxRosterSize = PROD_ROSTER_SIZE;

  // Restore production teams and budgets
  prodTeams = JSON.parse(fs.readFileSync(path.join(__dirname, 'teams.json'), 'utf8'));
  teams = JSON.parse(JSON.stringify(prodTeams));
  teamBaseBudgets = {};
  teams.forEach(t => { teamBaseBudgets[t.id] = t.budget; });

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
      allLeagueTeams: prodTeams.map(t => ({ id: t.id, name: t.name })),
      draftState,
      maxRosterSize
    });

    io.emit('presenceUpdate', { teams: getPublicTeams() });
  });

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
    const teamId = socketSessions.get(socket.id);
    if (!teamId) return;
    handleBidSubmission(teamId, bidAmount, false);
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

  // Configurable Demo Mode Trigger
  socket.on('adminSwitchConfiguredDemo', (config) => {
    if (!isCommishSocket()) return;
    clearInterval(timerInterval);
    clearTimeout(autoBidTimeout);

    initDynamicDemoMode(config);

    io.emit('modeSwitched', {
      isDemoMode,
      maxRosterSize,
      draftState,
      teams: getPublicTeams(),
      players: getPublicPlayers()
    });
  });

  socket.on('adminSwitchProd', () => {
    if (!isCommishSocket()) return;
    clearInterval(timerInterval);
    clearTimeout(autoBidTimeout);

    initProdMode();

    io.emit('modeSwitched', {
      isDemoMode,
      maxRosterSize,
      draftState,
      teams: getPublicTeams(),
      players: getPublicPlayers()
    });
  });

  socket.on('adminOverrideBudget', ({ targetTeamId, newBudget }) => {
    if (!isCommishSocket()) return;
    const team = teams.find(t => t.id === targetTeamId);
    if (!team) return;

    const b = parseInt(newBudget, 10);
    if (!isNaN(b) && b >= 0) {
      team.budget = b;
      teamBaseBudgets[team.id] = b;
      saveStateToDisk();
      io.emit('stateUpdate', {
        draftState,
        teams: getPublicTeams(),
        players: getPublicPlayers()
      });
    }
  });

  socket.on('adminOverrideTransferSale', ({ playerId, targetTeamId, newPrice }) => {
    if (!isCommishSocket()) return;
    const player = players.find(p => p.id === playerId);
    const newTeam = teams.find(t => t.id === targetTeamId);
    if (!player || !newTeam || player.status !== 'drafted') return;

    const oldTeam = teams.find(t => t.id === player.draftedByTeamId);
    const cleanPrice = parseInt(newPrice, 10);
    if (isNaN(cleanPrice) || cleanPrice < 0) return;

    if (oldTeam) {
      oldTeam.roster = oldTeam.roster.filter(p => p.id !== player.id);
      recalculateTeamBudget(oldTeam);
    }

    newTeam.roster.push({
      id: player.id,
      name: player.name,
      pos: player.pos,
      nbaTeam: player.nbaTeam,
      price: cleanPrice
    });
    recalculateTeamBudget(newTeam);

    player.draftedBy = newTeam.name;
    player.draftedByTeamId = newTeam.id;
    player.price = cleanPrice;

    saveStateToDisk();
    io.emit('stateUpdate', {
      draftState,
      teams: getPublicTeams(),
      players: getPublicPlayers()
    });
  });

  socket.on('adminReleasePlayerToPool', ({ playerId }) => {
    if (!isCommishSocket()) return;
    const player = players.find(p => p.id === playerId);
    if (!player || player.status !== 'drafted') return;

    const oldTeam = teams.find(t => t.id === player.draftedByTeamId);
    if (oldTeam) {
      oldTeam.roster = oldTeam.roster.filter(p => p.id !== player.id);
      recalculateTeamBudget(oldTeam);
    }

    player.status = 'available';
    player.draftedBy = null;
    player.draftedByTeamId = null;
    player.price = 0;

    saveStateToDisk();
    io.emit('stateUpdate', {
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
      team.roster = team.roster.filter(p => p.id !== player.id);
      recalculateTeamBudget(team);

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
      const base = teamBaseBudgets[t.id] !== undefined ? teamBaseBudgets[t.id] : 200;
      t.budget = base;
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
      nominatingTeamId: teams[0]?.id || 1,
      onDeckTeamId: getNextNominatorId(teams[0]?.id || 1),
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