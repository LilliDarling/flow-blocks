# Wildbloom

**Energy-first days for curious minds.**

Wildbloom is a daily planner that works the way a real day does — around your energy, not against the clock. Instead of stuffing tasks into rigid time slots, you stock a *pool* of things you could do, check in with how you're feeling, and the app surfaces what fits the moment. It's a planner designed for people whose brains don't run on timetables.

## The core idea

Most planners assume you'll show up to your day at 100% capacity, with the same focus at 9am as at 3pm. You won't. Wildbloom inverts the model:

- **Pool first, schedule rarely.** Tasks live in a pool by default. Only meetings, appointments, and genuinely time-bound things get pinned to a clock.
- **Energy is the primary signal.** Log how you're feeling (Low / Med / High) and the pool re-sorts to match. A push block that needs high energy stays out of the way when you're at 30%.
- **Menus, not assignments.** A block can hold a small menu of options ("write proposal *or* clean kitchen *or* workout") so you keep autonomy and novelty.
- **Track what you did, not what you planned.** The week view fills in from actual completions — it's a record, not a verdict on a missed plan.
- **Going sideways is supported.** One button moves remaining pinned blocks back to the pool. No "ruined day" framing.

The language throughout the app is intentional: invitations, never imperatives. This is a deliberate accommodation for PDA-leaning brains, and it makes the app feel quieter for everyone.

## The block types

Every block carries a *type* that describes the kind of energy it needs:

- **Push** — high effort, requires drive
- **Flow** — deep focus, sustained attention
- **Steady** — routine, predictable load
- **Growth** — journaling, learning, therapy, reflection (no deliverable, but valuable)
- **Drift** — light, low-stakes
- **Rest** — recovery
- **Buffer** — transition airlocks between pinned commitments

These types are how the app reasons about you — they're the categories the heuristic model learns over.

## Heuristic AI model design

Wildbloom's intelligence is **not an LLM**. It's a transparent, explainable heuristic engine that reads your own event stream and surfaces patterns. No model is trained across users, nothing leaves your account, and every insight comes with a visible evidence count.

### Why heuristic instead of ML

- **Explainability.** Every insight states *why* it surfaced ("12 data points"). You can audit it.
- **Cold-start friendly.** The app gives useful nudges from day three, not month three.
- **Privacy by construction.** Computation happens against your own events. There's no shared model, no telemetry, no embeddings sent anywhere.
- **Cheap and offline-capable.** Detectors run client-side over a 60-day local window of your events.

### How it works

The engine has three layers:

**1. Event stream.** Every meaningful action — completing a block, skipping it, logging energy, finishing a pomodoro — emits a typed event into an `events` table. Events are dual-written through an IndexedDB queue so the app stays offline-capable, then sync to Supabase in the background. Each event auto-captures contextual metadata: the energy level at the time, the local day-of-week, the local hour, the device. See [src/events.ts](src/events.ts).

**2. Heuristic detectors.** A small set of pure functions in [src/insights.ts](src/insights.ts) walks the event stream and looks for signal:

- `detectCompletionStreak` — consecutive days with a completion
- `detectEnergyBlockCorrelation` — for each block type, the energy tier with the highest completion rate (only surfaces when there's a meaningful delta between best and worst tier)
- `detectDowSkipPatterns` — block types that get skipped disproportionately on specific weekdays
- `detectContextualNudge` — *right now*, at your current energy level, which block types do you historically skip? Suggests something lighter

Each detector enforces a `MIN_EVIDENCE` threshold (3 data points) before surfacing anything. Insights are weighted and sorted; only the strongest two are shown on the day view, so the app never nags.

**3. Knowledge graph.** Confirmed patterns are written as edges into a `knowledge_edges` table — `(source_node) → (target_node)` with `weight` and `evidence_count`. For example: `energy:high → complete:flow` with weight 0.42 and 18 data points. This graph is the substrate for future self-adjusting behavior (auto-reordering the pool, suggesting block types when you brain-dump, etc.) — deterministic SQL aggregations now, room for statistical learning later.

### What this design buys you

- Patterns you can read in plain English, with the evidence visible
- Suggestions that respect the rest of the app's tone — *noticings, not prescriptions*
- A learning system that gets sharper as you use it without ever leaving your account
- A clear upgrade path: the same event stream and edge graph can feed a more sophisticated model later if it earns its place

## Tech stack

- **Frontend:** TypeScript, Vite, Tailwind CSS v4, vanilla DOM (no framework)
- **Backend:** Supabase (Postgres with row-level security, Auth, Edge Functions)
- **Offline-first sync:** IndexedDB queue → Supabase
- **PWA:** installable, with service worker, push notifications, and update prompts
- **Calendar integration:** Google Calendar (read-only OAuth)

## Project layout

```
src/
  app.ts          — bootstrap and view routing
  state.ts        — in-memory app state
  events.ts       — event emission + IDB queue
  insights.ts     — the heuristic engine
  pomodoro.ts     — focus timer
  energy.ts       — energy logging + analytics
  routines.ts     — recurring blocks
  calendar/       — Google Calendar sync
  ...
supabase/         — schema, migrations, edge functions
docs/             — architecture and retention notes
```

## Running locally

```bash
npm install
npm run dev
```

You'll need a Supabase project with the schema in [supabase/](supabase/) applied, plus environment variables for the Supabase URL and anon key. See [src/supabase.ts](src/supabase.ts).

## Data and privacy

Wildbloom keeps data only as long as it's useful. Recurring blocks and reminders persist with your account; one-off blocks and daily completions are auto-removed after 7 days; energy logs, done-list items, and pomodoro sessions after 30 days; the raw event log after 60 days (long enough for weekly patterns to confirm). Learned edges in `knowledge_edges` persist separately so insights don't reset when raw events expire.

All data is protected by row-level security. No analytics, no tracking cookies, no cross-user model training. See [docs/DATA_RETENTION.md](docs/DATA_RETENTION.md) for the full schedule.

## License

Wildbloom is owned by Valkyrie Remedy LLC. See the in-app Terms of Service and Privacy Policy for details.
