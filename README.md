# CareerPath AI

Paste a CV and a job description. The app finds the skill gaps and builds a learning path with real, checked links.

## How the links stay real
1. Claude searches only the Saudi platforms listed in `netlify/functions/sources.js` (the `web_search` tool is limited to those domains).
2. The function keeps only URLs that the search returned AND whose domain is on that list.
3. It then opens each URL; links that are dead or not HTTPS are dropped.

## Run and deploy
1. Push this folder to GitHub, then create a Netlify site from it.
2. In Netlify: Site settings, Environment variables, add `ANTHROPIC_API_KEY`.
3. `npm test` runs the logic tests (they use a fake API, so no key is needed).

## Known limit
Search plus analysis can take longer than Netlify's default 10 s function limit. Raise the function timeout in the Netlify settings, or move to a background function in a later step.

## Saudi platforms
Edit `netlify/functions/sources.js` to add or remove platforms. Check each domain yourself; a wrong domain simply returns no links.

## Course catalog
`netlify/functions/catalog.json` holds hand-checked Saudi technical courses (status: open/exists/ended/unchecked). The model picks catalog ids; URLs always come from the file. Ended courses are hidden. Web search (Saudi domains only) is the fallback and those links are marked `source: search`. Re-check `unchecked` entries before publishing.
