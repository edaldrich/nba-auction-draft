const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

const CSV_FILE = path.join(__dirname, 'Fantrax-Players-Latest.csv'); // Change to your filename
const PLAYERS_FILE = path.join(__dirname, 'players.json');

if (!fs.existsSync(CSV_FILE)) {
  console.error(`❌ CSV file not found at: ${CSV_FILE}`);
  process.exit(1);
}

// 1. Load current players.json to preserve history and caps
const existingPlayers = JSON.parse(fs.readFileSync(PLAYERS_FILE, 'utf8'));

// Build lookup maps by ID and normalized Name
const idMap = new Map();
const nameMap = new Map();

existingPlayers.forEach(p => {
  const cleanId = String(p.id).replace(/\*/g, '').trim();
  idMap.set(cleanId, p);
  nameMap.set(p.name.toLowerCase().trim(), p);
});

console.log(`Loaded ${existingPlayers.length} existing players from players.json.`);
console.log('Reading updated Fantrax CSV export...');

let updatedCount = 0;
let newPlayersCount = 0;

fs.createReadStream(CSV_FILE)
  .pipe(csv())
  .on('data', (row) => {
    const rawName = (row['Player'] || '').trim();
    if (!rawName) return;

    const rawId = (row['ID'] || '').replace(/\*/g, '').trim();
    
    // Find existing player record
    let target = idMap.get(rawId) || nameMap.get(rawName.toLowerCase());

    const newStats = {
      pts: parseFloat(row['PTS']) || 0,
      reb: parseFloat(row['REB']) || 0,
      ast: parseFloat(row['AST']) || 0,
      stl: parseFloat(row['ST']) || 0,
      blk: parseFloat(row['BLK']) || 0,
      to: parseFloat(row['TO']) || 0,
      threes: parseFloat(row['3PTM']) || 0
    };

    if (target) {
      // UPDATE fresh stats while KEEPING history, autoCaps, and draft status
      target.pos = (row['Position'] || target.pos || 'UTIL').trim();
      target.nbaTeam = (row['Team'] || target.nbaTeam || 'FA').trim();
      target.rank = parseInt(row['RkOv'], 10) || target.rank;
      target.fpts = parseFloat(row['FPts']) || target.fpts || 0;
      target.fppg = parseFloat(row['FP/G']) || target.fppg || 0;
      target.stats = newStats;
      target.fullStats = row;

      // Ensure history remains preserved
      if (!target.history) target.history = [];
      updatedCount++;
    } else {
      // New player found that wasn't in original file
      const newPlayer = {
        id: rawId || String(Date.now() + Math.random()),
        name: rawName,
        pos: (row['Position'] || 'UTIL').trim(),
        nbaTeam: (row['Team'] || 'FA').trim(),
        rank: parseInt(row['RkOv'], 10) || null,
        fpts: parseFloat(row['FPts']) || 0,
        fppg: parseFloat(row['FP/G']) || 0,
        stats: newStats,
        fullStats: row,
        history: [],
        status: 'available',
        draftedBy: null,
        draftedByTeamId: null,
        price: 0,
        autoCaps: {},
        autoRanks: {}
      };
      existingPlayers.push(newPlayer);
      newPlayersCount++;
    }
  })
  .on('end', () => {
    fs.writeFileSync(PLAYERS_FILE, JSON.stringify(existingPlayers, null, 2));
    console.log(`\n✅ Success!`);
    console.log(`- Updated fresh stats for ${updatedCount} players.`);
    console.log(`- Added ${newPlayersCount} new players.`);
    console.log(`- All career histories and manager caps preserved.`);
  })
  .on('error', (err) => {
    console.error('❌ Error reading CSV file:', err.message);
  });