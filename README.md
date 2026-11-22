# Who Wants to Be an Aussie Millionaire?

A small quiz-show game for English class. You sit in the contestant's chair,
Max is the host, and Tom and Fabi are the experts on the big screen.
Twelve questions take you on a road trip across Australia.

The game is plain HTML, CSS and JavaScript. There is nothing to install.

| File | What it is |
| --- | --- |
| `index.html` | The page (studio, buttons, start and result screens) |
| `style.css` | Colours, layout and animations |
| `game.js` | The game (the comments at the top explain the parts) |
| `questions.json` | **All** texts, questions, prizes and file names |
| `audio/` | The 94 voice clips (mp3) go here |
| `images/` | The 6 photos go here |

## 1. Run it on your computer

The game loads `questions.json`, so you cannot just double-click `index.html`.
You need a small local web server. Python has one:

1. Open a terminal in the project folder.
2. Type `python3 -m http.server` and press Enter.
3. Open <http://localhost:8000> in your browser.
4. To stop the server, press `Ctrl + C` in the terminal.

## 2. Add the voice clips (mp3)

- Put all mp3 files into the folder `audio/`.
- The file names must be **exactly** the names in `questions.json`
  (look for `"file": "audio/..."`). Small letters, no spaces. Examples:
  `audio/intro_1.mp3`, `audio/q01_host.mp3`, `audio/q01_wrong_a.mp3`,
  `audio/q01_fact.mp3`, `audio/q01_phone.mp3`, `audio/x_5050.mp3`.
- There are 94 clips: 3 intro clips, 7 extra clips and 7 clips for each of the 12 questions.
- **A clip is missing? No problem.** The game shows the subtitle and waits
  (about 0.4 seconds per word), then it goes on. So you can play the whole game
  before any audio exists, and add the clips one by one.

## 3. Add the photos

Put these six files into the folder `images/` (same names, small letters):

`kangaroo.jpg`, `uluru.jpg`, `platypus.jpg`, `opera-house.jpg`, `kakadu.jpg`, `parliament-house.jpg`

If a photo is missing, the game shows a drawn picture in its place.

**Photo credits:** open `questions.json`, go to `photoCredits` at the bottom and
replace every `TODO` with the real author, licence and source (the link to the
Wikimedia Commons page). As long as an entry says `TODO`, the credits screen
shows "Credit missing".

## 4. Change the colours of Max, Tom and Fabi

Open `questions.json` and look at `cast` at the top:

```json
"Max": { "role": "host", "shirtColor": "#E8833A", "hairColor": "#3B2A1E", "skinColor": "#F1C9A5" }
```

Change the colour codes (for example `#E8833A`), save the file and reload the page.
A colour must be a hex code that starts with `#`. Search for "colour picker"
on the internet to find codes.

## 5. Publish it for free with GitHub Pages

1. Put all files in a GitHub repository (this one). The files must be on the
   branch you want to publish, normally `main`.
2. On GitHub, open the repository and click **Settings**.
3. In the menu on the left, click **Pages**.
4. Under **Build and deployment**, choose **Source: Deploy from a branch**.
5. Choose the branch (for example `main`) and the folder **/ (root)**, then click **Save**.
6. Wait one or two minutes and reload the page. GitHub shows the address,
   something like `https://YOUR-NAME.github.io/aussie-millionaire/`.
7. Send this link to your classmates. Every time you push new files
   (for example new mp3 clips), the website updates itself after a minute.

Tip: file names on GitHub Pages are case-sensitive. `Uluru.JPG` is **not** the
same as `uluru.jpg`.

## 6. How to play

- Click **Start**. Listen to Max, then choose an answer.
- Keyboard: `A` `B` `C` `D` or `1` `2` `3` `4` choose an answer, `Space` skips a clip.
- **Skip** ends the current clip, **Replay** plays it again.
- The speaker button mutes the sound, **CC** turns the subtitles on or off.
- Three lifelines, each only once: **50:50**, **Ask the Class**, **Phone a Friend**.
- On phones, the prize ladder is behind the **Prizes** button.

## 7. For testing

- `http://localhost:8000/?fast` – everything is very fast (good for testing the order of the game).
- `http://localhost:8000/?q=9` – jump straight to question 9 (no intro).
- The first lines of `game.js` (`SETTINGS`) have numbers you can change,
  for example how long the van drives or how loud the little beeps are.

## 8. Good to know

- **After an update, a phone may still show the old game** because it keeps old
  files for a while. To stop this, `index.html` loads `style.css?v=3` and
  `game.js?v=3`. When you change `style.css` or `game.js`, make the number bigger
  in both lines (for example `?v=4`). Then all phones load the new files.

- All question texts live in `questions.json`. If you change a text there, the game changes too.
- While mp3 files or photos are missing, the browser console shows red
  "404 (File not found)" lines. That is normal and goes away when the files are there.
- The map of Australia is a simple drawing, not an exact map.
