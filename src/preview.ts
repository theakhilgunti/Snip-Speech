import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const shot = document.getElementById("shot") as HTMLImageElement;
const info = document.getElementById("info") as HTMLElement;
const textEl = document.getElementById("text") as HTMLPreElement;

type OcrResult = { text: string | null; error: string | null };

function showText(r: OcrResult | null) {
  textEl.className = "";
  if (!r) {
    textEl.classList.add("muted");
    textEl.textContent = "Reading text…";
  } else if (r.error) {
    textEl.classList.add("error");
    textEl.textContent = r.error;
  } else if (!r.text || r.text.trim() === "") {
    textEl.classList.add("muted");
    textEl.textContent = "No text found in this snip.";
  } else {
    textEl.textContent = r.text;
  }
}

async function load() {
  showText(null);
  try {
    const bytes = await invoke<ArrayBuffer>("read_latest_snip");
    shot.onload = () => {
      info.textContent = `${shot.naturalWidth} × ${shot.naturalHeight} px · Temporary: deleted when SnipSpeech quits`;
    };
    shot.src = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
  } catch {
    textEl.className = "muted";
    textEl.textContent = "No snip yet.";
    return;
  }
  // OCR may already be done (window opened late) or still running (event follows).
  const ready = await invoke<OcrResult | null>("read_latest_text");
  if (ready) showText(ready);
}

listen("snip-captured", load);
listen<OcrResult>("snip-text", (e) => showText(e.payload));
load();
