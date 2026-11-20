// First-launch onboarding window: pick the global snip shortcut.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { attachRecorder } from "./recorder";

const recorderEl = document.getElementById("recorder") as HTMLDivElement;
const hint = document.getElementById("hint") as HTMLParagraphElement;
const saveBtn = document.getElementById("save") as HTMLButtonElement;
const clearBtn = document.getElementById("clear") as HTMLButtonElement;

const DEFAULT_HINT = "Use at least one modifier (⌘, ⌃, ⌥ or ⇧) plus a key.";
let pending: string | null = null;

function setHint(msg: string, error = false) {
  hint.textContent = msg;
  hint.classList.toggle("error", error);
}

const recorder = attachRecorder(recorderEl, {
  onCommit(accel) {
    pending = accel;
    saveBtn.disabled = false;
    setHint(DEFAULT_HINT);
  },
  onError(msg) {
    pending = null;
    saveBtn.disabled = true;
    setHint(msg, true);
  },
});

saveBtn.addEventListener("click", async () => {
  if (!pending) return;
  try {
    await invoke("set_keybind", { accelerator: pending });
  } catch (err) {
    setHint(String(err), true);
  }
});

clearBtn.addEventListener("click", async () => {
  await invoke("clear_keybind");
  pending = null;
  saveBtn.disabled = true;
  recorder.show(null);
  setHint(DEFAULT_HINT);
});

async function refresh() {
  const current = await invoke<string | null>("get_keybind");
  pending = current;
  saveBtn.disabled = current === null;
  recorder.show(current);
  setHint(DEFAULT_HINT);
  if (!current) recorderEl.focus();
}

// Snip failed (e.g. Screen Recording not allowed): say so instead of failing silently.
const alertBox = document.getElementById("alert") as HTMLDivElement;
const alertText = document.getElementById("alert-text") as HTMLSpanElement;
listen<string>("capture-error", (e) => {
  alertText.textContent = e.payload;
  alertBox.hidden = false;
});
document.getElementById("alert-open")!.addEventListener("click", () => invoke("open_screen_recording_settings"));

listen("show-onboarding", refresh);
refresh();
