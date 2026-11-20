import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const shot = document.getElementById("shot") as HTMLImageElement;
const info = document.getElementById("info") as HTMLElement;

async function load() {
  try {
    const bytes = await invoke<ArrayBuffer>("read_latest_snip");
    shot.onload = () => {
      info.textContent = `${shot.naturalWidth} × ${shot.naturalHeight} px · Temporary: deleted when SnipSpeech quits`;
    };
    shot.src = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
  } catch {
    info.textContent = "No snip yet.";
  }
}

listen("snip-captured", load);
load();
