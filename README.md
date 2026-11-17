# Dutch words

A small web app (installable on Android from Chrome) for the Dutch word list in the private
`learning-progress` repo.

- **Home and Sort words**: the Home tab has one orange bar, "Sort your words", that fills as you rate words and
  shows `rated / total · N left`. Tap it and the sorting sheet slides up: one word at a time, tap how well you
  know it on one row of five buttons, 0 to 4 (pale to bright orange). The meaning stays hidden until you tap
  "Show meaning" (or press space). Keys 0 to 4 also work, Backspace undoes. Level 5 ("Never need to practise
  again") is off by default; switch it on under "More options" in the sheet. That menu also has the re-check
  modes. Your rating is saved into your own progress file (`dutch/noah.csv` or `dutch/anna.csv`), changing only
  the lines of the words you rated.
- **Add a word**: type a Dutch word and its meaning (or ask Wiktionary for a suggestion). "Send" appends it
  to `dutch/inbox.csv`. A later tool merges inbox words into the word list and both progress files.

- **Flag issue** (button on each word while sorting): reports a wrong meaning, a swapped word, a typo or something else. Appended to `dutch/issues.csv` (`dutch,english,type,note,who,date`). The word list is not changed by the app.
- **Ideas** tab: a box to pitch an idea for the app. Appended to `dutch/ideas.csv` (`date,who,idea`).

- **Add a person** (Settings): type a first name and tap Create. The app makes `dutch/<name>.csv` with every word set to `unknown`, in the same order as the other progress files. The Who list is read from the `dutch/` folder (names `inbox`, `issues`, `ideas`, `people`, `readme`, `vocab` are reserved). Everyone with an access key can see and change everyone's data.

Flags, ideas and typed words are sent straight away; if the phone is offline they stay on the phone and go out at the next save.

No word list or personal data is stored in this repo, only the app. The data is fetched with a GitHub
token that you paste into the app on your phone (Settings).
(Version 1 had a photo scanner using Tesseract.js; it was removed on 16 Nov 2026. It is in the Git history.)

## The levels and how they are saved
Saved with the statuses the Cobra phone already understands, so Imke reacts straight away.

| Tap | Name | `status` | `streak` | `next_due` |
|---|---|---|---|---|
| 0 | Never seen it | `unknown` | 0 | rating date (marks "rated 0") |
| 1 | Vaguely recognise it | `needs_practice` | 0 | today |
| 2 | Recognised | `learning` | 1 | +2 days |
| 3 | Familiar | `learning` | 2 | +7 days |
| 4 | Learned | `known` | 3 | +60 days |
| 5 | Never need to practise again | `known` | 5 | +365 days |

`right`, `wrong`, `last_practised` and `pronunciation` are never changed. A word counts as not rated
yet if it is `unknown` with an empty `next_due`. Imke's later answers use her normal rules and replace the
rating. When the app reads a row back it guesses the level from `status`, `streak` and `next_due`
(4 versus 5 is told apart by a due date more than 200 days away).

## Games (Play and Board tabs)
Points only come from multiple-choice questions that the app marks itself (never from the 0-5 self-rating, which anyone could just tap).
- **Quick round**: 10 questions (Dutch word, pick the English). Words you got wrong come first, then words that are due, then words you rated 0, then new A1/A2 words. Right answers update the person's progress file by the Cobra phone's rules (`right`, `wrong`, `streak`, `status`, `last_practised`, `next_due`); a right answer never brings a due date closer, so a word rated 5 stays at 5.
- **Points**: right answer = 15 / 12 / 10 / 8 / 6 / 5 for a word at level 0 / 1 / 2 / 3 / 4 / 5, +5 if answered within 3 s, +2 within 6 s. Perfect round +20. First round of the day: +3 per day of the daily streak (max 10 days). Wrong = 0.
- **Word of the week**: one easy word (A1/A2), the same for everyone, changes every Monday. First question of your next round until you get it right: +30, once a week.
- **Verb drill** (own card on the Play tab): the irregular verbs, `type` `verb-drill` in the word list (one row per verb: `to eat — past: ik at, we aten; perfect: ik heb gegeten`). 10 questions: the infinitive and four possible past tenses or perfects. Drill rows are kept out of Sort, quick rounds and battles. Answers update the progress row like any quiz answer; the score row says `mode` `drill`.
- **Board**: this week's ranking (Monday to Sunday), last week's winner, all-time points, battle wins.
- **Battles (asynchronous)**: you play 10 questions now; the other person plays the exact same questions (the questions and the order of the options are stored in the challenge) whenever they like. Flat scoring (10 per right answer + speed bonus, no other bonuses). Higher score wins; a tie is decided by right answers, then it is a draw.
- **Handicap battle**: only words that neither person knows yet (level 0 or not rated, for both), easiest (A1) first.
- Your points are worked out on your own phone and anyone with an access key can edit the files, so this is for friends, not for strangers.

### scores.csv and battles.csv (append-only, never touched by the Cobra phone)
`dutch/scores.csv`: `id,date,who,mode,points,right,total,wotw` (`mode` = practice / battle / handicap; `wotw` = 1 if the word of the week was answered right in that round).
`dutch/battles.csv`: `id,type,date,who,opponent,mode,score,right,total,questions`. `type` = `challenge` (the first player, with the 10 questions as JSON in `questions`) or `reply` (the opponent, same `id`). Only a reply from the named opponent counts, and only the first one.

## Files
| File | What it does |
|---|---|
| `index.html`, `style.css`, `app.js` | The screens |
| `triage.js` | The rating rules, the line-by-line saving into the progress file, and the order words come in |
| `game.js` | The game rules: points, streaks, weeks, word of the week, question making, handicap picks, leaderboard, battle results |
| `matcher.js` | Reads CSV, and spots forms of words you know (for "Add a word") |
| `sw.js`, `manifest.webmanifest`, `icons/` | Lets Chrome install it and open it offline |
| `tests/` | `node tests/test_matcher.js [vocab.csv]`, `node tests/test_triage.js [dutch folder]`, `node tests/test_game.js [dutch folder]`, `tests/test_browser.js` (whole app in headless Chrome with a fake GitHub) |

## Saving
Every 10 ratings, on the Save button, and when you leave the page. It reads the newest file from GitHub,
changes only the lines you rated, and writes it back. If the phone (Imke) saved in the meantime it reads again and
applies your ratings on top. Offline, ratings stay on the phone until the next save.

## inbox.csv
`dutch,english,phrase,who,date,source`. `source` is `dutch-reader` for a typed meaning, or
`dutch-reader+wiktionary (meaning unreviewed)` for an unchanged Wiktionary suggestion.

## Token
A fine-grained GitHub token for the `learning-progress` repo only, permission Contents: read and write,
stored in this browser's local storage. If the phone is lost, revoke the token on GitHub.

## Credits
Meaning suggestions: Wiktionary (CC BY-SA). The word levels in the list come from NT2Lex (CC BY-NC-SA 4.0).

## Look (poster style, added 2026-11-17)
Teal, cream, mustard, coral and orange, black outlines with hard offset shadows, bold Anton lettering and a matte print grain. Fonts are in `fonts/` (Anton, Oswald; both SIL Open Font License) so the app works offline. The grain strength is the `--grain` value at the top of the v5 block in `style.css` (0 = off, .144 = the "18" setting). The Home scene (sun, hills, waves) is plain CSS shapes.

## Version (added 2026-11-17)
Settings shows `Version <date>.<n>` and checks `version.json` on the server: "up to date", "newer version … available" (with a reload button) or "can't check (offline?)". On every change, bump `VERSION` in `app.js` and `version.json` together (the browser test fails if they differ).

## Packs (added 2026-11-17)
Words sit in ONE master list (`dutch/vocab/dutch-vocab.csv`). A `packs` column at the end tags each word (semicolon-separated, e.g. `b1;architecture`). `dutch/vocab/packs.csv` (`pack,name,description,kind,default`) lists the packs: `kind` is `level` (a1 to c1, nolevel) or `topic`; `default` says whether it is on at first. Level packs are on by default, topic packs off. Settings has a tick-box per pack with word counts; the choice is kept on the phone (`dr.packs`). At least one pack must stay on. Words with no tag, or no packs.csv, are always on. Words from a switched-on topic pack are sorted and practised first.

## Type it (added 2026-11-17)
Play tab. Shows the English word and you type the Dutch, or the other way, or mixed. Capitals, accents and punctuation are ignored; a missing de/het/een (or to/the/a) is fine. A wrong de/het, one letter off, or another list word with the same meaning is "Almost" and is not counted. "Show me" is not counted. Right/wrong are saved like any other answer. Right answers pay double points. Score rows use mode `type`; a round with nothing counted sends no score row.

## Version rule
`VERSION` in `app.js` and `version.json` must be bumped together on every change, and the cache name in `sw.js` when files change.

## Flashcards (added 2026-11-17)
Play tab. 10 cards (Dutch to English, English to Dutch or mixed). Tap to flip, then swipe right (or tap ✓ / press →) for "Got it", left (✗ / ←) for "Not yet"; Space flips. You must flip before judging. The first go at each card is saved like any answer (right or wrong) and earns the word's base points, with no speed bonus because you mark yourself. Missed cards come back until all are got; retries earn nothing and change nothing. Points are banked (score row, mode `flash`) only when the last card is done; stopping early banks nothing.

## Wagers (added 2026-11-17)
Battles are played for points. The challenger sets a wager in tens (10, 20, 30…, up to the points they have) and picks a person or "Anyone (open challenge)". The other player matches it; the winner takes both (2x the wager), a draw gives both wagers back. An open challenge belongs to the first person (other than the challenger) who plays it, then it disappears for everyone else. Battle rounds themselves pay no ordinary points.
Stakes and payouts are rows in `dutch/scores.csv`: `w<battle id>s<name>` (mode `wager`, negative points), `w<battle id>p<name>` (mode `wager-win` or `wager-draw`). They change points but do not count as rounds or streak days. Open challenges use `*` in the `opponent` column of battles.csv. Battles sent before wagers existed have no stake row and play as before (no wager). Not built: cancelling an unplayed challenge or giving the stake back after a time. Handicap battles need a named opponent.

## Money, wager stepper, clock and boats (added 2026-11-17)
The app shows points as euros (\u20ac) everywhere. The files keep their `points` columns; one point is one euro. Battle scores are shown as plain "score", because they only compare players; money moves through the wager.
The wager is set with a minus and a plus button in steps of 10 (at least 10, at most what you have). The battle card shows the pot ("\u20ac80 on the table: \u20ac40 from you, \u20ac40 from them"). Both players get the same questions, the same scoring and the same wager.
**Clock:** each battle question has 10 seconds. A right answer pays 10 in the first second, 9 in the second ... 1 in the tenth (`G.battlePoints(ms)`); too late pays 0 and counts as a miss (not recorded in the word list). Each question's points are stored as `p` inside the `questions` JSON of the challenge row (no new column). A challenge without `p` (sent before the clock) plays the old way: no clock, flat 10 + speed, ghost rows evenly.
**Boats:** top-down drone view of a rowing lane, camera locked on your boat; water and the red-buoy lane ropes scroll as your score grows; the finish line is a checkered flag at questions x 10 points. Challenger sees one full-width lane; the player replying sees two lanes (you left, the challenger's ghost right), the ghost moving by the points they scored per question. Boat colours: you red, opponent yellow (customising later).
Not built yet (ideas): sound effects (Noah may supply .wav files), boat colour choice, cancelling or expiring unplayed challenges.
