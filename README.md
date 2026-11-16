# Dutch words

A small web app (installable on Android from Chrome) for the Dutch word list in the private
`learning-progress` repo.

- **Sort words**: one word at a time, tap how well you know it, 0 to 5 (six levels). Your rating is
  saved into your own progress file (`dutch/noah.csv` or `dutch/anna.csv`), changing only the lines of
  the words you rated.
- **Add a word**: type a Dutch word and its meaning (or ask Wiktionary for a suggestion). "Send" appends it
  to `dutch/inbox.csv`. A later tool merges inbox words into the word list and both progress files.

- **Flag issue** (button on each word while sorting): reports a wrong meaning, a swapped word, a typo or something else. Appended to `dutch/issues.csv` (`dutch,english,type,note,who,date`). The word list is not changed by the app.
- **Ideas** tab: a box to pitch an idea for the app. Appended to `dutch/ideas.csv` (`date,who,idea`).

Flags, ideas and typed words are sent straight away; if the phone is offline they stay on the phone and go out at the next save.

No word list or personal data is stored in this repo, only the app. The data is fetched with a GitHub
token that you paste into the app on your phone (Settings).
(Version 1 had a photo scanner using Tesseract.js; it was removed on 16 Nov 2026. It is in the Git history.)

## The levels and how they are saved
Saved with the statuses the Cobra phone already understands, so Imke reacts straight away.

| Tap | Name | `status` | `streak` | `next_due` |
|---|---|---|---|---|
| 0 | New | `unknown` | 0 | rating date (marks "rated 0") |
| 1 | Just met | `needs_practice` | 0 | today |
| 2 | Recognized | `learning` | 1 | +2 days |
| 3 | Familiar | `learning` | 2 | +7 days |
| 4 | Learned | `known` | 3 | +60 days |
| 5 | Known ✓ | `known` | 5 | +365 days |

`right`, `wrong`, `last_practised` and `pronunciation` are never changed. A word counts as not rated
yet if it is `unknown` with an empty `next_due`. Imke's later answers use her normal rules and replace the
rating. When the app reads a row back it guesses the level from `status`, `streak` and `next_due`
(4 versus 5 is told apart by a due date more than 200 days away).

## Files
| File | What it does |
|---|---|
| `index.html`, `style.css`, `app.js` | The screens |
| `triage.js` | The rating rules, the line-by-line saving into the progress file, and the order words come in |
| `matcher.js` | Reads CSV, and spots forms of words you know (for "Add a word") |
| `sw.js`, `manifest.webmanifest`, `icons/` | Lets Chrome install it and open it offline |
| `tests/` | `node tests/test_matcher.js [vocab.csv]`, `node tests/test_triage.js [dutch folder]`, `tests/test_browser.js` (whole app in headless Chrome with a fake GitHub) |

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
