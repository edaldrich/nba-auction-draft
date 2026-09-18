const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

const csvFilePath = path.join(__dirname, 'Fantrax-Players-The Drew Sykes Memorial League.csv');
const jsonFilePath = path.join(__dirname, 'players.json');

const parsedPlayers = [];

console.log('Reading Fantrax CSV export...');

fs.createReadStream(csvFilePath)
  .pipe(csv())
  .on('data', (row) => {
    const name = (row['Player'] || '').trim();
    if (!name) return;

    parsedPlayers.push({
      id: (row['ID'] || '').replace(/\*/g, '').trim() || String(Date.now() + Math.random()),
      name: name,
      pos: (row['Position'] || 'UTIL').trim(),
      nbaTeam: (row['Team'] || 'FA').trim(),
      rank: parseInt(row['RkOv'], 10) || null,
      fpts: parseFloat(row['FPts']) || 0,
      fppg: parseFloat(row['FP/G']) || 0,
      stats: {
        pts: parseFloat(row['PTS']) || 0,
        reb: parseFloat(row['REB']) || 0,
        ast: parseFloat(row['AST']) || 0,
        stl: parseFloat(row['ST']) || 0,
        blk: parseFloat(row['BLK']) || 0,
        to: parseFloat(row['TO']) || 0,
        threes: parseFloat(row['3PTM']) || 0
      },
      status: 'available',
      draftedBy: null,
      price: 0,
      autoCaps: {}
    });
  })
  .on('end', () => {
    fs.writeFileSync(jsonFilePath, JSON.stringify(parsedPlayers, null, 2));
    console.log(`✅ Success! Imported ${parsedPlayers.length} players from Fantrax into players.json.`);
  })
  .on('error', (err) => {
    console.error('❌ Error reading CSV file:', err.message);
  });