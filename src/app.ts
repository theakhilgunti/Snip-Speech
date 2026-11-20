import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const recorder = document.getElementById("recorder") as HTMLDivElement;
const hint = document.getElementById("hint") as HTMLParagraphElement;
const saveBtn = document.getElementById("save") as HTMLButtonElement;
const clearBtn = document.getElementById("clear") as HTMLButtonElement;

const DEFAULT_HINT = "Use at least one modifier (⌘, ⌃, ⌥ or ⇧) plus a key.";
let pending: string | null = null; // accelerator string, e.g. "Super+Shift+S"

const SYMBOLS: Record<string, string> = {
  Super: "⌘", Control: "⌃", Alt: "⌥", Shift: "⇧",
  Up: "↑", Down: "↓", Left: "←", Right: "→", Space: "Space",
};

function pretty(accel: string): string {
  return accel.split("+").map((p) => SYMBOLS[p] ?? p).join(" ");
}

/** Map a KeyboardEvent to the key name Tauri's shortcut parser understands. */
function keyName(e: KeyboardEvent): string | null {
  const c = e.code;
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^Digit[0-9]$/.test(c)) return c.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(c)) return c;
  const map: Record<string, string> = {
    Space: "Space", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
    Enter: "Enter", Tab: "Tab", Backspace: "Backspace", Minus: "-", Equal: "=",
    BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'", Comma: ",",
    Period: ".", Slash: "/", Backslash: "\\", Backquote: "`",
  };
  return map[c] ?? null;
}

function setError(msg: string) {
  hint.textContent = msg;
  hint.classList.add("error");
  recorder.classList.add("bad");
}

function showPending(accel: string | null) {
  pending = accel;
  saveBtn.disabled = accel === null;
  recorder.classList.remove("bad", "recording");
  hint.classList.remove("error");
  hint.textContent = DEFAULT_HINT;
  if (accel) {
    recorder.textContent = pretty(accel);
    recorder.classList.add("set");
  } else {
    recorder.textContent = "Click here, then press your shortcut";
    recorder.classList.remove("set");
  }
}

recorder.addEventListener("focus", () => {
  if (!pending) recorder.classList.add("recording");
});

// The recorder collects every key pressed and only decides once ALL keys are released.
const MOD_CODE = /^(Meta|Control|Alt|Shift)(Left|Right)$/;
const held = new Set<string>();
let chord: { mods: string[]; keys: string[]; bad: boolean } = { mods: [], keys: [], bad: false };

function modsOf(e: KeyboardEvent): string[] {
  const mods: string[] = [];
  if (e.metaKey) mods.push("Super");
  if (e.ctrlKey) mods.push("Control");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  return mods;
}

recorder.addEventListener("keydown", (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (e.repeat) return;
  if (e.key === "Escape" && held.size === 0) { recorder.blur(); return; }

  if (held.size === 0) chord = { mods: [], keys: [], bad: false }; // fresh attempt
  held.add(e.code);
  for (const m of modsOf(e)) if (!chord.mods.includes(m)) chord.mods.push(m);
  if (!MOD_CODE.test(e.code)) {
    const key = keyName(e);
    if (!key) chord.bad = true;
    else if (!chord.keys.includes(key)) chord.keys.push(key);
  }

  // Live preview while keys are held.
  recorder.classList.remove("set", "bad");
  recorder.classList.add("recording");
  recorder.textContent = pretty([...chord.mods, ...chord.keys].join("+")) || "…";
});

recorder.addEventListener("keyup", (e) => {
  e.preventDefault();
  held.delete(e.code);
  if (e.key === "Meta") held.clear(); // macOS doesn't send keyup for keys released under ⌘
  if (held.size > 0) return; // still holding something: keep listening

  const { mods, keys, bad } = chord;
  if (keys.length === 0) return showPending(pending); // only modifiers pressed
  if (bad) return setError("That key can't be used. Try a letter, number or F-key.");
  if (keys.length > 1)
    return setError(
      `Shortcuts can use modifiers plus ONE other key (you pressed ${keys.join(" + ")}). Try ${[...mods, keys[0]].join("+")}.`,
    );
  if (mods.length === 0) return setError("Add a modifier key (⌘, ⌃, ⌥ or ⇧) so it doesn't fire while typing.");
  showPending([...mods, keys[0]].join("+"));
});

recorder.addEventListener("blur", () => held.clear());

saveBtn.addEventListener("click", async () => {
  if (!pending) return;
  try {
    await invoke("set_keybind", { accelerator: pending });
  } catch (err) {
    setError(String(err));
  }
});

clearBtn.addEventListener("click", async () => {
  await invoke("clear_keybind");
  showPending(null);
});

// Opened from the tray ("Change Keybind") or first launch: show current value.
async function refresh() {
  const current = await invoke<string | null>("get_keybind");
  showPending(current);
  if (!current) recorder.focus();
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
