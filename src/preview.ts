import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const shot = document.getElementById("shot") as HTMLImageElement;
const info = document.getElementById("info") as HTMLElement;
const textEl = document.getElementById("text") as HTMLDivElement;
const playBtn = document.getElementById("play") as HTMLButtonElement;
const stopBtn = document.getElementById("stop") as HTMLButtonElement;
const speedBtns = [...document.querySelectorAll<HTMLButtonElement>("#speeds button")];

type OcrResult = { text: string | null; error: string | null };
type Status = "idle" | "speaking" | "paused";
type Word = { el: HTMLSpanElement; start: number; end: number };

let text = "";
let words: Word[] = [];
let status: Status = "idle";
let speed = 1;
let cursor = 0; // UTF-16 offset of the word being spoken (restart point)
let current: Word | null = null;

// ------------------------------------------------------------ transcript

/** Split text into clickable word spans; offsets are UTF-16 (same unit as the TTS engine). */
function renderTranscript(t: string) {
  textEl.className = "";
  textEl.textContent = "";
  words = [];
  current = null;
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
}

function showMessage(msg: string, cls: "muted" | "error") {
  text = "";
  words = [];
  current = null;
  textEl.className = cls;
  textEl.textContent = msg;
  updateButtons();
}

function highlight(start: number) {
  const w = words.find((x) => start >= x.start && start < x.end) ?? null;
  if (w === current) return;
  current?.el.classList.remove("now");
  current = w;
  if (w) {
    w.el.classList.add("now");
    cursor = w.start;
    w.el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function clearHighlight() {
  current?.el.classList.remove("now");
  current = null;
}

// -------------------------------------------------------------- playback

function updateButtons() {
  const has = text.trim() !== "";
  playBtn.disabled = !has;
  stopBtn.disabled = !has || status === "idle";
  playBtn.textContent = status === "speaking" ? "⏸" : "▶";
}

async function speakFrom(offset: number) {
  if (!text) return;
  cursor = offset;
  try {
    await invoke("tts_speak", { text, offset, speed, voice: null });
  } catch (e) {
    info.textContent = String(e);
  }
}

playBtn.addEventListener("click", async () => {
  if (status === "speaking") await invoke("tts_pause");
  else if (status === "paused") await invoke("tts_resume");
  else speakFrom(0);
});

stopBtn.addEventListener("click", async () => {
  await invoke("tts_stop");
  cursor = 0;
  clearHighlight();
});

for (const b of speedBtns) {
  b.addEventListener("click", () => {
    speed = Number(b.dataset.s);
    speedBtns.forEach((x) => x.classList.toggle("on", x === b));
    // Speech rate can't change mid-sentence, so restart from the current word.
    if (status !== "idle") speakFrom(cursor);
  });
}

listen<Status>("tts-state", (e) => {
  status = e.payload;
  if (status === "idle") clearHighlight();
  updateButtons();
});

listen<{ start: number; length: number }>("tts-word", (e) => highlight(e.payload.start));

// ------------------------------------------------------------ snip intake

function showOcr(r: OcrResult) {
  if (r.error) return showMessage(r.error, "error");
  if (!r.text || r.text.trim() === "") return showMessage("No text found in this snip.", "muted");
  text = r.text;
  renderTranscript(text);
  updateButtons();
  speakFrom(0); // auto-play as soon as the text is ready
}

async function load() {
  await invoke("tts_stop").catch(() => {});
  showMessage("Reading text…", "muted");
  try {
    const bytes = await invoke<ArrayBuffer>("read_latest_snip");
    shot.onload = () => {
      info.textContent = `${shot.naturalWidth} × ${shot.naturalHeight} px snip · temporary, deleted when SnipSpeech quits · click any word to jump`;
    };
    shot.src = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
  } catch {
    return showMessage("No snip yet.", "muted");
  }
  const ready = await invoke<OcrResult | null>("read_latest_text");
  if (ready) showOcr(ready);
}

listen("snip-captured", load);
listen<OcrResult>("snip-text", (e) => showOcr(e.payload));
load();
