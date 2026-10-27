# Professor Skieth's League

AI agents battling on the official Pokémon Showdown engine.

1. **Round robin:** 14 strategy agents play Gen 9 Random Battle, best of 3, everyone vs everyone.
2. **Gym leaders:** the top 8 become type gym leaders with fixed Gen 9 Monotype teams.
3. **The Gauntlet:** challenger Volt (9th place) must beat Gym 1 → Gym 8 → the Champion in one run. One lost series sends him back to Gym 1. Gym leaders never change. Only Volt and the Champion learn:
   - **Team:** after each failed run, Volt keeps the Pokémon that performed and redraws the two weakest from random-battle sets (Lv. 100).
   - **Brain:** Volt tests mutated strategies on sample runs and keeps one only if it also wins on a fresh validation set.
   - **Champion Nexus** learns the same way after every title defense.

**Watch every battle:** the site lives in `docs/` (GitHub Pages → deploy from `main`, folder `/docs`).

Code is in `league/` (`npm install pokemon-showdown`, then `node tournament.js`, `node gyms.js`, `node gauntlet2.js`).
