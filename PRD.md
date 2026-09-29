# PRD: PaPadel — Simple Padel App with Weekly Practice Scoring

## 1. Background
Need for a simple app to record padel practice scores on a weekly basis and accumulate results over time, so players can track their performance progress continuously.

## 2. Goals
- Make it easy to record scores for each weekly padel practice session.
- Accumulate results across multiple sessions into a single performance summary.
- Show performance trends (up/down) for players from week to week.

## 3. Target Users
Individuals or small groups who practice padel regularly on a weekly basis (e.g. an office community).
Not intended for official tournaments — focused on casual/regular practice.

## 4. Scope (MVP)

### 4.1 Core Features
Practice Session Input
- Session date
- Session duration (default 2 hours)
- List of participating players (can be added/removed while the session is in progress)

Scoring — Americano Format
- Americano format: partners rotate every round/game, so each player ends up playing with/against almost every other participant in a session.
- Total points per match fixed at 21 points, split between the two teams based on the result (e.g. 6-15, 11-10, 1-20, etc.).
- Individual points = accumulation of the team's points across every game the player takes part in (not a binary win/lose, but the actual points earned).
- The system auto-generates the pairing/opponent schedule per round, minimizing repeated partner/opponent combinations.

Rolling / Automatic Rotation System
- Only 1 court available, so only one match runs at a time (4 active players, the rest waiting for their turn).
- Ensures every participant gets an equal amount of playing time within the total session duration (2 hours), even with only 1 court — the more participants, the more frequent the rotation.
- When a participant joins mid-session: the system recalculates the remaining time & rotation so the new participant still gets a fair share of playtime from the remaining duration.
- When a participant leaves (drops out/injured/leaves early): the system re-arranges the upcoming rounds so the remaining participants still get balanced partner/opponent rotation without an uneven player count on the court.
- A "playtime share" indicator per participant (e.g. in minutes or number of games) to show who has/hasn't gotten a fair turn yet.

Live & Cumulative Leaderboard
- The leaderboard doesn't need to wait for the session to end — the latest results (scores entered so far in the ongoing session) show up in real time.
- There are 2 types of leaderboard:
  - Cumulative Leaderboard — total player points across all sessions/weeks.
  - Per-Session Leaderboard — filterable/selectable by a specific session date, showing rankings just for that session.
- Weekly history can be revisited (drill down from total to individual sessions)

Session History Module
- Select a session by play date (list/calendar of past sessions).
- Shows the details of the selected session: every match (round, team A vs team B pairing) along with its score.
- Admin can edit match/score data for a past session directly from this module (regular participants only get read-only access).
- Edits made here automatically trigger a recalculation of the related cumulative and per-session leaderboards.

History & Trends
- Simple chart of a player's point progression per week
- Basic stats: number of sessions attended, average points per session, wins/losses

Admin Authority
- Admin has full authority to edit and delete any data: sessions, round schedules, scores/matches, and player data.
- Any edit/deletion by the admin automatically triggers a recalculation of related accumulations & stats to keep everything consistent.

### 4.2 Out of Scope (Initial Version)
- Official tournament/bracket management
- Payment/court booking integration
- Multi-sport support
- Complex social login (simple authentication, or even no login at all for the earliest version — as needed)

## 5. User Flow
Admin/player creates a new practice session → fills in date, duration (default 2 hours), available courts, and initial participants.
The system generates the initial round schedule (pairings & opponents) based on the Americano format + rolling allocation to keep playtime even.
During the session:
- Admin inputs the score for each completed game/round.
- If a new participant joins → the system recalculates the remaining schedule & rotation so the new participant still gets a fair share of playtime from the time left.
- If a participant leaves → the system rearranges the upcoming rounds to match the remaining number of players.
The system automatically calculates each player's session score (accumulated Americano points from all games played) — the live leaderboard (both per-session and cumulative) updates instantly as new scores come in, without waiting for the session to end.
The session score is added to each player's running total.
Players can open the leaderboard (cumulative or per-session by date) to see their progress, including the playtime history for each session.
At any time, players/admin can open Session History, pick a specific session date, and view the details of every match & score; admin can edit data directly from there if corrections are needed.

## 6. Data Model (Simple)
- Player: id, name
- Session: id, date, duration_minutes, list of participating player_ids (can change during the session) — number_of_courts fixed at 1
- Round: id, session_id, round_number, start_time, end_time
- Match: id, round_id, team_a (2 player_ids), team_b (2 player_ids), score_team_a, score_team_b (total always 21)
- PlayerSessionLog: player_id, session_id, total_minutes_played, games_played, total_session_points (used to keep rolling fair and as the basis for accumulation)
- PlayerStats (derived/aggregated across sessions): player_id, total_points, sessions_played, avg_points, avg_minutes_played

## 7. Success Metrics
- Practice sessions are logged consistently every week without input friction.
- Leaderboards (live, cumulative, and per-session) accurately reflect data and stay consistent with session history.
- Admin can correct past session data via Session History without breaking accumulation consistency.
- Users can see their own performance trend over time.

## 8. Technical Considerations
- Frontend: Next.js (App Router) + TypeScript, with Tailwind CSS + shadcn/ui for polished, responsive UI components (desktop & mobile), inspired by Playpass's UI/UX.
- Additional styling/UX: Framer Motion (optional) for smooth transitions on the leaderboard/scoring screens.
- Backend & Database: Supabase (Postgres) — using the Supabase JS Client for data access, Supabase Auth for admin login, and Supabase Realtime so score/rotation updates appear instantly for all participants without a manual refresh.
- Data security: Row Level Security (RLS) in Supabase to enforce admin authority (edit/delete) vs. read-only access for regular participants.
- State & Data Fetching: React Query (TanStack Query) for syncing & caching data from Supabase; Zustand for local state handling the rotation/rolling logic.
- Forms & Validation: React Hook Form + Zod for session/score input.
- Visualization: Recharts for weekly point-trend charts per player.
- Deployment: Vercel (a natural fit with Next.js).

## 9. Rough Roadmap
- V1 (MVP): Manual session input, score calculation, accumulated leaderboard.
- V2: Trend charts, advanced stats (win rate, best partner, etc.).
- V3: Multi-group/community support, data export, possible court-booking integration.
