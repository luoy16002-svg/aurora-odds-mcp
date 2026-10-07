# Aurora Odds MCP

An MCP server that answers one question out loud: **are the northern lights worth going outside for, here, now?** (Or tonight, or in the south.)

Space-weather alerts say things like "G2 watch, Kp 6 expected". That doesn't tell someone in Edinburgh whether to put their shoes on. Aurora Odds turns the solar wind already on its way to Earth into a sentence a voice assistant can read as it is:

> **"Can I see the northern lights in Edinburgh right now?"**
>
> "Yes, go outside now. There's about a 95 percent chance the northern lights are bright enough to see with your eyes in Edinburgh over the next hour. Look north and straight up: at this level the aurora can spread across the whole sky."
>
> *(the answer for 10 May 2024 at 11 pm, from the replay endpoint below)*

- **Try it:** https://aurora-odds-mcp.pages.dev. Speak or type a question; a language model picks the tool, the MCP server answers, and the page reads the answer aloud.
- **Endpoint:** `https://aurora-odds-mcp.pages.dev/mcp`. Streamable HTTP, MCP spec `2025-11-25`, stateless, no key.
- **Replay:** `https://aurora-odds-mcp.pages.dev/replay/may2024/mcp` serves the same tools on the night of the May 2024 superstorm, with the forecast the model made at 22:00 UTC and the clock stopped there. The page does the same at https://aurora-odds-mcp.pages.dev/?replay=may2024, so you can hear a "go outside" answer on a quiet night.
- **Built for:** Alexa+ and any other MCP client.

## Tools

| Tool | The question it answers | What comes back |
| --- | --- | --- |
| `check_aurora_now` | "Can I see the aurora right now?" | Chance it's bright enough for your eyes and for a phone camera in the next hour, whether it's dark, cloud cover, and which way and how high to look |
| `plan_aurora_tonight` | "When should I go out tonight?" | Hour by hour until dawn: darkness, expected activity, cloud, and the best window |
| `explain_space_weather` | "What is the Sun doing?" | Solar wind speed and magnetic field, chance of a storm in the next hour, and the peak of NOAA's three-day outlook |

The two place tools take `place` ("Tromsø", "Fairbanks, Alaska", "Hobart, Australia") or `latitude` and `longitude` when the device knows where it is. All three are read-only (`readOnlyHint: true`).

Every result has two parts:

- `content[0].text`, the `speech` string. It is written for the ear: the verdict comes first, chances are rounded to 5 percent, times are local ("9:40 pm"), heights are given in fists at arm's length, and there is one thing to do.
- `structuredContent`, the numbers behind the sentence, matching each tool's declared `outputSchema`: probabilities, the Kp needed, sun altitude, cloud cover, the compass bearing, the hourly plan.

When the server can't answer, it still returns a sentence (`isError: true`), for example "I couldn't find a place called Nowhereville. Try the nearest town, or add the country."

Resources: `aurora://nowcast/latest` (the raw forecast JSON) and `aurora://method` (how an answer is made, in Markdown).

## Connect a client

Any client that speaks Streamable HTTP:

```json
{
  "mcpServers": {
    "aurora-odds": { "type": "http", "url": "https://aurora-odds-mcp.pages.dev/mcp" }
  }
}
```

To look around with the MCP Inspector:

```sh
npx @modelcontextprotocol/inspector
# Transport: Streamable HTTP, URL: https://aurora-odds-mcp.pages.dev/mcp
```

The server's `instructions` tell the model which tool fits which question and ask it to read `speech` unchanged, so an assistant doesn't paraphrase "a 5 percent chance" into "a good chance".

## The voice demo, a stand-in for Alexa+

Alexa+ decides which MCP tool to call with its own language model. The demo page does the same thing so the whole loop can be tried without a device:

```
you speak ──► browser speech recognition ──► POST /assistant
  ──► Llama 3.3 70B on Cloudflare Workers AI reads your words and the tools from tools/list
  ──► picks one tool and its arguments
  ──► the host calls that tool over MCP (Streamable HTTP, the same /mcp endpoint any client uses)
  ──► the tool's speech is read aloud by the browser
```

The model chooses; it never talks about the sky itself. `src/assistant.ts` holds it to that:

- What you hear is the tool's `speech`. If the model answers without a tool, only a short clarifying question gets through; anything else becomes a fixed "I can help with the northern and southern lights" line.
- A place must be one you said. In testing, Llama sometimes filled in "unknown" (a geocoder then found a village called Unknown) or a town of its own choosing. Those are dropped, and the device location is used instead, or the server asks which town you mean.
- If the model is busy or the free quota is used up, the page falls back to keyword matching and calls `/mcp` straight from the browser.

`test/assistant-eval.ts` asks a deployment twelve spoken questions and checks the tool, the place, the question back when no place is known, and the refusal for off-topic questions. On 7 October 2026 both Llama 3.3 70B and Llama 4 Scout passed 11 of 12. Llama 3.3 answered "What's the weather like in Paris?" with the aurora odds for Paris, and in another run it handled that question but invented a town for "Can I see the aurora tonight?", which the place check now catches. Llama 4 Scout ignored a shared device location. The demo uses Llama 3.3, because a voice assistant usually knows where it is.

## Run it yourself

Node 22.18 or later (the source is TypeScript that Node runs directly).

```sh
npm install
npm test           # 20 tests: MCP over an in-memory client, and the voice host over Streamable HTTP, with recorded data
npm run dev        # http://localhost:8787 (page) and http://localhost:8787/mcp (endpoint); no model here, so the page uses keywords
node test/live-smoke.ts                                   # asks the local server five real questions
MCP_URL=https://aurora-odds-mcp.pages.dev/mcp node test/live-smoke.ts   # or the deployed one
```

Deploy to Cloudflare Pages (free plan is plenty):

```sh
npm run build                                        # bundles src/worker.ts into site/_worker.js
npx wrangler pages deploy site --project-name <your-project>
npx wrangler pages dev site                          # local run with the Workers AI binding from wrangler.toml
node test/assistant-eval.ts https://<your-project>.pages.dev
```

`src/worker.ts` is a plain `fetch` handler, so the same code runs on Cloudflare (Pages or Workers), Deno, Bun, or Node through `src/dev.ts`.

## How an answer is made

1. **The wind on its way.** Spacecraft at the L1 point measure the solar wind 30 to 60 minutes before it reaches Earth. NOAA publishes the readings every minute.
2. **A forecast.** [Aurora Odds](https://github.com/luoy16002-svg/aurora-odds) runs TabPFN, an open-weights foundation model for tables, on that wind every ten minutes and publishes the probability that the next hour's Hp30 index reaches each level. On 2023 to 2026, years it never saw in training, it beats a tuned LightGBM on strong storms (Brier skill 0.58 against 0.46 at Hp30 ≥ 7). Later hours tonight come from NOAA SWPC's three-day Kp forecast.
3. **Your sky.** [aurora-sky](https://github.com/luoy16002-svg/aurora-sky), a small open-source library written for this project, does the geometry: corrected (AACGM-v2) magnetic latitude, how far south the oval reaches at each Kp, how much further the glow is visible to eyes and to cameras, how high the arc stands above your horizon, and when the Sun is 12 degrees down. Open-Meteo supplies place search and hourly cloud cover.
4. **One sentence.** `src/report.ts` turns those numbers into a verdict (`go_outside`, `worth_a_look`, `bring_your_phone`, `maybe_later`, `stay_in`, `too_light`, `too_cloudy`) and the sentence to say.

Upstream calls time out after 6 seconds and retry once; results are cached per isolate (2 minutes for the forecast, 20 for clouds, 24 hours for places). Clouds are optional: if Open-Meteo is down, the answer drops the cloud clause.

## Layout

```
src/
  server.ts    MCP server: tools, schemas, resources, instructions
  assistant.ts the voice host: a model picks the tool, an MCP client calls it
  report.ts    numbers -> verdict -> speech
  sources.ts   forecast, NOAA Kp, Open-Meteo, with timeouts, retry and cache
  worker.ts    Streamable HTTP endpoints (stateless, JSON responses, CORS), /assistant, /health, static page
  replay.ts    recorded nights for /replay/<name>/mcp (src/replays/may-2024.json)
  dev.ts       local server on Node
site/          the demo page (index.html) and the built worker
test/          MCP and assistant tests with fixtures (the May 2024 superstorm, a quiet October day), a live smoke
               test and the assistant eval
```

## Built during the hackathon

This server, its demo page and the aurora-sky library were written in October 2026 for the Amazon Developer Hackathon. The forecast feed it reads comes from Aurora Odds, my open-source aurora nowcast, also started this month.

## Data

NOAA SWPC real-time solar wind and three-day Kp forecast, GFZ Potsdam Hp30 index (model training), NASA OMNI (model training), Open-Meteo geocoding and forecast. Not affiliated with Amazon, NOAA or GFZ.

## License

MIT, see [LICENSE](LICENSE).
