import json
import time
import unicodedata
import re
import requests

PLAYERS_FILE = 'players.json'
TOP_LIMIT = 500

# Setup a browser-mimicking session
session = requests.Session()
session.headers.update({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://www.nba.com',
    'Referer': 'https://www.nba.com/',
    'Sec-Ch-Ua': '"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site'
})

def normalize_name(name):
    if not name:
        return ""
    norm = unicodedata.normalize('NFKD', name).encode('ASCII', 'ignore').decode('utf-8')
    norm = re.sub(r"['\.\-]", "", norm.lower())
    norm = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b", "", norm)
    return " ".join(norm.split())

def compute_fpts(pts, reb, ast, stl, blk, to, fgm, fga, ftm, fta, tpm, dd=0, td=0):
    fg_miss = max(0.0, fga - fgm)
    ft_miss = max(0.0, fta - ftm)
    return round(
        (pts * 0.5) + (reb * 0.7) + (ast * 0.8) + (stl * 1.0) + (blk * 1.0) -
        (to * 0.7) + (tpm * 0.3) - (fg_miss * 0.2) - (ft_miss * 0.1) +
        (dd * 2.0) + (td * 5.0),
        2
    )

def fetch_career_stats(player_id):
    url = "https://stats.nba.com/stats/playercareerstats"
    params = {
        'PerMode': 'Totals',
        'PlayerID': player_id,
        'LeagueID': '00'
    }
    resp = session.get(url, params=params, timeout=15)
    resp.raise_for_status()
    data = resp.json()
    
    # Extract Regular Season Totals (resultSets[0])
    headers = data['resultSets'][0]['headers']
    rows = data['resultSets'][0]['rowSet']
    
    return [dict(zip(headers, row)) for row in rows]

def main():
    # Warm up session to acquire Akamai cookies
    try:
        session.get("https://www.nba.com", timeout=10)
        time.sleep(1)
    except Exception:
        pass

    with open(PLAYERS_FILE, 'r', encoding='utf-8') as f:
        players_data = json.load(f)

    # Pull NBA's static player registry
    from nba_api.stats.static import players as nba_players
    all_nba = nba_players.get_players()
    nba_lookup = {normalize_name(p['full_name']): p['id'] for p in all_nba}

    # Sort players by fantasy value to target top 500
    sorted_players = sorted(
        players_data,
        key=lambda p: (float(p.get('fppg') or 0), float(p.get('fpts') or 0)),
        reverse=True
    )
    target_pool = sorted_players[:TOP_LIMIT]
    target_ids = {p['id'] for p in target_pool}

    print(f"Ingesting Top {len(target_pool)} players...")

    success = 0
    for idx, p in enumerate(players_data):
        if p['id'] not in target_ids:
            continue

        raw_name = p.get('name', '').strip()
        if p.get('history') and len(p['history']) > 0:
            success += 1
            continue

        norm_name = normalize_name(raw_name)
        nba_id = nba_lookup.get(norm_name)

        if not nba_id:
            for full_norm, pid in nba_lookup.items():
                if norm_name in full_norm or full_norm in norm_name:
                    nba_id = pid
                    break

        if not nba_id:
            continue

        rows = None
        for attempt in range(3):
            try:
                time.sleep(1.2)  # Healthy delay between requests
                rows = fetch_career_stats(nba_id)
                break
            except Exception as e:
                time.sleep(3)

        if not rows:
            print(f"[{idx+1}/{TOP_LIMIT}] Failed: {raw_name}")
            continue

        history = []
        for row in rows:
            gp = int(row.get('GP') or 0)
            if gp == 0:
                continue

            gs = int(row.get('GS') or 0)
            min_avg = round(float(row.get('MIN') or 0) / gp, 1)

            pts = round(float(row.get('PTS') or 0) / gp, 1)
            reb = round(float(row.get('REB') or 0) / gp, 1)
            ast = round(float(row.get('AST') or 0) / gp, 1)
            stl = round(float(row.get('STL') or 0) / gp, 1)
            blk = round(float(row.get('BLK') or 0) / gp, 1)
            to = round(float(row.get('TOV') or 0) / gp, 1)
            tpm = round(float(row.get('FG3M') or 0) / gp, 1)
            tpa = round(float(row.get('FG3A') or 0) / gp, 1)
            fgm = round(float(row.get('FGM') or 0) / gp, 1)
            fga = round(float(row.get('FGA') or 0) / gp, 1)
            ftm = round(float(row.get('FTM') or 0) / gp, 1)
            fta = round(float(row.get('FTA') or 0) / gp, 1)

            tot_fpts = compute_fpts(
                pts=float(row.get('PTS') or 0),
                reb=float(row.get('REB') or 0),
                ast=float(row.get('AST') or 0),
                stl=float(row.get('STL') or 0),
                blk=float(row.get('BLK') or 0),
                to=float(row.get('TOV') or 0),
                fgm=float(row.get('FGM') or 0),
                fga=float(row.get('FGA') or 0),
                ftm=float(row.get('FTM') or 0),
                fta=float(row.get('FTA') or 0),
                tpm=float(row.get('FG3M') or 0)
            )

            history.append({
                "season": row.get('SEASON_ID'),
                "team": row.get('TEAM_ABBREVIATION'),
                "fpts": tot_fpts,
                "fppg": round(tot_fpts / gp, 2),
                "gp": gp,
                "gs": gs,
                "min": min_avg,
                "fgm": fgm,
                "fga": fga,
                "fgPct": round(float(row.get('FG_PCT') or 0), 3),
                "tpm": tpm,
                "tpa": tpa,
                "tpPct": round(float(row.get('FG3_PCT') or 0), 3),
                "ftm": ftm,
                "fta": fta,
                "ftPct": round(float(row.get('FT_PCT') or 0), 3),
                "pts": pts,
                "reb": reb,
                "ast": ast,
                "stl": stl,
                "blk": blk,
                "to": to
            })

        p['history'] = history
        success += 1
        print(f"[{idx+1}/{TOP_LIMIT}] {raw_name}: {len(history)} seasons loaded")

        if success % 10 == 0:
            with open(PLAYERS_FILE, 'w', encoding='utf-8') as f:
                json.dump(players_data, f, indent=2)

    with open(PLAYERS_FILE, 'w', encoding='utf-8') as f:
        json.dump(players_data, f, indent=2)

    print(f"\nDone! Enriched {success} players.")

if __name__ == '__main__':
    main()