/* =========================================================================
   Who Wants to Be an Aussie Millionaire?  –  game.js

   All texts, questions, prizes and file names come from questions.json.
   Nothing about the questions is written in this file.

   How this file is organised (search for the numbers):
     1. Settings            – numbers you can safely change
     2. Small helpers
     3. State machine       – which step of the show we are in
     4. Audio queue         – plays clips one after another + subtitles
     5. Sound effects       – tiny beeps made with the Web Audio API
     6. Cartoon drawings    – people, van, logo ... as SVG text
     7. Studio              – lights, Max, big screen, video call, zoom
     8. Map of Australia    – outline, states, projection
     9. Big-screen views    – question, travel map, fun facts ...
    10. Answers, lifelines and prize ladder
    11. Game flow           – the order of the whole show
    12. Result and credits screens
    13. Buttons and keyboard
    14. Start-up
   ========================================================================= */
'use strict';

/* =========================================================================
   1. SETTINGS
   ========================================================================= */
const SETTINGS = {
  secondsPerWord: 0.4,     // reading time per word when an mp3 is missing
  minClipSeconds: 2,       // shortest waiting time when an mp3 is missing
  mouthMs: 150,            // how fast the mouth opens and closes
  suspenseMs: 1500,        // orange "drum roll" pause after choosing an answer
  zoomMs: 800,             // must match the transition time of .camera in style.css
  travelMs: 2400,          // how long the campervan drives
  walkMs: 2800,            // how long Max walks to his desk
  audioLoadTimeoutMs: 4000,// wait at most this long for an mp3 to load
  humVolume: 0.012,        // very quiet studio hum (0 = off)
  sfxVolume: 0.10,         // loudness of the little beeps (0 = off)
  logoHighlight: 'Aussie'  // this word of the title is shown in gold
};

// Testing helpers:  index.html?fast  makes all waiting times very short,
//                   index.html?q=9   jumps straight to question 9.
const PARAMS = new URLSearchParams(window.location.search);
const FAST = PARAMS.has('fast');
const SPEED = FAST ? 0.04 : 1;
const START_AT = Math.max(1, parseInt(PARAMS.get('q'), 10) || 1);

let DATA = null; // the content of questions.json

/* =========================================================================
   2. SMALL HELPERS
   ========================================================================= */
const $ = (id) => document.getElementById(id);

/** Create an HTML element: el('div', 'my-class', 'my text') */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

/** Turn a string of SVG/HTML into a real element. */
function fromMarkup(markup) {
  const box = document.createElement('div');
  box.innerHTML = markup.trim();
  return box.firstElementChild;
}

/** Wait some milliseconds (shorter in ?fast mode). */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms * SPEED));

/** Wait for a promise, but give up after `ms` and use `fallback` instead. */
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms))
  ]);
}

const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function shuffle(list) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** 25000 -> "A$25,000" */
function formatMoney(amount) {
  return DATA.currency + String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Only allow simple colour values from questions.json (e.g. "#E8833A"). */
function safeColor(value, fallback) {
  return /^#[0-9a-f]{3,8}$/i.test(String(value || '')) ? value : fallback;
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const countWords = (text) => text.trim().split(/\s+/).length;

/* =========================================================================
   3. STATE MACHINE
   The game is always in exactly one state. setState() only allows the
   steps listed here, so the order of the show can never get mixed up.
   ========================================================================= */
const TRANSITIONS = {
  LOADING:  ['START'],
  START:    ['INTRO'],
  INTRO:    ['TRAVEL'],
  TRAVEL:   ['ASK'],                      // van drives, then Max asks
  ASK:      ['OPEN'],                     // host clip is playing
  OPEN:     ['LOCKED', 'LIFELINE', 'ASK'],// answers can be clicked (ASK = Replay)
  LIFELINE: ['OPEN'],
  LOCKED:   ['REACTION'],                 // orange suspense, then green/red
  REACTION: ['FACT'],                     // expert says right or wrong
  FACT:     ['NEXT', 'GAMEOVER', 'WIN'],  // zoom into the big screen
  NEXT:     ['TRAVEL'],
  GAMEOVER: ['INTRO'],                    // Play again
  WIN:      ['INTRO']
};

const game = {
  state: 'LOADING',
  index: 0,             // number of the current question, starting at 0
  correctCount: 0,      // how many questions were answered correctly
  used: { fiftyFifty: false, askClass: false, phone: false },
  removed: [],          // letters taken away by 50:50 on this question
  votes: null,          // result of Ask the Class on this question
  answerResolver: null  // "the player has chosen" callback
};

function setState(next) {
  if (!TRANSITIONS[game.state].includes(next)) {
    throw new Error('State change not allowed: ' + game.state + ' -> ' + next);
  }
  game.state = next;
  $('game').dataset.state = next;
  updateControls();
}

const currentQuestion = () => DATA.questions[game.index];

/* =========================================================================
   4. AUDIO QUEUE
   say(clip) plays one clip from questions.json: { file, speaker, text }.
   Clips are put in a queue, so two clips can never play at the same time.
   If the mp3 is missing, we show the subtitle and wait instead.
   ========================================================================= */
const audio = {
  player: new Audio(),   // one single player for all clips (works best on phones)
  cache: new Map(),      // file name -> promise of a playable URL (or null if missing)
  queue: Promise.resolve(),
  current: null,         // the clip that is playing right now
  last: null,            // the last clip (for Replay)
  muted: false,
  subtitles: true
};

// A very short silent sound (a tiny WAV file written as text).
const SILENCE = 'data:audio/wav;base64,UklGRrQBAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YZABAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA';

/**
 * Phones only allow sound after a tap. So when Start is tapped, we play
 * a silent sound once. After that the player may play the real clips.
 */
function unlockAudio() {
  const player = audio.player;
  player.src = SILENCE;
  const started = player.play();
  if (started && started.then) {
    started.then(() => { if (player.src === SILENCE) player.pause(); }).catch(() => {});
  }
}

/** Download an mp3 in the background. Gives null if the file does not exist. */
function loadAudio(file) {
  if (!audio.cache.has(file)) {
    const promise = fetch(file)
      .then((response) => (response.ok ? response.blob() : null))
      .then((blob) => {
        if (!blob || blob.size === 0 || blob.type.startsWith('text/')) return null;
        return URL.createObjectURL(blob);
      })
      .catch(() => null);
    audio.cache.set(file, promise);
  }
  return audio.cache.get(file);
}

/** Start loading clips we will need soon. */
function preload(clips) {
  clips.forEach((clip) => { if (clip && clip.file) loadAudio(clip.file); });
}

/** All clips of one question (plus the lifeline clips that can still be used). */
function preloadQuestion(index) {
  const q = DATA.questions[index];
  if (!q) return;
  const c = q.clips;
  preload([c.host, c.correct, c.fact, c.phone].concat(Object.values(c.wrong)));
  const x = DATA.extras;
  if (!game.used.fiftyFifty) preload([x.fiftyFifty]);
  if (!game.used.askClass) preload([x.askClass]);
  if (!game.used.phone) preload([x.phone]);
  preload([x.gameOver]);
  if (DATA.safeLevels.includes(index + 1)) preload([x.safe]);
  if (index + 1 === DATA.questions.length) preload([x.winner]);
  // ... and the host clip of the next question
  const next = DATA.questions[index + 1];
  if (next) preload([next.clips.host]);
  if (index + 2 === DATA.questions.length) preload([x.final]);
}

/** Write "SPEAKER: text" into the subtitle box. */
function fillSubtitle(speaker, text) {
  const box = $('subtitle');
  box.textContent = '';
  box.classList.remove('hint');
  box.append(el('span', 'sub-speaker', speaker + ': '), el('span', 'sub-text', text));
}

/**
 * Split a long text into pieces that fit into the subtitle box.
 * The words are never changed, the text is only shown piece by piece
 * (whole sentences if possible).
 */
function splitSubtitle(speaker, text) {
  const box = $('subtitle');
  const whole = [{ text: text, words: countWords(text) }];
  if (box.clientHeight < 20) return whole;          // box not visible: no measuring
  const fits = (candidate) => {
    fillSubtitle(speaker, candidate.trim());
    return box.scrollHeight <= box.clientHeight + 2;
  };
  let sentences = text.match(/[^.!?]+[.!?]+["']?(\s+|$)|[^.!?]+$/g);
  if (!sentences || sentences.join('') !== text) sentences = [text];

  const chunks = [];
  let buffer = '';
  const push = () => { if (buffer.trim()) chunks.push(buffer); buffer = ''; };
  sentences.forEach((sentence) => {
    if (fits(buffer + sentence)) { buffer += sentence; return; }
    push();
    if (fits(sentence)) { buffer = sentence; return; }
    // One sentence alone is too long for the box: break it between words.
    (sentence.match(/\S+\s*/g) || []).forEach((word) => {
      if (!buffer || fits(buffer + word)) { buffer += word; } else { push(); buffer = word; }
    });
  });
  push();
  box.textContent = '';
  return chunks.length ? chunks.map((chunk) => ({ text: chunk.trim(), words: countWords(chunk) })) : whole;
}

function showSubtitle(speaker, text) {
  if (audio.subtitles) {
    fillSubtitle(speaker, text);
  } else {
    $('subtitle').textContent = '';
    $('subtitle').classList.remove('hint');
  }
}

function showHint(text) {
  const box = $('subtitle');
  box.textContent = text || '';
  box.classList.add('hint');
}

/** Put a clip into the queue. The promise is done when the clip has finished. */
function say(clip) {
  const done = audio.queue.then(() => playClipNow(clip));
  audio.queue = done.catch((error) => console.warn(error));
  return done;
}

async function playClipNow(clip) {
  const chunks = splitSubtitle(clip.speaker, clip.text);
  const totalWords = countWords(clip.text);
  const cur = {
    clip: clip,
    done: false,        // set by Skip
    finish: null,       // call this to end the clip
    usingAudio: false,  // false = mp3 missing, we only wait
    startedAt: 0,
    totalMs: 0,
    chunkIndex: -1,
    timer: null
  };
  audio.current = cur;
  audio.last = clip;
  updateControls();
  startSpeaking(clip.speaker);
  showSubtitle(clip.speaker, chunks[0].text);

  const url = await withTimeout(loadAudio(clip.file), SETTINGS.audioLoadTimeoutMs, null);

  if (!cur.done) {
    await new Promise((resolve) => {
      cur.finish = resolve;
      const player = audio.player;

      // Fallback: no mp3 (yet) -> wait about 0.4 s per word, at least 2 s.
      const startFallback = () => {
        cur.usingAudio = false;
        cur.startedAt = performance.now();
        cur.totalMs = Math.max(SETTINGS.minClipSeconds, totalWords * SETTINGS.secondsPerWord) * 1000 * SPEED;
      };

      if (url) {
        cur.usingAudio = true;
        player.onended = () => resolve();
        player.onerror = () => { if (cur.usingAudio) startFallback(); };
        player.src = url;
        const started = player.play();
        if (started && started.catch) started.catch(() => { if (cur.usingAudio) startFallback(); });
      } else {
        startFallback();
      }

      // Every 100 ms: show the right piece of the subtitle, end the fallback wait.
      cur.timer = setInterval(() => {
        let progress = 0;
        if (cur.usingAudio) {
          const length = player.duration;
          if (length && isFinite(length)) progress = player.currentTime / length;
        } else {
          progress = (performance.now() - cur.startedAt) / cur.totalMs;
          if (progress >= 1) { resolve(); return; }
        }
        // Which chunk belongs to this moment? (chunks are weighted by their word count)
        let wordsSoFar = 0;
        let index = 0;
        for (let i = 0; i < chunks.length; i++) {
          wordsSoFar += chunks[i].words;
          index = i;
          if (progress * totalWords < wordsSoFar) break;
        }
        if (index !== cur.chunkIndex) {
          cur.chunkIndex = index;
          showSubtitle(clip.speaker, chunks[index].text);
        }
      }, 100);
    });
  }

  // Clean up
  clearInterval(cur.timer);
  audio.player.onended = null;
  audio.player.onerror = null;
  audio.player.pause();
  stopSpeaking();
  showHint('');
  audio.current = null;
  updateControls();
}

/** Skip button: end the current clip and go on. */
function skipClip() {
  const cur = audio.current;
  if (!cur) return;
  cur.done = true;
  if (cur.finish) cur.finish();
}

/** Replay button: play the current clip from the start, or the last clip again. */
async function replayClip() {
  const cur = audio.current;
  if (cur) {
    if (cur.usingAudio) {
      audio.player.currentTime = 0;
      const started = audio.player.play();
      if (started && started.catch) started.catch(() => {});
    } else {
      cur.startedAt = performance.now();
    }
    cur.chunkIndex = -1;
    return;
  }
  // No clip is playing: only allowed while the answers are open.
  if (game.state === 'OPEN' && audio.last) {
    setState('ASK');
    await say(audio.last);
    setState('OPEN');
    showHint('Choose your answer.');
  }
}

function setMuted(muted) {
  audio.muted = muted;
  audio.player.muted = muted;
  sfx.setMuted(muted);
  $('btn-mute').setAttribute('aria-pressed', String(muted));
  $('btn-mute').classList.toggle('is-muted', muted);
  try { localStorage.setItem('aussie-muted', muted ? '1' : '0'); } catch (e) { /* private mode */ }
}

function setSubtitles(on) {
  audio.subtitles = on;
  $('btn-subs').setAttribute('aria-pressed', String(on));
  $('btn-subs').classList.toggle('is-off', !on);
  if (!on && !$('subtitle').classList.contains('hint')) $('subtitle').textContent = '';
  if (on && audio.current) audio.current.chunkIndex = -1; // show the text again
}

/* =========================================================================
   5. SOUND EFFECTS (Web Audio API, no sound files)
   ========================================================================= */
const sfx = {
  ctx: null,
  master: null,

  /** Must be called after a click (browsers only allow sound after a tap). */
  init() {
    if (this.ctx) { this.ctx.resume(); return; }
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      this.ctx = new AudioContextClass();
      this.master = this.ctx.createGain();
      this.master.gain.value = audio.muted ? 0 : 1;
      this.master.connect(this.ctx.destination);
      this.startHum();
    } catch (e) {
      this.ctx = null; // no sound effects, the game still works
    }
  },

  setMuted(muted) {
    if (this.master) this.master.gain.value = muted ? 0 : 1;
  },

  /** A very quiet, low "studio" hum. */
  startHum() {
    if (!SETTINGS.humVolume) return;
    [110, 164.8].forEach((frequency) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = frequency;
      gain.gain.value = SETTINGS.humVolume;
      osc.connect(gain).connect(this.master);
      osc.start();
    });
  },

  /** One short beep. */
  tone(frequency, delay, length, type) {
    if (!this.ctx || !SETTINGS.sfxVolume) return;
    const start = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(SETTINGS.sfxVolume, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
    osc.connect(gain).connect(this.master);
    osc.start(start);
    osc.stop(start + length + 0.05);
  },

  lock()    { this.tone(392, 0, 0.14, 'triangle'); this.tone(294, 0.14, 0.3, 'triangle'); },
  correct() { this.tone(523, 0, 0.15); this.tone(659, 0.14, 0.15); this.tone(784, 0.28, 0.4); },
  wrong()   { this.tone(196, 0, 0.3, 'sawtooth'); this.tone(139, 0.28, 0.6, 'sawtooth'); },
  ring()    { for (let i = 0; i < 6; i++) this.tone(i % 2 ? 880 : 740, i * 0.09, 0.09, 'square'); },
  light()   { this.tone(1200, 0, 0.05, 'square'); }
};

/* =========================================================================
   6. CARTOON DRAWINGS (inline SVG)
   ========================================================================= */

/**
 * Draw a person from the `cast` in questions.json.
 * variant: 'full'  = whole body (Max walking in)
 *          'bust'  = upper body (experts in the video call)
 *          'phone' = upper body holding a phone
 */
function personSVG(name, variant) {
  const info = (DATA.cast && DATA.cast[name]) || {};
  const shirt = safeColor(info.shirtColor, '#888888');
  const hair = safeColor(info.hairColor, '#3b2a1e');
  const skin = safeColor(info.skinColor, '#f1c9a5');
  const full = variant === 'full';
  const outline = 'stroke="rgba(0,0,0,.18)" stroke-width="2"';

  // Three different hair styles, so the three characters don't look the same.
  const hairStyles = [
    `<path d="M63 60 Q58 14 102 15 Q146 16 137 62 Q131 42 116 37 Q94 46 70 38 Q65 48 63 60 Z" fill="${hair}"/>`,
    `<g fill="${hair}"><circle cx="70" cy="40" r="13"/><circle cx="84" cy="28" r="14"/><circle cx="101" cy="23" r="15"/>
       <circle cx="118" cy="28" r="14"/><circle cx="131" cy="41" r="12"/><circle cx="66" cy="54" r="8"/><circle cx="135" cy="54" r="8"/></g>`,
    `<path d="M63 64 Q54 12 104 13 Q150 14 137 64 Q134 48 124 40 Q100 56 72 36 Q65 48 63 64 Z" fill="${hair}"/>`
  ];
  const styleNumber = Math.max(0, Object.keys(DATA.cast || {}).indexOf(name)) % hairStyles.length;

  const legs = full ? `
    <g class="leg leg-l"><rect x="72" y="244" width="26" height="130" rx="12" fill="#27295a"/><ellipse cx="83" cy="378" rx="19" ry="10" fill="#14152e"/></g>
    <g class="leg leg-r"><rect x="102" y="244" width="26" height="130" rx="12" fill="#30336e"/><ellipse cx="117" cy="378" rx="19" ry="10" fill="#14152e"/></g>` : '';

  const leftArm = `
    <g class="arm arm-l"><rect x="48" y="112" width="26" height="106" rx="13" fill="${shirt}" ${outline}/><circle cx="61" cy="222" r="12" fill="${skin}"/></g>`;

  const rightArm = `
    <g class="arm arm-r"><rect x="126" y="112" width="26" height="106" rx="13" fill="${shirt}" ${outline}/><circle cx="139" cy="222" r="12" fill="${skin}"/></g>`;

  // Right arm bent up, holding a phone to the ear
  const phoneArm = `
    <g class="arm-phone">
      <path d="M139 126 L162 176 L150 100" fill="none" stroke="${shirt}" stroke-width="24" stroke-linecap="round" stroke-linejoin="round"/>
      <rect x="137" y="40" width="17" height="52" rx="6" fill="#15172e" transform="rotate(8 145 66)"/>
      <circle cx="151" cy="90" r="12" fill="${skin}"/>
    </g>`;

  return `
  <svg class="person" viewBox="0 0 200 ${full ? 400 : 236}" preserveAspectRatio="xMidYMax meet" aria-hidden="true">
    ${legs}
    <rect x="56" y="104" width="88" height="${full ? 160 : 150}" rx="30" fill="${shirt}"/>
    ${leftArm}
    ${variant === 'phone' ? '' : rightArm}
    <rect x="89" y="88" width="22" height="28" rx="9" fill="${skin}"/>
    <path d="M85 107 Q100 124 115 107" fill="none" stroke="rgba(0,0,0,.2)" stroke-width="3" stroke-linecap="round"/>
    <g class="head">
      <circle cx="63" cy="66" r="7" fill="${skin}"/><circle cx="137" cy="66" r="7" fill="${skin}"/>
      <ellipse cx="100" cy="62" rx="36" ry="40" fill="${skin}"/>
      ${hairStyles[styleNumber]}
      <g class="eyes"><circle cx="86" cy="65" r="4.5" fill="#1d1d2b"/><circle cx="114" cy="65" r="4.5" fill="#1d1d2b"/></g>
      <circle cx="75" cy="79" r="6" fill="rgba(255,110,110,.25)"/><circle cx="125" cy="79" r="6" fill="rgba(255,110,110,.25)"/>
      <path class="mouth-closed" d="M88 82 Q100 93 112 82" fill="none" stroke="#7a2c2c" stroke-width="3.5" stroke-linecap="round"/>
      <ellipse class="mouth-open-shape" cx="100" cy="86" rx="9" ry="8" fill="#7a2230"/>
    </g>
    ${variant === 'phone' ? phoneArm : ''}
  </svg>`;
}

const BOOMERANG_SVG = `
  <svg class="boomerang" viewBox="0 0 64 48" aria-hidden="true">
    <path d="M4 37 Q1 31 7 25 L25 7 Q32 0 39 7 L58 28 Q63 34 58 39 Q53 43 48 37 L34 21 Q32 19 30 21 L15 39 Q9 45 4 37 Z" fill="#ffcb45" stroke="#b9791a" stroke-width="2.5" stroke-linejoin="round"/>
    <path d="M11 27 l6 6 M18 20 l6 6 M41 16 l-6 6 M48 24 l-6 6" stroke="#c4502a" stroke-width="2.5" stroke-linecap="round"/>
    <circle cx="32" cy="11" r="2.5" fill="#c4502a"/>
  </svg>`;

/** The five stars of the Southern Cross. */
function starsSVG() {
  const star = (x, y, r) => {
    let points = '';
    for (let i = 0; i < 10; i++) {
      const radius = i % 2 ? r * 0.45 : r;
      const angle = (Math.PI / 5) * i - Math.PI / 2;
      points += (x + radius * Math.cos(angle)).toFixed(1) + ',' + (y + radius * Math.sin(angle)).toFixed(1) + ' ';
    }
    return `<polygon points="${points}"/>`;
  };
  return `<svg viewBox="0 0 100 120" aria-hidden="true" fill="#ffcb45">
    ${star(50, 12, 10)}${star(18, 50, 10)}${star(82, 44, 10)}${star(52, 104, 11)}${star(66, 66, 5)}</svg>`;
}

const VAN_SVG = `
  <svg viewBox="0 0 80 52" aria-hidden="true">
    <rect x="12" y="3" width="48" height="5" rx="2.5" fill="#fff3c4" stroke="#b9791a" stroke-width="1"/>
    <rect x="20" y="8" width="3" height="5" fill="#333"/><rect x="50" y="8" width="3" height="5" fill="#333"/>
    <path d="M6 40 V22 Q6 12 16 12 H56 Q64 12 68 20 L74 30 Q76 33 76 36 V40 Z" fill="#ff9a2e" stroke="#7a3a10" stroke-width="2" stroke-linejoin="round"/>
    <path d="M7 30 H74 Q75 33 75 36 V39 H7 Z" fill="#fff6e0"/>
    <rect x="12" y="17" width="16" height="10" rx="2" fill="#bfe6ff"/><rect x="32" y="17" width="16" height="10" rx="2" fill="#bfe6ff"/>
    <path d="M52 17 H60 Q63 17 65 21 L68 27 H52 Z" fill="#bfe6ff"/>
    <circle cx="22" cy="42" r="7" fill="#22243f"/><circle cx="22" cy="42" r="3" fill="#ddd"/>
    <circle cx="58" cy="42" r="7" fill="#22243f"/><circle cx="58" cy="42" r="3" fill="#ddd"/>
  </svg>`;

const PHONE_SVG = `
  <svg viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#ffcb45" d="M14 6c2-1 4 0 5 2l3 6c1 2 0 4-1 5l-3 2c2 5 6 9 11 11l2-3c1-1 3-2 5-1l6 3c2 1 3 3 2 5l-1 3c-1 3-4 5-8 4C21 41 8 28 5 14c-1-4 1-7 4-8z"/>
  </svg>`;

/** Drawn picture used when a photo file is missing. */
const PHOTO_PLACEHOLDER_SVG = `
  <svg class="photo" viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <rect width="400" height="300" fill="#ffb347"/>
    <rect width="400" height="120" fill="#ff8a3d" opacity=".55"/>
    <circle cx="290" cy="110" r="46" fill="#fff0b3"/>
    <path d="M0 190 Q60 150 130 176 T260 170 T400 160 V300 H0 Z" fill="#c4502a"/>
    <path d="M0 230 Q90 196 190 222 T400 210 V300 H0 Z" fill="#8c3219"/>
    <rect x="84" y="150" width="8" height="62" rx="3" fill="#4a2a17"/>
    <circle cx="88" cy="140" r="26" fill="#3f7d4a"/><circle cx="66" cy="152" r="16" fill="#3f7d4a"/><circle cx="110" cy="152" r="16" fill="#3f7d4a"/>
    <path d="M170 60 q10 -10 20 0 q10 -10 20 0" fill="none" stroke="#7a2c12" stroke-width="4" stroke-linecap="round"/>
  </svg>`;

const BARBECUE_SVG = `
  <svg viewBox="0 0 200 200" aria-hidden="true">
    <g class="smoke" fill="#ffffff" opacity=".55"><circle cx="78" cy="52" r="9"/><circle cx="104" cy="36" r="12"/><circle cx="128" cy="54" r="8"/></g>
    <path d="M70 136 L52 194 M130 136 L148 194 M100 140 V194" stroke="#2a2d55" stroke-width="8" stroke-linecap="round"/>
    <path d="M34 92 H166 Q166 146 100 146 Q34 146 34 92 Z" fill="#c4502a" stroke="#6e2410" stroke-width="4" stroke-linejoin="round"/>
    <rect x="28" y="84" width="144" height="12" rx="6" fill="#3a3d6e"/>
    <g fill="#9c4a22" stroke="#5e2a10" stroke-width="2.5">
      <rect x="48" y="66" width="46" height="15" rx="7.5" transform="rotate(-8 71 73)"/>
      <rect x="82" y="62" width="46" height="15" rx="7.5" transform="rotate(6 105 70)"/>
      <rect x="112" y="67" width="46" height="15" rx="7.5" transform="rotate(-5 135 74)"/>
    </g>
  </svg>`;

const SHIP_SVG = `
  <svg viewBox="0 0 220 200" aria-hidden="true">
    <path d="M110 18 V150 M62 40 V150 M158 46 V150" stroke="#5a3a1c" stroke-width="5" stroke-linecap="round"/>
    <path d="M110 18 l22 7 l-22 7 Z" fill="#e23d4b"/>
    <g fill="#fff8e6" stroke="#c9b98f" stroke-width="2">
      <path d="M84 30 H136 L140 62 H80 Z"/><path d="M78 68 H142 L146 104 H74 Z"/><path d="M74 110 H146 L148 138 H72 Z"/>
      <path d="M42 52 H82 L84 84 H40 Z"/><path d="M38 90 H84 L86 126 H36 Z"/>
      <path d="M140 58 H178 L181 88 H138 Z"/><path d="M137 94 H181 L184 128 H135 Z"/>
    </g>
    <path d="M16 148 H206 L190 184 Q186 190 178 190 H46 Q38 190 34 184 Z" fill="#7a4a22" stroke="#4a2a10" stroke-width="3" stroke-linejoin="round"/>
    <path d="M24 160 H200" stroke="#ffcb45" stroke-width="4"/>
    <path d="M206 148 L218 138" stroke="#5a3a1c" stroke-width="4" stroke-linecap="round"/>
  </svg>`;

/** The title from questions.json, with one word in gold and a boomerang. */
function fillLogo(node) {
  node.textContent = '';
  const title = DATA.title;
  const word = SETTINGS.logoHighlight;
  const at = title.indexOf(word);
  node.append(fromMarkup(BOOMERANG_SVG));
  const text = el('span', 'logo-text');
  if (at >= 0) {
    text.append(title.slice(0, at), el('span', 'logo-gold', word), title.slice(at + word.length));
  } else {
    text.textContent = title;
  }
  node.append(text);
}

/* =========================================================================
   7. STUDIO: lights, Max, big screen, video call, zoom
   ========================================================================= */
const ui = {
  hostName: '',     // filled from `cast` (the person with role "host")
  zoomed: false,
  factView: null,
  cycleTimer: null, // highlights the states one after another
  speaking: null    // { holder, timer, autoCall }
};

/** Build the parts of the studio that never change. */
function buildStudio() {
  // Spotlights
  const beams = $('beams');
  [8, 29, 50, 71, 92].forEach((left, i) => {
    const beam = el('div', 'beam');
    beam.style.left = left + '%';
    beam.style.setProperty('--rest', (i - 2) * -7 + 'deg');
    beam.style.setProperty('--sway-time', 6 + i * 1.3 + 's');
    beam.append(el('div', 'cone'), el('div', 'lamp'));
    beams.append(beam);
  });

  // Audience silhouettes
  let heads = '';
  ['#0d1136', '#090c28', '#05071a'].forEach((color, row) => {
    for (let i = 0; i < 7; i++) {
      const x = 14 + i * 30 + (row % 2) * 15;
      const y = 34 + row * 30;
      heads += `<g fill="${color}"><circle cx="${x}" cy="${y}" r="11"/><rect x="${x - 17}" y="${y + 9}" width="34" height="90" rx="14"/></g>`;
    }
  });
  const audience = `<svg viewBox="0 0 220 130" preserveAspectRatio="xMidYMax slice" aria-hidden="true">${heads}</svg>`;
  $('audience-left').innerHTML = audience;
  $('audience-right').innerHTML = audience;

  // Max, the host
  ui.hostName = Object.keys(DATA.cast).find((name) => DATA.cast[name].role === 'host') || '';
  $('host-figure').innerHTML = personSVG(ui.hostName, 'full');
  $('host-name').textContent = ui.hostName;

  fillLogo($('logo-small'));
  fillLogo($('logo-big'));
  $('start-stars').innerHTML = starsSVG();
  document.title = DATA.title;
}

/** Put the studio back to "before the show": dark, Max not on stage. */
function resetStudio() {
  const stage = $('stage');
  stage.classList.add('dark');
  stage.classList.remove('dim');
  document.querySelectorAll('.beam').forEach((beam) => beam.classList.remove('on'));
  $('stage').style.setProperty('--dark', '0.85');

  const host = $('host');
  host.classList.add('no-anim', 'offstage');
  host.classList.remove('seated', 'walking', 'waving', 'cheering');
  void host.offsetWidth;            // make the browser apply this right now
  host.classList.remove('no-anim');

  hideCall();
  showMain(null);
  setCameraZoom(false, true);
  stopConfetti();
  clearAnswers();
  showHint('');
}

/** Lights go on one after another, then the spotlights sweep once. */
async function lightsOn() {
  const beams = Array.from(document.querySelectorAll('.beam'));
  for (let i = 0; i < beams.length; i++) {
    beams[i].classList.add('on');
    sfx.light();
    $('stage').style.setProperty('--dark', String(0.85 * (1 - (i + 1) / beams.length)));
    await wait(300);
  }
  $('stage').classList.remove('dark');
  $('beams').classList.add('sweep');
  await wait(1400);
  $('beams').classList.remove('sweep');
}

/** Max walks in from the side, waves and sits down. */
async function hostWalkIn() {
  const host = $('host');
  if (reducedMotion()) {
    host.classList.add('no-anim');
    host.classList.remove('offstage');
    host.classList.add('seated');
    void host.offsetWidth;
    host.classList.remove('no-anim');
    await wait(300);
    return;
  }
  host.style.setProperty('--walk-time', SETTINGS.walkMs * SPEED + 'ms');
  host.classList.add('walking');
  host.classList.remove('offstage');
  await wait(SETTINGS.walkMs);
  host.classList.remove('walking');
  host.classList.add('waving');
  await wait(1500);
  host.classList.remove('waving');
  host.classList.add('seated');
  await wait(700);
}

/** Show something on the big screen (replaces what was there before). */
function showMain(view) {
  const main = $('screen-main');
  clearInterval(ui.cycleTimer);
  main.textContent = '';
  if (view) main.append(view);
}

/** Show an expert in the video-call frame. mode: 'full' or 'pip' (small corner). */
function showCall(name, mode, options) {
  const opts = options || {};
  const call = $('call');
  const key = name + (opts.phone ? ':phone' : '');
  if (call.dataset.person !== key) {
    const video = $('call-video');
    video.innerHTML = personSVG(name, opts.phone ? 'phone' : 'bust');
    $('call-name').textContent = name;
    call.dataset.person = key;
    if (opts.slide) {
      video.classList.remove('slide-in');
      void video.offsetWidth;
      video.classList.add('slide-in');
    }
  }
  call.dataset.mode = mode;
  $('screen').classList.toggle('call-full', mode === 'full');
}

function hideCall() {
  const call = $('call');
  call.dataset.mode = 'hidden';
  call.dataset.person = '';
  call.classList.remove('waving');
  $('screen').classList.remove('call-full');
}

/** The speaking person bounces, glows and moves the mouth. */
function startSpeaking(name) {
  stopSpeaking();
  const info = DATA.cast[name];
  if (!info) return;
  let holder;
  let autoCall = false;
  if (info.role === 'host') {
    holder = $('host');
  } else {
    holder = $('call');
    const shown = (holder.dataset.person || '').split(':')[0];
    if (holder.dataset.mode === 'hidden' || shown !== name) {
      showCall(name, 'full');   // experts only exist on the big screen
      autoCall = true;
    }
  }
  holder.classList.add('speaking');
  const timer = setInterval(() => {
    const person = holder.querySelector('.person');
    if (person) person.classList.toggle('mouth-open');
  }, SETTINGS.mouthMs);
  ui.speaking = { holder: holder, timer: timer, autoCall: autoCall };
}

function stopSpeaking() {
  const speaking = ui.speaking;
  if (!speaking) return;
  clearInterval(speaking.timer);
  speaking.holder.classList.remove('speaking');
  const person = speaking.holder.querySelector('.person');
  if (person) person.classList.remove('mouth-open');
  if (speaking.autoCall) hideCall();
  ui.speaking = null;
}

/** The big screen is 16:9 and sits at the top of the stage. */
function layoutStage() {
  const stage = $('stage');
  const W = stage.clientWidth;
  const H = stage.clientHeight;
  if (!W || !H) return;
  const height = Math.min(H * 0.58, (W * 0.94 * 9) / 16);
  const width = (height * 16) / 9;
  const screen = $('screen');
  screen.style.width = width + 'px';
  screen.style.height = height + 'px';
  screen.style.left = (W - width) / 2 + 'px';
  screen.style.top = Math.max(10, H * 0.035) + 'px';
  stage.style.setProperty('--sw', width + 'px');
  if (ui.zoomed) setCameraZoom(true, true);
}

/** How much do we have to zoom so that the big screen fills the stage? */
function computeZoom() {
  const stage = $('stage');
  const screen = $('screen');
  const W = stage.clientWidth;
  const H = stage.clientHeight;
  const w = screen.offsetWidth || 1;
  const h = screen.offsetHeight || 1;
  const scale = Math.min(W / w, H / h) * 0.97;
  return {
    scale: scale,
    x: W / 2 - scale * (screen.offsetLeft + w / 2),
    y: H / 2 - scale * (screen.offsetTop + h / 2)
  };
}

/**
 * Font size for fun-fact pictures. After the zoom, 1em is 16px on phones
 * and up to 28px on big screens.
 */
function factFontSize(scale) {
  const zoomedWidth = $('screen').offsetWidth * scale;
  return Math.min(28, Math.max(16, zoomedWidth * 0.024)) / scale;
}

/** Move the "camera" (no waiting here). */
function setCameraZoom(on, instantly) {
  const camera = $('camera');
  const zoom = on ? computeZoom() : { scale: 1, x: 0, y: 0 };
  if (instantly) camera.classList.add('no-anim');
  camera.style.transform = on ? `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})` : '';
  $('screen').style.setProperty('--fact-font', factFontSize(on ? zoom.scale : computeZoom().scale) + 'px');
  if (ui.factView) ui.factView.style.fontSize = factFontSize(zoom.scale) + 'px';
  if (instantly) { void camera.offsetWidth; camera.classList.remove('no-anim'); }
  ui.zoomed = on;
}

/** Zoom into the big screen or back out. With reduced motion: just fade. */
async function zoomCamera(on) {
  const camera = $('camera');
  if (reducedMotion()) {
    camera.classList.add('faded');
    await wait(250);
    setCameraZoom(on, true);
    camera.classList.remove('faded');
    await wait(250);
  } else {
    setCameraZoom(on, false);
    await wait(SETTINGS.zoomMs);
  }
}

/* ---------- Confetti (winner) ---------- */
function startConfetti() {
  const box = $('confetti');
  box.textContent = '';
  const colors = ['#1f9d55', '#2fbf71', '#0b7a3b', '#ffcb45', '#ffe08a', '#e0a100'];
  for (let i = 0; i < 90; i++) {
    const piece = el('i');
    piece.style.left = randInt(0, 100) + '%';
    piece.style.background = colors[i % colors.length];
    piece.style.animationDuration = randInt(25, 50) / 10 + 's';
    piece.style.animationDelay = -randInt(0, 40) / 10 + 's';
    piece.style.setProperty('--spin', randInt(-720, 720) + 'deg');
    piece.style.setProperty('--drift', randInt(-80, 80) + 'px');
    if (reducedMotion()) piece.style.top = randInt(0, 95) + '%';
    box.append(piece);
  }
}

function stopConfetti() {
  $('confetti').textContent = '';
}

/* =========================================================================
   8. MAP OF AUSTRALIA
   Simple linear projection over the box 112°E–154°E, 10°S–44°S:
   1 degree = 10 units, so the box is 420 wide and 340 high.
   ========================================================================= */
function project(lat, lon) {
  return { x: (lon - 112) * 10, y: (-10 - lat) * 10 };
}

/** [[lon, lat], ...] -> SVG path text */
function toPath(points, close) {
  const text = points.map((p, i) => {
    const xy = project(p[1], p[0]);
    return (i ? 'L' : 'M') + xy.x.toFixed(1) + ' ' + xy.y.toFixed(1);
  }).join(' ');
  return text + (close === false ? '' : ' Z');
}

// The coastline as [longitude, latitude] points, clockwise from Cape York.
// It is simplified on purpose (flat cartoon style).
const COAST = [
  [142.5, -10.7], [142.9, -11.8], [143.3, -12.8], [143.6, -14.0], [144.5, -14.3], [145.3, -15.0],
  [145.4, -16.4], [146.0, -17.5], [146.3, -18.8], [147.0, -19.3], [148.2, -20.0], [149.2, -21.1],
  [149.6, -22.3], [150.8, -22.6], [150.9, -23.5], [151.9, -24.1], [152.9, -25.2], [153.2, -26.0],
  [153.1, -27.3], [153.5, -28.2], [153.6, -28.8], [153.0, -30.5], [152.9, -31.6], [152.2, -32.6],
  [151.6, -33.1], [151.2, -33.9], [150.8, -34.9], [150.2, -36.0], [149.9, -37.1], [149.9, -37.6],
  [148.5, -37.8], [147.6, -38.0], [146.9, -38.6], [146.4, -39.1], [145.9, -38.7], [145.3, -38.5],
  [144.9, -37.9], [144.4, -38.3], [143.5, -38.8], [142.4, -38.4], [141.4, -38.4], [140.6, -38.0],
  [139.8, -37.1], [139.6, -36.1], [138.9, -35.6], [138.2, -35.7], [138.5, -34.8], [138.0, -34.2],
  [137.8, -35.1], [136.9, -35.3], [137.4, -34.2], [137.9, -33.2], [137.8, -32.6], [137.5, -33.1],
  [136.9, -33.8], [136.2, -34.4], [135.9, -34.9], [135.3, -34.6], [135.1, -33.9], [134.5, -33.1],
  [134.2, -32.7], [133.6, -32.1], [132.2, -32.0], [131.2, -31.5], [130.0, -31.6], [129.0, -31.7],
  [127.5, -32.2], [126.2, -32.3], [125.0, -32.8], [124.0, -33.5], [123.3, -33.9], [121.9, -33.9],
  [120.0, -33.9], [119.4, -34.4], [118.0, -35.0], [116.7, -35.0], [115.2, -34.4], [115.0, -33.6],
  [115.6, -33.4], [115.7, -32.0], [115.3, -30.8], [114.9, -29.6], [114.5, -28.5], [114.1, -27.5],
  [113.5, -26.6], [113.3, -26.0], [113.9, -26.3], [114.2, -25.8], [113.7, -24.9], [113.5, -24.0],
  [113.8, -22.8], [114.1, -21.8], [114.4, -22.4], [114.9, -21.7], [115.9, -21.1], [116.8, -20.6],
  [117.9, -20.5], [118.6, -20.3], [119.6, -20.0], [121.0, -19.5], [121.8, -18.5], [122.2, -17.9],
  [122.2, -17.0], [122.9, -16.4], [123.5, -17.3], [123.7, -16.4], [124.4, -16.3], [124.9, -15.3],
  [125.6, -14.5], [126.2, -14.2], [126.9, -13.8], [127.6, -14.2], [128.1, -14.7], [128.2, -15.2],
  [128.6, -14.8], [129.4, -14.9], [129.6, -14.2], [130.0, -13.4], [130.3, -12.7], [130.8, -12.4],
  [131.3, -12.1], [132.2, -12.2], [132.6, -11.6], [131.9, -11.3], [132.4, -11.1], [133.3, -11.7],
  [134.2, -12.0], [135.4, -12.1], [136.3, -11.9], [136.9, -12.3], [136.6, -13.2], [135.9, -13.6],
  [136.0, -14.3], [135.5, -14.8], [135.8, -15.3], [136.8, -15.9], [137.7, -16.2], [138.2, -16.7],
  [139.3, -17.4], [140.0, -17.7], [140.8, -17.5], [141.2, -16.3], [141.6, -15.0], [141.6, -13.8],
  [141.6, -12.9], [141.9, -12.2], [142.1, -11.1]
];
const TASMANIA = [
  [144.7, -40.7], [145.5, -40.9], [146.5, -41.1], [147.4, -41.0], [148.0, -40.8], [148.3, -41.3],
  [148.3, -42.2], [147.9, -43.0], [147.4, -43.2], [146.9, -43.6], [146.0, -43.5], [145.5, -42.9],
  [145.2, -42.2], [144.9, -41.4]
];
const KANGAROO_ISLAND = [[136.6, -35.8], [137.6, -35.6], [138.1, -35.85], [137.5, -36.05], [136.7, -36.0]];
const REEF_LINE = [
  [143.9, -11.5], [144.3, -13.2], [145.6, -14.6], [146.2, -16.3], [147.0, -18.0],
  [148.6, -19.3], [150.3, -20.5], [151.6, -21.8], [152.6, -23.2], [153.0, -24.3]
];

// State borders (simplified). Each state is a rough shape that is later
// "cut out" with the coastline, so only the land part is coloured.
const BORDER_QLD_NSW = [[141, -29], [149, -29], [150.5, -28.6], [151.9, -28.9], [152.5, -28.3], [153.55, -28.17]];
const BORDER_NSW_VIC = [[141, -34], [142.15, -34.2], [143.55, -35.34], [144.75, -36.13], [146.9, -36.08], [148.2, -36.8], [149.97, -37.5]];
const REGIONS = {
  'Western Australia': { shape: [[105, -5], [129, -5], [129, -45], [105, -45]], centre: [-25.5, 121.5] },
  'Northern Territory': { shape: [[129, -5], [138, -5], [138, -26], [129, -26]], centre: [-19.5, 133.5] },
  'South Australia': { shape: [[129, -26], [141, -26], [141, -45], [129, -45]], centre: [-30, 135] },
  'Queensland': {
    shape: [[138, -5], [160, -5], [160, -28.17]].concat(BORDER_QLD_NSW.slice().reverse(), [[141, -26], [138, -26]]),
    centre: [-24.5, 144.2]
  },
  'New South Wales': {
    shape: BORDER_QLD_NSW.concat([[160, -28.17], [160, -37.5]], BORDER_NSW_VIC.slice().reverse()),
    centre: [-32.3, 146.5]
  },
  'Victoria': { shape: BORDER_NSW_VIC.concat([[151, -37.5], [151, -41], [141, -41]]), centre: [-37, 144] },
  'Tasmania': { island: TASMANIA, centre: [-42, 146.6] },
  'Australian Capital Territory': { dot: [-35.45, 149.0], centre: [-35.45, 149.0] }
};

// Which part of the map is shown (x, y, width, height). Both are 16:9 like the big screen.
const VIEW_CENTRE = { x: -128, y: -20, w: 675.56, h: 380 };   // Australia in the middle
const VIEW_LEFT = { x: -70, y: -83, w: 900, h: 506.25 };      // Australia on the left, room for a list

let mapCounter = 0;

/**
 * Build a map. Returns { root, place(lat, lon, element), placeXY(x, y, element) }.
 * options.regions: [{ name, color }] – coloured states/territories
 * options.reef:    draw the Great Barrier Reef line
 */
function buildMap(view, options) {
  const opts = options || {};
  const clipId = 'coast-clip-' + (++mapCounter);
  const mainland = toPath(COAST);
  let svg = `<svg viewBox="${view.x} ${view.y} ${view.w} ${view.h}" aria-hidden="true">
    <defs><clipPath id="${clipId}"><path d="${mainland}"/></clipPath></defs>`;

  // Little waves in the ocean
  [[-95, 40], [-80, 290], [455, 190], [470, 20], [120, 330], [250, 345], [-40, 150], [440, 300]].forEach((w) => {
    svg += `<path class="wave" d="M${w[0]} ${w[1]} q8 -8 16 0 q8 8 16 0"/>`;
  });

  svg += `<path class="land" d="${mainland}"/><path class="land" d="${toPath(TASMANIA)}"/><path class="land" d="${toPath(KANGAROO_ISLAND)}"/>`;

  (opts.regions || []).forEach((region, i) => {
    const info = REGIONS[region.name];
    if (!info) return;
    const attrs = `class="region" data-region="${i}" fill="${region.color}"`;
    if (info.shape) svg += `<path ${attrs} d="${toPath(info.shape)}" clip-path="url(#${clipId})"/>`;
    if (info.island) svg += `<path ${attrs} d="${toPath(info.island)}"/>`;
    if (info.dot) {
      const xy = project(info.dot[0], info.dot[1]);
      svg += `<circle ${attrs} cx="${xy.x}" cy="${xy.y}" r="7"/>`;
    }
  });

  svg += `<path class="coast" d="${mainland}"/>`;
  if (opts.reef) svg += `<path class="reef" d="${toPath(REEF_LINE, false)}"/>`;
  svg += '<g class="route-layer"></g></svg>';

  const root = el('div', 'map');
  root.innerHTML = svg;

  const placeXY = (x, y, node) => {
    node.style.left = ((x - view.x) / view.w) * 100 + '%';
    node.style.top = ((y - view.y) / view.h) * 100 + '%';
    root.append(node);
    return node;
  };
  return {
    root: root,
    routeLayer: root.querySelector('.route-layer'),
    placeXY: placeXY,
    place: (lat, lon, node) => { const xy = project(lat, lon); return placeXY(xy.x, xy.y, node); }
  };
}

/** Find the region whose name starts the label, e.g. "Northern Territory (territory)". */
function regionOfLabel(label) {
  return Object.keys(REGIONS).find((name) => label.indexOf(name) === 0);
}

/* =========================================================================
   9. BIG-SCREEN VIEWS
   Every function builds one "view" element that showMain() puts on the screen.
   ========================================================================= */

function logoView() {
  const view = el('div', 'view view-logo');
  const logo = el('div', 'logo');
  fillLogo(logo);
  view.append(logo);
  return view;
}

function connectingView() {
  const view = el('div', 'view view-connecting');
  view.append(el('div', 'connecting-text', 'connecting...'));
  return view;
}

/** Gold banner, used for the last question and for safe levels. */
function bannerView(title, amount) {
  const view = el('div', 'view view-banner');
  view.append(el('div', 'banner-title', title), el('div', 'banner-amount', amount));
  for (let i = 0; i < 6; i++) view.append(el('span', 'sparkle sparkle-' + i, '✦'));
  return view;
}

/** The question (and later the Ask-the-Class bars). */
function questionView(q, number) {
  const view = el('div', 'view view-question');
  view.append(
    el('div', 'q-meta', 'Question ' + number + ' · ' + formatMoney(DATA.ladder[number - 1])),
    el('div', 'q-text', q.question)
  );
  const poll = el('div', 'poll');
  poll.id = 'poll';
  poll.hidden = true;
  view.append(poll);
  return view;
}

/** Road-trip map: the campervan drives from the previous stop to this one. */
async function travelTo(index) {
  const stops = DATA.questions.map((q) => q.stop);
  const to = stops[index];
  // For question 1 there is no previous stop: the van drives in from the outback.
  const from = index > 0 ? stops[index - 1]
    : { lat: Math.min(-12, to.lat + 4), lon: Math.max(114, to.lon - 6) };

  const view = el('div', 'view view-map view-travel');
  const map = buildMap(VIEW_CENTRE);
  view.append(map.root);

  // Dotted route: stops we have already visited, then the new part
  const visited = stops.slice(0, index).map((s) => [s.lon, s.lat]);
  let route = '';
  if (visited.length > 1) route += `<path class="route route-old" d="${toPath(visited, false)}"/>`;
  route += `<path class="route route-new" d="${toPath([[from.lon, from.lat], [to.lon, to.lat]], false)}"/>`;
  visited.forEach((p) => {
    const xy = project(p[1], p[0]);
    route += `<circle class="route-stop" cx="${xy.x}" cy="${xy.y}" r="5"/>`;
  });
  map.routeLayer.innerHTML = route;

  map.place(to.lat, to.lon, el('div', 'target'));
  const van = map.place(from.lat, from.lon, el('div', 'van'));
  van.innerHTML = VAN_SVG;
  if (to.lon < from.lon) van.classList.add('flip');   // drive to the left
  van.style.setProperty('--travel-time', SETTINGS.travelMs * SPEED + 'ms');
  // No stop name here: it could give away the answer.
  // The name is shown later on the fun-fact screen (see showFact).

  showMain(view);
  await wait(500);
  const goal = project(to.lat, to.lon);
  van.classList.add('driving');
  van.style.left = ((goal.x - VIEW_CENTRE.x) / VIEW_CENTRE.w) * 100 + '%';
  van.style.top = ((goal.y - VIEW_CENTRE.y) / VIEW_CENTRE.h) * 100 + '%';
  await wait(SETTINGS.travelMs);
  van.classList.remove('driving');
  await wait(700);
}

/* ---------- Fun-fact visuals (factScreen in questions.json) ---------- */

const STATE_COLORS = ['#f6b24a', '#e2703a', '#ffd166', '#c9502a', '#f08d5a', '#e8c06a'];
const TERRITORY_COLORS = ['#3fb8a6', '#7c8cf0'];

function factMapView(fact) {
  const view = el('div', 'view view-map view-fact');
  const labels = fact.showStates ? (fact.labels || []) : [];
  const regions = [];
  let stateCount = 0;
  let territoryCount = 0;

  // States and territories from `labels`
  labels.forEach((label) => {
    const name = regionOfLabel(label);
    const isTerritory = /territory/i.test(label);
    const color = isTerritory
      ? TERRITORY_COLORS[territoryCount++ % TERRITORY_COLORS.length]
      : STATE_COLORS[stateCount++ % STATE_COLORS.length];
    regions.push({ name: name, color: color, label: label });
  });
  // One highlighted state (e.g. Queensland)
  if (fact.highlightRegion && REGIONS[fact.highlightRegion]) {
    regions.push({ name: fact.highlightRegion, color: '#ff7a3d', highlight: true });
  }

  const map = buildMap(labels.length ? VIEW_LEFT : VIEW_CENTRE, { regions: regions, reef: fact.drawReefLine });
  view.append(map.root);

  // List of states next to the map
  if (labels.length) {
    const legend = el('ul', 'legend');
    regions.forEach((region, i) => {
      const item = el('li');
      item.dataset.region = String(i);
      const swatch = el('span', 'swatch');
      swatch.style.background = region.color;
      item.append(swatch, el('span', '', region.label));
      legend.append(item);
    });
    view.append(legend);
  }

  // Name of the highlighted state
  regions.filter((r) => r.highlight).forEach((region) => {
    const centre = REGIONS[region.name].centre;
    map.place(centre[0], centre[1], el('div', 'map-label region-label', region.name));
  });

  // Ocean names, e.g. "Indian Ocean (west)": the word in brackets says where it goes
  const oceanSpots = { west: [-62, 215], east: [466, 100], south: [105, 330], north: [210, -4] };
  (fact.oceanLabels || []).forEach((label) => {
    const match = /\((\w+)\)/.exec(label);
    const side = match && oceanSpots[match[1].toLowerCase()] ? match[1].toLowerCase() : 'south';
    map.placeXY(oceanSpots[side][0], oceanSpots[side][1], el('div', 'map-label ocean-label ocean-' + side, label));
  });

  // Pins
  (fact.pins || []).forEach((pin) => {
    const node = el('div', 'pin' + (pin.highlight ? ' highlight' : ''));
    node.append(el('span', 'pin-dot'), el('span', 'pin-label pos-right', pin.label));
    map.place(pin.lat, pin.lon, node);
  });

  return view;
}

/**
 * Tidy up the labels on a map (call after the view is on the screen):
 * - labels that stick out of the screen are pushed back in
 * - every pin label tries 8 places and takes the one that covers the least
 */
function arrangeMapLabels(view) {
  const frame = view.getBoundingClientRect();
  if (!frame.width) return;
  const overlap = (a, b) =>
    Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
    Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

  // Ocean and state names: keep them inside the screen
  const taken = [];
  view.querySelectorAll('.map-label').forEach((label) => {
    const box = label.getBoundingClientRect();
    const gap = frame.width * 0.012;
    if (box.left < frame.left + gap) label.style.marginLeft = frame.left + gap - box.left + 'px';
    if (box.right > frame.right - gap) label.style.marginLeft = frame.right - gap - box.right + 'px';
    taken.push({ pin: null, box: label.getBoundingClientRect() });
  });
  // The stop name in the bottom left corner
  view.querySelectorAll('.fact-stop').forEach((label) => taken.push({ pin: null, box: label.getBoundingClientRect() }));
  // The small video call sits in the top left corner
  taken.push({ pin: null, box: { left: frame.left, top: frame.top, right: frame.left + frame.width * 0.2, bottom: frame.top + frame.height * 0.36 } });

  const pins = Array.from(view.querySelectorAll('.map .pin'));
  pins.forEach((pin) => taken.push({ pin: pin, box: pin.querySelector('.pin-dot').getBoundingClientRect() }));
  pins.sort((a, b) => b.classList.contains('highlight') - a.classList.contains('highlight')); // highlighted pin first
  pins.forEach((pin) => {
    const label = pin.querySelector('.pin-label');
    let best = null;
    for (const position of ['pos-right', 'pos-left', 'pos-tl', 'pos-tr', 'pos-bl', 'pos-br', 'pos-bottom', 'pos-top']) {
      label.className = 'pin-label ' + position;
      const box = label.getBoundingClientRect();
      const outside = box.width * box.height - overlap(box, frame);
      const covered = taken.reduce((sum, other) => sum + (other.pin === pin ? 0 : overlap(box, other.box)), 0);
      const score = covered + outside * 10;
      if (!best || score < best.score) best = { position: position, score: score };
      if (score === 0) break;
    }
    label.className = 'pin-label ' + best.position;
    taken.push({ pin: null, box: label.getBoundingClientRect() });
  });
}

/** Light up the states one after another (map with `showStates`). */
function startRegionCycle(view) {
  const count = view.querySelectorAll('.legend li').length;
  if (!count) return;
  let i = -1;
  const step = () => {
    i = (i + 1) % count;
    view.querySelectorAll('.hot').forEach((node) => node.classList.remove('hot'));
    view.querySelectorAll('[data-region="' + i + '"]').forEach((node) => node.classList.add('hot'));
  };
  step();
  ui.cycleTimer = setInterval(step, Math.max(250, 1200 * SPEED));
}

function factPhotoView(fact, photoExists) {
  const view = el('div', 'view view-fact view-photo');
  const frame = el('div', 'polaroid');
  if (photoExists) {
    const img = el('img', 'photo');
    img.src = fact.image;
    img.alt = fact.caption || '';
    frame.append(img);
  } else {
    frame.append(fromMarkup(PHOTO_PLACEHOLDER_SVG));   // photo not there yet
  }
  frame.append(el('div', 'caption', fact.caption || ''));
  view.append(frame);
  return view;
}

/**
 * Drawn fun-fact pictures. The texts inside the pictures are read from the
 * `notes` in questions.json, so they are not written in this file.
 */
function factDrawnView(fact) {
  const view = el('div', 'view view-fact view-drawn scene-' + (fact.scene || 'none'));
  const notes = fact.notes || '';

  if (fact.scene === 'slang') {
    // Speech bubbles: every text in 'single quotes' after the colon
    const texts = [];
    const pattern = /'(.+?)'(?=,|$)/g;
    const list = notes.slice(notes.indexOf(':') + 1);
    let match;
    while ((match = pattern.exec(list))) texts.push(match[1]);
    const grill = el('div', 'grill');
    grill.innerHTML = BARBECUE_SVG;
    view.append(grill);
    texts.forEach((text, i) => view.append(el('div', 'bubble bubble-' + i, text)));

  } else if (fact.scene === 'australiaDay') {
    const dateMatch = /showing ([^;]+)/.exec(notes);            // "26 JANUARY 1788"
    const pinsMatch = /pins for (.+?) and (.+?)\s*$/.exec(notes); // "Botany Bay", "Sydney Cove"
    view.append(el('div', 'sea'), el('div', 'shore'));
    const ship = el('div', 'ship');
    ship.innerHTML = SHIP_SVG;
    view.append(ship);
    if (dateMatch) {
      const parts = dateMatch[1].trim().split(/\s+/);
      const calendar = el('div', 'calendar');
      calendar.append(
        el('div', 'calendar-month', parts[1] || ''),
        el('div', 'calendar-day', parts[0] || ''),
        el('div', 'calendar-year', parts.slice(2).join(' '))
      );
      view.append(calendar);
    }
    if (pinsMatch) {
      [pinsMatch[1], pinsMatch[2]].forEach((name, i) => {
        const pin = el('div', 'pin shore-pin shore-pin-' + i);
        pin.append(el('span', 'pin-dot'), el('span', 'pin-label ' + (i ? 'pos-top' : 'pos-left'), name));
        view.append(pin);
      });
    }
  }
  return view;
}

const imageCache = new Map();
/** Does this photo exist? (true / false) */
function loadImage(file) {
  if (!imageCache.has(file)) {
    imageCache.set(file, new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = file;
    }));
  }
  return imageCache.get(file);
}

/** The fun fact: zoom into the big screen, play the fact clip, zoom back out. */
async function showFact(q) {
  const fact = q.factScreen || {};
  let view;
  if (fact.type === 'map') {
    view = factMapView(fact);
  } else if (fact.type === 'photo') {
    const exists = fact.image ? await withTimeout(loadImage(fact.image), 3000, false) : false;
    view = factPhotoView(fact, exists);
  } else {
    view = factDrawnView(fact);
  }

  // Now the answer is known, so we can say where we are (stop.name).
  if (q.stop && q.stop.name) view.append(el('div', 'fact-stop', q.stop.name));

  // Texts inside the fact are sized so they are readable AFTER the zoom.
  const fontSize = factFontSize(computeZoom().scale) + 'px';
  view.style.fontSize = fontSize;
  $('screen').style.setProperty('--fact-font', fontSize);
  ui.factView = view;
  showMain(view);
  arrangeMapLabels(view);
  startRegionCycle(view);
  showCall(q.expert, 'pip');

  await zoomCamera(true);
  await say(q.clips.fact);
  await zoomCamera(false);

  clearInterval(ui.cycleTimer);
  hideCall();
  ui.factView = null;
}

/* =========================================================================
   10. ANSWERS, LIFELINES AND PRIZE LADDER
   ========================================================================= */

function clearAnswers() {
  const box = $('answers');
  box.textContent = '';
  box.classList.add('empty');
}

function renderAnswers(q) {
  const box = $('answers');
  box.textContent = '';
  box.classList.remove('empty');
  Object.keys(q.options).forEach((letter) => {
    const button = el('button', 'answer');
    button.type = 'button';
    button.dataset.letter = letter;
    button.disabled = true;
    button.append(el('span', 'letter', letter), el('span', 'answer-text', q.options[letter]));
    button.addEventListener('click', () => chooseAnswer(letter));
    box.append(button);
  });
}

const answerButton = (letter) => $('answers').querySelector('[data-letter="' + letter + '"]');

/** Enable or disable all buttons, depending on the state of the game. */
function updateControls() {
  const open = game.state === 'OPEN';
  $('answers').classList.toggle('closed', !open);
  $('answers').querySelectorAll('.answer').forEach((button) => {
    button.disabled = !open || game.removed.includes(button.dataset.letter);
  });
  Object.keys(game.used).forEach((kind) => {
    const button = $('ll-' + kind);
    button.disabled = !open || game.used[kind];
    button.classList.toggle('used', game.used[kind]);
  });
  $('btn-skip').disabled = !audio.current;
  $('btn-replay').disabled = !(audio.current || (open && audio.last));
}

/** Wait until the player has chosen an answer. Gives back the letter. */
function waitForAnswer() {
  return new Promise((resolve) => { game.answerResolver = resolve; });
}

function chooseAnswer(letter) {
  // Only once, only while answers are open, and not a removed answer.
  if (game.state !== 'OPEN' || !game.answerResolver || game.removed.includes(letter)) return;
  if (!answerButton(letter)) return;
  const resolve = game.answerResolver;
  game.answerResolver = null;
  resolve(letter);
}

/** Orange suspense, then green (correct) or red (wrong). */
async function lockIn(q, letter) {
  const chosen = answerButton(letter);
  chosen.classList.add('selected');
  sfx.lock();
  await wait(SETTINGS.suspenseMs);
  chosen.classList.remove('selected');
  if (letter === q.correct) {
    chosen.classList.add('correct');
    sfx.correct();
  } else {
    chosen.classList.add('wrong');
    answerButton(q.correct).classList.add('correct', 'flash');
    sfx.wrong();
  }
  await wait(900);
}

/* ---------- Lifelines ---------- */

// Chance that the class is wrong (a "trap"): 0.5 = 50 %.
const CLASS_TRAP_CHANCE = 0.5;

/**
 * Make up the votes of the class. Gives e.g. { A: 45, B: 30, C: 15, D: 10 }.
 * Every time, the class is either right or wrong (50:50 chance, see CLASS_TRAP_CHANCE):
 *   - trap:  one WRONG answer gets the most votes, the CORRECT answer comes second,
 *   - right: the CORRECT answer gets the most votes, one WRONG answer comes second,
 *   - all other answers get fewer votes than the top two,
 *   - answers removed by 50:50 get 0 %,
 *   - the numbers are whole percentages and add up to 100.
 * The numbers are first made for a trap; if the class is right, the top two swap.
 */
function makeClassVotes(q, removed) {
  const votes = makeTrapVotes(q, removed);
  const wrong = Object.keys(votes).filter((l) => l !== q.correct && votes[l] > 0);
  if (wrong.length && Math.random() >= CLASS_TRAP_CHANCE) {
    // The class is right: the correct answer swaps places with the most popular wrong answer.
    const winner = wrong.reduce((a, b) => (votes[b] > votes[a] ? b : a));
    [votes[q.correct], votes[winner]] = [votes[winner], votes[q.correct]];
  }
  return votes;
}

/** Votes where one wrong answer wins and the correct answer is second (see makeClassVotes). */
function makeTrapVotes(q, removed) {
  const letters = Object.keys(q.options);
  const wrong = shuffle(letters.filter((l) => l !== q.correct && !removed.includes(l)));
  const votes = {};
  letters.forEach((l) => { votes[l] = 0; });
  if (!wrong.length) { votes[q.correct] = 100; return votes; }   // (cannot happen with 4 answers)

  const winner = wrong[0];          // the wrong answer the class likes most
  const others = wrong.slice(1);    // the other wrong answers (none after 50:50)

  // After 50:50 only two answers are left: winner 55-70 %, correct answer gets the rest (30-45 %).
  if (!others.length) {
    votes[winner] = randInt(55, 70);
    votes[q.correct] = 100 - votes[winner];
    return votes;
  }

  // Four answers: winner 38-52 %, second place 25 % up to 6 points below the winner,
  // every other answer at least 4 % and at least 5 points below second place.
  for (let attempt = 0; attempt < 50; attempt++) {
    const top = randInt(38, 52);
    const second = randInt(25, top - 6);
    let rest = 100 - top - second;
    const shares = [];
    for (let i = 0; i < others.length; i++) {
      const left = others.length - 1 - i;                 // answers still waiting for a share
      const low = Math.max(4, rest - (second - 5) * left);
      const high = Math.min(second - 5, rest - 4 * left);
      if (low > high) break;                              // does not fit: try new numbers
      const share = left ? randInt(low, high) : rest;
      shares.push(share);
      rest -= share;
    }
    if (shares.length !== others.length || rest !== 0) continue;
    votes[winner] = top;
    votes[q.correct] = second;
    others.forEach((l, i) => { votes[l] = shares[i]; });
    return votes;
  }

  // Safety net (never needed in practice): a fixed, valid result.
  const fixed = [45, 30, 15, 10];
  votes[winner] = fixed[0];
  votes[q.correct] = fixed[1];
  const restShare = Math.floor(25 / others.length);
  others.forEach((l, i) => { votes[l] = i ? restShare : 25 - restShare * (others.length - 1); });
  return votes;
}

const LIFELINES = {
  /** 50:50 – take away two wrong answers. */
  async fiftyFifty(q) {
    await say(DATA.extras.fiftyFifty);
    const wrong = Object.keys(q.options).filter((l) => l !== q.correct);
    const remove = shuffle(wrong).slice(0, 2);
    game.removed = remove;
    remove.forEach((letter) => answerButton(letter).classList.add('removed'));
    await wait(700);
  },

  /** Ask the Class – four bars grow on the big screen. */
  async askClass(q) {
    await say(DATA.extras.askClass);
    game.votes = makeClassVotes(q, game.removed);
    const poll = $('poll');
    if (!poll) return;
    poll.textContent = '';
    poll.hidden = false;
    const highest = Math.max.apply(null, Object.values(game.votes));
    const bars = [];
    Object.keys(q.options).forEach((letter) => {
      const column = el('div', 'poll-column');
      const track = el('div', 'poll-track');
      const bar = el('div', 'poll-bar');
      const percent = el('div', 'poll-percent', game.votes[letter] + '%');
      track.append(bar);
      column.append(percent, track, el('div', 'poll-letter', letter));
      poll.append(column);
      bars.push({ bar: bar, percent: percent, height: (game.votes[letter] / highest) * 100 });
    });
    for (const item of bars) {      // one bar after another
      void item.bar.offsetWidth;
      item.bar.style.height = item.height + '%';
      item.percent.classList.add('shown');
      await wait(500);
    }
    await wait(400);
  },

  /** Phone a Friend – ringing phone, then the expert with a phone. */
  async phone(q) {
    const ring = el('div', 'ring');
    ring.innerHTML = '<div class="ring-icon">' + PHONE_SVG + '</div>';
    $('screen').append(ring);
    sfx.ring();
    await say(DATA.extras.phone);
    ring.remove();
    showCall(q.phoneFriend, 'full', { phone: true, slide: true });
    await wait(500);
    await say(q.clips.phone);
    hideCall();
    await wait(300);
  }
};

async function useLifeline(kind) {
  if (game.state !== 'OPEN' || game.used[kind]) return;
  game.used[kind] = true;
  setState('LIFELINE');
  try {
    await LIFELINES[kind](currentQuestion());
  } finally {
    setState('OPEN');
    showHint('Choose your answer.');
  }
}

/* ---------- Prize ladder ---------- */

function buildLadder() {
  const list = $('ladder-list');
  list.textContent = '';
  DATA.ladder.forEach((amount, i) => {
    const step = el('li', 'step');
    step.dataset.step = String(i + 1);
    if (DATA.safeLevels.includes(i + 1)) step.classList.add('safe');
    step.append(el('span', 'step-number', String(i + 1)), el('span', 'step-amount', formatMoney(amount)));
    list.append(step);
  });
}

/** current = number of the question being played (1-12), 0 = none. */
function updateLadder(current, passedUpTo) {
  $('ladder-list').querySelectorAll('.step').forEach((step) => {
    const number = Number(step.dataset.step);
    step.classList.toggle('current', number === current);
    step.classList.toggle('passed', number <= passedUpTo);
    if (number === current) step.setAttribute('aria-current', 'step'); else step.removeAttribute('aria-current');
  });
}

function setLadderOpen(open) {
  $('ladder').classList.toggle('open', open);
  $('btn-prizes').setAttribute('aria-expanded', String(open));
}

/* =========================================================================
   11. GAME FLOW
   ========================================================================= */

/** Lights on, Max walks in, the three intro clips. */
async function playIntro() {
  await wait(400);
  await lightsOn();
  await hostWalkIn();
  showMain(logoView());

  let connected = false;
  for (const clip of DATA.intro) {
    const info = DATA.cast[clip.speaker] || {};
    if (info.role === 'host') {
      await say(clip);
      continue;
    }
    // An expert: first the "connecting..." effect, then they slide into the video call.
    if (!connected) {
      showMain(connectingView());
      $('screen').classList.add('flicker');
      await wait(1300);
      $('screen').classList.remove('flicker');
      connected = true;
    }
    showCall(clip.speaker, 'full', { slide: true });
    $('call').classList.add('waving');
    setTimeout(() => $('call').classList.remove('waving'), 2200);
    await wait(500);
    await say(clip);
  }
  hideCall();
  await wait(400);
}

/** One complete question. Gives back true if the answer was correct. */
async function playQuestion(index) {
  const q = DATA.questions[index];
  const number = index + 1;
  const isLast = number === DATA.questions.length;

  // --- TRAVEL ---
  setState('TRAVEL');
  game.index = index;
  game.removed = [];
  game.votes = null;
  clearAnswers();
  updateLadder(number, number - 1);
  preloadQuestion(index);
  if (isLast) {
    showMain(bannerView('Question ' + number, formatMoney(DATA.ladder[index])));
    await say(DATA.extras.final);
  }
  await travelTo(index);

  // --- ASK: Max reads the question, answers are visible but locked ---
  setState('ASK');
  showMain(questionView(q, number));
  renderAnswers(q);
  updateControls();
  await say(q.clips.host);

  // --- OPEN: the player can answer or use a lifeline ---
  setState('OPEN');
  showHint('Choose your answer.');
  const letter = await waitForAnswer();

  // --- LOCKED ---
  setState('LOCKED');
  showHint('');
  await lockIn(q, letter);
  const correct = letter === q.correct;

  // --- REACTION: the expert says why it was right or wrong ---
  setState('REACTION');
  showCall(q.expert, 'full', { slide: true });
  await wait(400);
  await say(correct ? q.clips.correct : q.clips.wrong[letter]);

  // --- FACT: always, with the zoom into the big screen ---
  setState('FACT');
  await showFact(q);

  if (correct) game.correctCount = number;
  return correct;
}

/** A safe level was reached: the ladder step flashes gold. */
async function celebrateSafeLevel(number) {
  const step = $('ladder-list').querySelector('[data-step="' + number + '"]');
  if (step) step.classList.add('flash-gold');
  showMain(bannerView('Safe level', formatMoney(DATA.ladder[number - 1])));
  sfx.correct();
  await say(DATA.extras.safe);
  if (step) step.classList.remove('flash-gold');
}

async function playGameOver() {
  clearAnswers();
  showMain(logoView());
  $('stage').classList.add('dim');
  $('host').classList.add('waving');
  await say(DATA.extras.gameOver);
  $('host').classList.remove('waving');
  await wait(500);
  showResult(false);
}

async function playWin() {
  clearAnswers();
  updateLadder(0, DATA.ladder.length);
  const banner = bannerView(DATA.title, formatMoney(DATA.ladder[DATA.ladder.length - 1]));
  banner.classList.add('banner-top');     // Max stands in front of the lower part of the screen
  showMain(banner);
  startConfetti();
  $('host').classList.remove('seated');
  $('host').classList.add('cheering');
  await say(DATA.extras.winner);
  await wait(800);
  $('host').classList.remove('cheering');
  showResult(true);
}

/** The whole show from the first light to the result screen. */
async function runGame() {
  setState('INTRO');
  game.correctCount = 0;
  game.used = { fiftyFifty: false, askClass: false, phone: false };
  game.removed = [];
  $('start-screen').hidden = true;
  $('result-screen').hidden = true;
  setLadderOpen(false);
  resetStudio();
  updateLadder(0, 0);
  updateControls();
  preload(DATA.intro.concat([DATA.questions[0].clips.host]));

  const firstIndex = Math.min(START_AT, DATA.questions.length) - 1;
  if (firstIndex > 0) {
    // Testing shortcut (?q=5): no intro, pretend the earlier questions were right.
    game.correctCount = firstIndex;
    await lightsOn();
    $('host').classList.add('no-anim', 'seated');
    $('host').classList.remove('offstage');
    void $('host').offsetWidth;
    $('host').classList.remove('no-anim');
  } else {
    await playIntro();
  }

  for (let index = firstIndex; index < DATA.questions.length; index++) {
    const correct = await playQuestion(index);
    const number = index + 1;
    if (!correct) {
      setState('GAMEOVER');
      await playGameOver();
      return;
    }
    if (number === DATA.questions.length) {
      setState('WIN');
      await playWin();
      return;
    }
    setState('NEXT');
    updateLadder(0, number);
    if (DATA.safeLevels.includes(number)) await celebrateSafeLevel(number);
  }
}

/* =========================================================================
   12. RESULT AND CREDITS SCREENS
   ========================================================================= */

/** Prize money: the last safe level that was reached, or everything for a winner. */
function prizeWon(won) {
  if (won) return DATA.ladder[DATA.ladder.length - 1];
  const reached = DATA.safeLevels.filter((level) => level <= game.correctCount);
  return reached.length ? DATA.ladder[Math.max.apply(null, reached) - 1] : 0;
}

function showResult(won) {
  $('result-title').textContent = won ? 'Winner!' : 'Game over';
  $('result-amount').textContent = formatMoney(prizeWon(won));
  $('result-score').textContent = 'Correct answers: ' + game.correctCount + ' of ' + DATA.questions.length;
  $('result-screen').classList.toggle('won', won);
  $('result-screen').hidden = false;
  $('btn-again').focus();
}

let creditsCameFrom = null;

function showCredits(fromScreen) {
  const isMissing = (value) => !value || /^\s*TODO/i.test(String(value));
  const list = $('credits-list');
  list.textContent = '';
  (DATA.photoCredits || []).forEach((credit) => {
    const item = el('li');
    item.append(el('strong', '', String(credit.image || '').replace(/^images\//, '')));
    const details = el('div', 'credit-details');
    if (isMissing(credit.author) && isMissing(credit.license) && isMissing(credit.source)) {
      details.append(el('span', 'credit-missing', 'Credit missing'));
    } else {
      [['Author', credit.author], ['Licence', credit.license], ['Source', credit.source]].forEach((pair) => {
        const row = el('div');
        row.append(el('span', 'credit-key', pair[0] + ': '));
        if (isMissing(pair[1])) {
          row.append(el('span', 'credit-missing', 'Credit missing'));
        } else if (/^https?:\/\//i.test(pair[1])) {
          const link = el('a', '', pair[1]);
          link.href = pair[1];
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          row.append(link);
        } else {
          row.append(pair[1]);
        }
        details.append(row);
      });
    }
    item.append(details);
    list.append(item);
  });
  creditsCameFrom = fromScreen;
  fromScreen.hidden = true;
  $('credits-screen').hidden = false;
  $('btn-credits-back').focus();
}

function hideCredits() {
  $('credits-screen').hidden = true;
  if (creditsCameFrom) creditsCameFrom.hidden = false;
}

/* =========================================================================
   13. BUTTONS AND KEYBOARD
   ========================================================================= */
function connectButtons() {
  $('btn-start').addEventListener('click', () => {
    if (game.state !== 'START') return;
    sfx.init();           // sound is only allowed after a tap
    unlockAudio();
    runGame().catch(showError);
  });
  $('btn-again').addEventListener('click', () => {
    if (game.state !== 'GAMEOVER' && game.state !== 'WIN') return;
    sfx.init();
    unlockAudio();
    runGame().catch(showError);
  });

  $('btn-credits-start').addEventListener('click', () => showCredits($('start-screen')));
  $('btn-credits').addEventListener('click', () => showCredits($('result-screen')));
  $('btn-credits-back').addEventListener('click', hideCredits);

  $('btn-skip').addEventListener('click', skipClip);
  $('btn-replay').addEventListener('click', () => { replayClip().catch(showError); });
  $('btn-mute').addEventListener('click', () => setMuted(!audio.muted));
  $('btn-subs').addEventListener('click', () => setSubtitles(!audio.subtitles));

  Object.keys(game.used).forEach((kind) => {
    $('ll-' + kind).addEventListener('click', () => { useLifeline(kind).catch(showError); });
  });

  $('btn-prizes').addEventListener('click', () => setLadderOpen(!$('ladder').classList.contains('open')));
  $('btn-ladder-close').addEventListener('click', () => setLadderOpen(false));

  // Keyboard: A/B/C/D or 1-4 = answer, Space = Skip
  let spaceHandled = false;
  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const overlayOpen = !$('start-screen').hidden || !$('result-screen').hidden || !$('credits-screen').hidden;
    if (overlayOpen) return;
    if (event.key === ' ' || event.code === 'Space') {
      if (audio.current) {
        event.preventDefault();      // don't scroll, don't "click" a focused button
        spaceHandled = true;
        if (!event.repeat) skipClip();
      }
      return;
    }
    if (event.repeat || game.state !== 'OPEN') return;
    const letters = Object.keys(currentQuestion().options);
    const key = event.key.toUpperCase();
    if (letters.includes(key)) chooseAnswer(key);
    else if (/^[1-9]$/.test(key) && letters[Number(key) - 1]) chooseAnswer(letters[Number(key) - 1]);
  });
  document.addEventListener('keyup', (event) => {
    if ((event.key === ' ' || event.code === 'Space') && spaceHandled) {
      event.preventDefault();
      spaceHandled = false;
    }
  });

  // Keep the stage layout right when the window or phone is turned.
  window.addEventListener('resize', layoutStage);
  if (window.ResizeObserver) new ResizeObserver(layoutStage).observe($('stage'));

  // No hum in a hidden browser tab.
  document.addEventListener('visibilitychange', () => {
    if (!sfx.ctx) return;
    if (document.hidden) sfx.ctx.suspend(); else sfx.ctx.resume();
  });
}

function showError(error) {
  console.error(error);
  showHint('Something went wrong. Please reload the page.');
}

/* =========================================================================
   14. START-UP
   ========================================================================= */
async function boot() {
  connectButtons();
  if (FAST) document.documentElement.classList.add('fast');
  try {
    // no-cache: always ask the server for the newest questions.json
    const response = await fetch('questions.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error('questions.json: ' + response.status);
    DATA = await response.json();
  } catch (error) {
    const message = $('load-error');
    message.textContent = 'Could not load questions.json. Start a local web server ' +
      '(python3 -m http.server) and open http://localhost:8000 – see README.md.';
    message.hidden = false;
    $('btn-start').textContent = 'Not ready';
    return;
  }

  buildStudio();
  buildLadder();
  layoutStage();

  let muted = false;
  try { muted = localStorage.getItem('aussie-muted') === '1'; } catch (e) { /* private mode */ }
  setMuted(muted);

  setState('START');
  $('btn-start').textContent = 'Start';
  $('btn-start').disabled = false;
  $('btn-start').focus();
}

boot();
