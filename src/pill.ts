import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { attachRecorder, pretty } from "./recorder";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const shell = $("shell");
const playBtn = $<HTMLButtonElement>("play");
const stopBtn = $<HTMLButtonElement>("stop");
const speedBtn = $<HTMLButtonElement>("speed");
const volBtn = $<HTMLButtonElement>("volume-btn");
const expandBtn = $<HTMLButtonElement>("expand");
const minBtn = $<HTMLButtonElement>("min");
const textEl = $("text");
const metaEl = $("meta");

type Status = "idle" | "speaking" | "paused";
type OcrResult = { text: string | null; error: string | null };
type Word = { el: HTMLSpanElement; start: number; end: number };
type Tab = "transcript" | "history" | "settings";

const WIN = { collapsed: { w: 340, h: 56 }, expanded: { w: 440, h: 540 } };
// The built-in macOS voice runs from about 0.5x to 4x (measured), so the slider tops out at 4x.
// 0x means "paused". Values near 1x snap to exactly 1x.
const MAX_SPEED = 4;
const MAGNET = 0.12;
const POP_H = 146; // keep in sync with .speedpop height in pill.css

let text = "";
let words: Word[] = [];
let status: Status = "idle";
let speed = 1;
let volume = 100; // percent, 0 = muted
let voice: string | null = null;
let cursor = 0; // UTF-16 offset of the word being spoken (restart point)
let nowIndex = -1;
let previewing = false; // a voice sample is playing: don't highlight the transcript
let expanded = false;
let tab: Tab = "transcript";
type PopName = "speed" | "volume";
let openPop: PopName | null = null;
let lastVolume = 100;
let volumeDirty = false; // volume changed while paused: restart on resume
let lastSpeed = 1; // restored when you press play while the speed is 0x
let zeroPaused = false; // reading was paused because the speed was set to 0x

// ------------------------------------------------------------------ window

let resizeToken = 0;
/** Smoothly resize the native window (top-left stays put, so it grows downward). */
async function resizeTo(w: number, h: number) {
  const win = getCurrentWindow();
  const token = ++resizeToken;
  const from = { w: window.innerWidth, h: window.innerHeight };
  const steps = 9;
  for (let i = 1; i <= steps; i++) {
    if (token !== resizeToken) return; // superseded by a newer resize
    const t = 1 - Math.pow(1 - i / steps, 3); // ease-out
    await win.setSize(new LogicalSize(from.w + (w - from.w) * t, from.h + (h - from.h) * t));
    await new Promise((r) => setTimeout(r, 12));
  }
}

/** Window size for the current state: pill or drawer, plus room for the speed dropdown. */
function syncWindow() {
  const base = expanded ? WIN.expanded : WIN.collapsed;
  return resizeTo(base.w, base.h + (openPop ? POP_H : 0));
}

async function setExpanded(open: boolean) {
  if (open === expanded) return;
  expanded = open;
  document.getElementById("ic-expand")!.toggleAttribute("hidden", open);
  document.getElementById("ic-collapse")!.toggleAttribute("hidden", !open);
  if (open) {
    shell.classList.add("expanded");
    await syncWindow();
  } else {
    await syncWindow();
    if (!expanded) shell.classList.remove("expanded");
  }
}

function setTab(next: Tab) {
  tab = next;
  document.querySelectorAll<HTMLButtonElement>("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === next));
  for (const t of ["transcript", "history", "settings"]) $(`panel-${t}`).hidden = t !== next;
  if (next === "history") refreshHistory();
  if (next === "settings") refreshSettings();
}

async function openTab(next: Tab) {
  setTab(next);
  await setExpanded(true);
}

expandBtn.addEventListener("click", () => setExpanded(!expanded));
minBtn.addEventListener("click", () => getCurrentWindow().hide()); // keeps speaking
document.querySelectorAll<HTMLButtonElement>("#tabs button").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab as Tab)));
listen<Tab>("pill-open-tab", (e) => openTab(e.payload));

// ------------------------------------------------------------- transcript

/** Split text into clickable word spans; offsets are UTF-16 (the TTS engine's unit). */
function renderTranscript(t: string) {
  textEl.className = "transcript";
  textEl.textContent = "";
  words = [];
  nowIndex = -1;
  let last = 0;
  for (const m of t.matchAll(/\S+/g)) {
    const start = m.index ?? 0;
    if (start > last) textEl.append(t.slice(last, start)); // keep spaces and line breaks
    const el = document.createElement("span");
    el.className = "w";
    el.textContent = m[0];
    el.addEventListener("click", () => speakFrom(start));
    textEl.append(el);
    words.push({ el, start, end: start + m[0].length });
    last = start + m[0].length;
  }
  if (last < t.length) textEl.append(t.slice(last));
  textEl.scrollTop = 0;
}

function showMessage(msg: string, cls: "muted" | "error") {
  text = "";
  words = [];
  nowIndex = -1;
  textEl.className = `transcript ${cls}`;
  textEl.textContent = msg;
  metaEl.innerHTML = "&nbsp;";
  updateButtons();
}

/** Karaoke-style: words already spoken are bright, the current word is highlighted. */
function paint(index: number) {
  nowIndex = index;
  words.forEach((w, k) => {
    w.el.classList.toggle("read", index >= 0 && k < index);
    w.el.classList.toggle("now", k === index);
  });
  renderMeta();
  if (index >= 0) {
    cursor = words[index].start;
    words[index].el.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

let metaLabel = "";

/** "Snipped 2:41 PM · 6/9 words": which word is being spoken, out of the total. */
function renderMeta() {
  const n = words.length;
  const count = nowIndex >= 0 ? `${nowIndex + 1}/${n}` : `${n}`;
  metaEl.textContent = `${metaLabel} · ${count} word${n === 1 ? "" : "s"}`;
}

function setMeta(label: string) {
  metaLabel = label;
  renderMeta();
}

// --------------------------------------------------------------- playback

function updateButtons() {
  const has = text.trim() !== "";
  playBtn.disabled = !has;
  stopBtn.disabled = !has || status === "idle";
  document.getElementById("ic-play")!.toggleAttribute("hidden", status === "speaking");
  document.getElementById("ic-pause")!.toggleAttribute("hidden", status !== "speaking");
  shell.classList.toggle("speaking", status === "speaking");
  shell.classList.toggle("paused", status === "paused");
}

const fmt = (v: number) => String(Math.round(v * 100) / 100);

function speedLabel() {
  $("speed-label").textContent = `${fmt(speed)}×`;
}

function speakFrom(offset: number) {
  if (!text) return;
  if (speed === 0) setSpeed(lastSpeed || 1, "play"); // pressing play at 0x resumes at your last speed
  zeroPaused = false;
  volumeDirty = false;
  previewing = false;
  cursor = offset;
  invoke("tts_speak", { text, offset, speed, volume: volume / 100, voice }).catch((e) => showMessage(String(e), "error"));
}

playBtn.addEventListener("click", async () => {
  if (status === "speaking") await invoke("tts_pause");
  else if (status === "paused") {
    // Paused by the 0x slider: resume at your last speed from the current word.
    if (speed === 0 || zeroPaused || volumeDirty) speakFrom(cursor);
    else await invoke("tts_resume");
  }
  else speakFrom(0);
});

stopBtn.addEventListener("click", async () => {
  await invoke("tts_stop");
  cursor = 0;
  paint(-1);
});

// ------------------------------------------------------------ speed dropdown

const pop = $("speedpop");
const range = $<HTMLInputElement>("speed-range");
const speedInput = $<HTMLInputElement>("speed-input");
const notch = $("notch");
const speedNote = $("speed-note");
const NOTE_DEFAULT = "Drag, scroll sideways, or type. Snaps to 1×.";

// Tick labels (0, 1×, 2, 3, 4) and the 1× magnet notch, positioned along the track.
const ticks = $("ticks");
for (let v = 0; v <= MAX_SPEED; v++) {
  const s = document.createElement("span");
  s.textContent = v === 1 ? "1×" : String(v);
  if (v === 1) s.className = "m";
  s.style.left = `${(v / MAX_SPEED) * 100}%`;
  ticks.append(s);
}
notch.style.left = `${(1 / MAX_SPEED) * 100}%`; // the 1x detent sits inside the rail
const railFill = $("rail-fill");

function setNote(msg: string, error = false) {
  speedNote.textContent = msg;
  speedNote.classList.toggle("error", error);
}

/** Update the UI for a speed. `src` says where it came from; the slider snaps to 1×,
 *  typed values stay exact. Does NOT restart speech: see `applySpeed`. */
function setSpeed(v: number, src: "slide" | "type" | "play" | "init") {
  v = Math.min(MAX_SPEED, Math.max(0, v));
  if (src === "slide" && Math.abs(v - 1) < MAGNET) v = 1;
  speed = v;
  if (v > 0) lastSpeed = v;
  range.value = String(v);
  if (src !== "type") speedInput.value = fmt(v);
  speedLabel();
  railFill.style.width = `${(v / MAX_SPEED) * 100}%`;
  notch.classList.toggle("passed", v >= 1);
  notch.classList.toggle("on", v === 1);
  if (v === 0) setNote("0× pauses reading. Slide up to resume.");
  else if (v === 1) setNote("Normal speed.");
  else if (v < 0.5) setNote("The slowest this voice speaks is about 0.5×.");
  else setNote(NOTE_DEFAULT);
}

/** Make the voice follow the chosen speed (pause at 0x; otherwise restart from the current word,
 *  since the speech rate can't change mid-sentence) and remember it. */
let applyTimer: number | undefined;
function applySpeed() {
  clearTimeout(applyTimer);
  invoke("set_pref", { key: "speed", value: speed });
  if (previewing) return;
  if (speed === 0) {
    if (status === "speaking") {
      zeroPaused = true;
      invoke("tts_pause");
    }
  } else if (zeroPaused || status !== "idle") {
    zeroPaused = false;
    speakFrom(cursor);
  }
}

range.addEventListener("input", () => {
  setSpeed(parseFloat(range.value), "slide"); // live label while dragging
  clearTimeout(applyTimer);
  applyTimer = window.setTimeout(applySpeed, 350); // apply once the slider settles
});
range.addEventListener("change", applySpeed);

function commitTyped() {
  const v = parseFloat(speedInput.value.replace(",", ".").replace("×", ""));
  if (Number.isNaN(v) || v < 0 || v > MAX_SPEED) {
    setNote(`Enter a speed from 0 to ${MAX_SPEED}.`, true);
    return;
  }
  setSpeed(v, "type");
  speedInput.value = fmt(speed);
  applySpeed();
}
speedInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    commitTyped();
    speedInput.blur();
  }
});
speedInput.addEventListener("blur", commitTyped);
speedInput.addEventListener("input", () => speedNote.classList.remove("error"));

// Sideways trackpad scroll over the dropdown nudges the speed.
pop.addEventListener(
  "wheel",
  (e) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    e.preventDefault();
    setSpeed(parseFloat(range.value) + e.deltaX * 0.01, "slide");
    clearTimeout(applyTimer);
    applyTimer = window.setTimeout(applySpeed, 350);
  },
  { passive: false },
);

// ----------------------------------------------------------- volume dropdown

const volPop = $("volpop");
const volRange = $<HTMLInputElement>("vol-range");
const volInput = $<HTMLInputElement>("vol-input");
const volFill = $("vol-fill");
const volNote = $("vol-note");
const VOL_NOTE = "Drag, scroll sideways, or type a percent.";

const volTicks = $("vol-ticks");
for (const p of [0, 25, 50, 75, 100]) {
  const t = document.createElement("span");
  t.textContent = p === 100 ? "100%" : String(p);
  t.style.left = `${p}%`;
  volTicks.append(t);
}

function setVolNote(msg: string, error = false) {
  volNote.textContent = msg;
  volNote.classList.toggle("error", error);
}

/** Speaker icon follows the level: muted, one wave, or two waves. */
function volumeIcon() {
  document.getElementById("ic-vol")!.toggleAttribute("hidden", volume === 0);
  document.getElementById("ic-mute")!.toggleAttribute("hidden", volume !== 0);
  document.getElementById("wave2")!.style.display = volume < 50 ? "none" : "";
}

function setVolume(v: number, src: "slide" | "type" | "init") {
  v = Math.round(Math.min(100, Math.max(0, v)));
  volume = v;
  if (v > 0) lastVolume = v;
  volRange.value = String(v);
  if (src !== "type") volInput.value = String(v);
  volFill.style.width = `${v}%`;
  volumeIcon();
  if (v === 0) setVolNote("Muted. Slide up to hear it again.");
  else if (v === 100) setVolNote("Full volume.");
  else setVolNote(VOL_NOTE);
}

/** Utterance volume can't change mid-sentence either: restart from the current word. */
let volTimer: number | undefined;
function applyVolume() {
  clearTimeout(volTimer);
  invoke("set_pref", { key: "volume", value: volume });
  if (previewing) return;
  if (status === "speaking") speakFrom(cursor);
  else if (status === "paused") volumeDirty = true;
}

volRange.addEventListener("input", () => {
  setVolume(parseFloat(volRange.value), "slide");
  clearTimeout(volTimer);
  volTimer = window.setTimeout(applyVolume, 350);
});
volRange.addEventListener("change", applyVolume);

function commitVolume() {
  const v = parseFloat(volInput.value.replace(",", ".").replace("%", ""));
  if (Number.isNaN(v) || v < 0 || v > 100) {
    setVolNote("Enter a volume from 0 to 100.", true);
    return;
  }
  setVolume(v, "type");
  volInput.value = String(volume);
  applyVolume();
}
volInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    commitVolume();
    volInput.blur();
  }
});
volInput.addEventListener("blur", commitVolume);
volInput.addEventListener("input", () => volNote.classList.remove("error"));

volPop.addEventListener(
  "wheel",
  (e) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    e.preventDefault();
    setVolume(parseFloat(volRange.value) + e.deltaX * 0.5, "slide");
    clearTimeout(volTimer);
    volTimer = window.setTimeout(applyVolume, 350);
  },
  { passive: false },
);

// ------------------------------------------------- dropdown open/close (one at a time)

const POPS: Record<PopName, { el: HTMLElement; btn: HTMLButtonElement }> = {
  speed: { el: pop, btn: speedBtn },
  volume: { el: volPop, btn: volBtn },
};

async function setPop(next: PopName | null) {
  if (next === openPop) return;
  const prev = openPop;
  openPop = next;
  for (const [name, p] of Object.entries(POPS) as [PopName, (typeof POPS)[PopName]][]) {
    p.btn.setAttribute("aria-expanded", String(name === next));
    if (name === next) p.el.hidden = false;
    else if (prev === name && next !== null) p.el.hidden = true; // switching: swap in place
  }
  await syncWindow();
  if (!openPop) for (const p of Object.values(POPS)) p.el.hidden = true;
}

speedBtn.addEventListener("click", () => setPop(openPop === "speed" ? null : "speed"));
volBtn.addEventListener("click", () => setPop(openPop === "volume" ? null : "volume"));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && openPop) setPop(null);
});
// Clicking anywhere outside the open dropdown and the two buttons closes it.
document.addEventListener("mousedown", (e) => {
  const t = e.target as Node;
  if (!openPop) return;
  const inside = Object.values(POPS).some((p) => p.el.contains(t) || p.btn.contains(t));
  if (!inside) setPop(null);
});

listen<Status>("tts-state", (e) => {
  status = e.payload;
  if (status === "idle") {
    paint(-1);
    previewing = false;
    zeroPaused = false;
  }
  updateButtons();
});

listen<{ start: number; length: number }>("tts-word", (e) => {
  if (previewing) return;
  const i = words.findIndex((w) => e.payload.start >= w.start && e.payload.start < w.end);
  if (i >= 0 && i !== nowIndex) paint(i);
});

// ------------------------------------------------------------ snip intake

function timeLabel(ms: number) {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function loadText(t: string, label: string, autoplay: boolean) {
  text = t;
  renderTranscript(t);
  setMeta(label);
  updateButtons();
  if (autoplay) speakFrom(0);
}

listen("snip-captured", async () => {
  await invoke("tts_stop").catch(() => {});
  paint(-1);
  shell.classList.add("reading");
  showMessage("Reading text…", "muted");
});

listen<OcrResult>("snip-text", async (e) => {
  shell.classList.remove("reading");
  const r = e.payload;
  if (r.error) {
    showMessage(r.error, "error");
    await openTab("transcript"); // problems must be visible, even from the compact pill
  } else if (!r.text || r.text.trim() === "") {
    showMessage("No text found in this snip. Try selecting a larger or clearer area.", "muted");
    await openTab("transcript");
  } else {
    loadText(r.text, `Snipped ${timeLabel(Date.now())}`, true);
  }
  if (tab === "history") refreshHistory();
});

// ---------------------------------------------------------------- history

type HistoryItem = { id: number; preview: string; words: number };

async function refreshHistory() {
  const list = $("history-list");
  const items = await invoke<HistoryItem[]>("history_list");
  list.textContent = "";
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No snips yet. Your snipped text will show up here.";
    list.append(empty);
    return;
  }
  for (const it of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "item";
    const t = document.createElement("div");
    t.className = "t";
    t.textContent = it.preview;
    const m = document.createElement("div");
    m.className = "m";
    m.textContent = `${timeLabel(it.id)} · ${it.words} word${it.words === 1 ? "" : "s"}`;
    b.append(t, m);
    b.addEventListener("click", async () => {
      const full = await invoke<string | null>("history_get", { id: it.id });
      if (!full) return;
      await invoke("tts_stop").catch(() => {});
      loadText(full, `From history · ${timeLabel(it.id)}`, true);
      setTab("transcript");
    });
    list.append(b);
  }
}

// Clear History: entries swipe up and fade out in a quick stagger, the button confirms, then the
// empty state fades in. The data is wiped right away; the animation is only the visual reaction.
$("clear-history").addEventListener("click", async (e) => {
  const btn = e.currentTarget as HTMLButtonElement;
  const items = [...document.querySelectorAll<HTMLElement>("#history-list .item")];
  if (items.length === 0 || btn.disabled) return;

  btn.disabled = true;
  btn.textContent = "Cleared";
  btn.classList.add("done");
  items.forEach((el, i) => {
    el.style.animationDelay = `${Math.min(i, 8) * 45}ms`;
    el.classList.add("out");
  });

  await invoke("history_clear");
  await new Promise((r) => setTimeout(r, 360 + Math.min(items.length - 1, 8) * 45));
  await refreshHistory();

  setTimeout(() => {
    btn.textContent = "Clear History";
    btn.classList.remove("done");
    btn.disabled = false;
  }, 900);
});

// --------------------------------------------------------------- settings

const recNote = $("rec-note");
const recorder = attachRecorder($("rec"), {
  placeholder: "Click, then press a shortcut",
  async onCommit(accel) {
    try {
      await invoke("set_keybind", { accelerator: accel });
      recNote.className = "note ok";
      recNote.textContent = "Saved. This shortcut now starts a snip anywhere.";
    } catch (err) {
      recNote.className = "note error";
      recNote.textContent = String(err);
    }
  },
  onError(msg) {
    recNote.className = "note error";
    recNote.textContent = msg;
  },
});

$("rec-clear").addEventListener("click", async () => {
  await invoke("clear_keybind");
  recorder.show(null);
  recNote.className = "note";
  recNote.textContent = "Shortcut cleared. Record a new one to snip with the keyboard.";
});

type VoiceInfo = { id: string; name: string; language: string };
const voiceSel = $<HTMLSelectElement>("voice");
let voicesLoaded = false;

async function loadVoices() {
  if (voicesLoaded) return;
  voicesLoaded = true;
  const voices = await invoke<VoiceInfo[]>("tts_voices");
  const names = new Intl.DisplayNames(["en"], { type: "language", languageDisplay: "dialect" });
  const label = (tag: string) => {
    try { return names.of(tag.replace("_", "-")) ?? tag; } catch { return tag; }
  };
  const groups = new Map<string, VoiceInfo[]>();
  for (const v of voices) {
    const g = label(v.language);
    groups.set(g, [...(groups.get(g) ?? []), v]);
  }
  voiceSel.textContent = "";
  voiceSel.add(new Option("System default", ""));
  for (const g of [...groups.keys()].sort()) {
    const og = document.createElement("optgroup");
    og.label = g;
    for (const v of groups.get(g)!.sort((a, b) => a.name.localeCompare(b.name))) og.append(new Option(v.name, v.id));
    voiceSel.append(og);
  }
  voiceSel.value = voice ?? "";
  if (voiceSel.value !== (voice ?? "")) voiceSel.value = ""; // saved voice no longer installed
}

voiceSel.addEventListener("change", () => {
  voice = voiceSel.value || null;
  invoke("set_pref", { key: "voice", value: voice });
});

$("voice-preview").addEventListener("click", async () => {
  previewing = true;
  const id = voiceSel.value || null;
  await invoke("tts_speak", {
    text: "Hello! This is how I sound when reading your snips aloud.",
    offset: 0,
    speed,
    volume: volume / 100,
    voice: id,
  }).catch(() => (previewing = false));
});

async function refreshSettings() {
  recorder.show(await invoke<string | null>("get_keybind"));
  await loadVoices();
}

// ------------------------------------------------------------------ start

async function init() {
  const prefs = await invoke<{ voice: string | null; speed: number; volume: number }>("get_prefs");
  voice = prefs.voice;
  setSpeed(Number.isFinite(prefs.speed) ? prefs.speed : 1, "init");
  setVolume(Number.isFinite(prefs.volume) ? prefs.volume : 100, "init");
  updateButtons();

  const accel = await invoke<string | null>("get_keybind");
  textEl.textContent = accel
    ? `Select text on your screen with ${pretty(accel)} and it will be read aloud here.`
    : "Set a snip shortcut in Settings, then snip some text.";
}

init();
