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
      fullStats: row, // Stores all raw columns for modal display
      status: 'available',
      draftedBy: null,
      draftedByTeamId: null,
      price: 0,
      autoCaps: {}
    });
  })
  .on('end', () => {
    fs.writeFileSync(jsonFilePath, JSON.stringify(parsedPlayers, null, 2));
    console.log(`✅ Success! Imported ${parsedPlayers.length} players with full stat sheets.`);
  })
  .on('error', (err) => {
    console.error('❌ Error reading CSV file:', err.message);
  });