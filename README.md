# Dutch reader

Take a photo (or pick a screenshot) of a page of Dutch text. The app reads the text, checks every
word against the Dutch word list in the private `learning-progress` repo, shows the words you
don't know yet, and lets you queue them. "Send" appends the queued words to `dutch/inbox.csv`
in that repo. It never edits the word list or the progress files.

No word list or personal data is stored in this repo. It only holds the app. The word list is
fetched with a GitHub token that you paste into the app on your phone (Settings).

## Files
| File | What it does |
|---|---|
| `index.html`, `style.css` | The screens |
| `app.js` | Buttons, photo reading, add/ignore, sending to GitHub |
| `matcher.js` | Splits text into words and sorts them: known / maybe a form of a known word / new / probably a name. No screen code, so it can be tested alone |
| `sw.js`, `manifest.webmanifest`, `icons/` | Lets Chrome install it on the home screen and open it offline |
| `vendor/tesseract/` | Tesseract.js (Apache-2.0): the text reader, its engine and the Dutch language data. Self-hosted so the app works without a CDN |
| `tests/` | `node tests/test_matcher.js` (matching), `tests/test_browser.js` (whole app in headless Chrome with a fake GitHub) |

## inbox.csv format (written to the learning-progress repo)
`dutch,english,phrase,who,date,source`. `source` is `dutch-reader` when the meaning was typed
by hand, or `dutch-reader+wiktionary (meaning unreviewed)` when it came from the Wiktionary
suggestion and was not changed. A later tool merges inbox rows into the word list and both
progress files.

## Token
A fine-grained GitHub token for the `learning-progress` repo only, permission Contents: read and write.
It is stored in this browser's local storage on the phone. If the phone is lost, revoke the token on GitHub.

## Credits
Text reading: Tesseract.js and Tesseract (Apache-2.0), Dutch data from tessdata_best (Apache-2.0).
Meaning suggestions: Wiktionary (CC BY-SA).
