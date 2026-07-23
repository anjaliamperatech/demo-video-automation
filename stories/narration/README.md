# Narration audio for `stories/ai-brand-rank-visibility.json`

You don't have to record anything by hand. If `AZURE_OPENAI_TTS_DEPLOYMENT`
is set in `.env`, the tool auto-generates a clip for any scene listed below
that doesn't already have a file here, right during the run, and saves it
to this folder so it's only generated once — later runs reuse the cached
file instead of re-synthesizing it. See `.env.example` for the TTS env vars.

If you'd rather use a real human voice for a given scene, just record it
yourself (a phone voice memo works fine) and drop it in this folder using
the exact filename listed below — an existing file always takes priority
over auto-generation. The tool times each clip to when its scene starts
automatically — you don't need to hand-sync anything.

| File | Narration text |
| --- | --- |
| `landing.mp3` | This is BrandRank AI, a platform that tracks how visible your brand is across AI engines like ChatGPT, Gemini, and Perplexity, alongside traditional Google search. It brings your organic search performance and your AI-search presence into one dashboard, so you can see the full picture of how people discover your brand today. |
| `login.mp3` | We sign in to get to the dashboard, where all of the brand's tracked data lives. |
| `gap-mapping.mp3` | First, Phase 1: Gap Mapping shows where our brand is missing from the conversation compared to competitors. Every gap is clustered by topic and scored by opportunity, so the team can see at a glance which conversations are worth chasing first and how big a win each one represents. |
| `seo-visibility.mp3` | Switching over to SEO Visibility, we can see our organic search rankings across the tracked keyword set. This view tracks where each keyword ranks over time, so the team can spot rankings that are climbing, slipping, or stuck, and prioritize accordingly. |
| `seo-traffic.mp3` | SEO Traffic Data pulls in the real Google Search Console numbers behind those rankings, showing actual clicks, impressions, and click-through rate for every tracked page, so the team can connect ranking movement to real visitor traffic. |
| `ai-visibility.mp3` | And here's AI Visibility, showing how often and how favorably the brand shows up in AI engine responses. It breaks down mentions by engine, so the team can see exactly where the brand is being cited, recommended, or left out entirely across ChatGPT, Gemini, and Perplexity. |
| `content-gen.mp3` | This is the heart of the platform: Phase 2 Content Gen turns those keyword gaps into SEO- and AEO-optimized content briefs, ready to close the gap with competitors. Each brief is generated directly from the opportunity data we just looked at, so nothing has to be researched from scratch. |
| `generate-content.mp3` | This page lists priority keyword gaps, each with a checkbox next to its name. Check the checkbox next to exactly one keyword gap in the list to select it, then click the button below the list that generates content for the selected keyword. Wait for the View Package button to appear, which means the content brief is ready. |
| `view-package.mp3` | The generated content brief is ready. Opening View Package shows the finished piece, and downloading it as HTML gives us the final, ready-to-publish output. |

If neither a recorded file nor TTS credentials are available, a scene just
falls back to caption-only (no audio) — the run won't fail. In that
caption-only case, on-screen time is driven by the narration text length
and each scene's `pauseAfterMs`, both of which were bumped up to give
viewers time to read the fuller descriptions and watch each page scroll to
the bottom.

The video now ends on the `view-package` scene, which clicks **View
Package**, then **Download HTML**, saves the downloaded file into the run's
output folder, and opens it in the browser as the very last thing shown in
the video — that downloaded HTML file is the actual final output of the
demo, not just a screenshot of the app.
