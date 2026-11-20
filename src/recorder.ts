/** Click-to-record keyboard shortcut box shared by onboarding and the Settings tab.
 *  Collects every key held and only decides once ALL keys are released.
 *  Shortcuts are modifiers + exactly ONE other key (an OS global-shortcut limit). */

const SYMBOLS: Record<string, string> = {
  Super: "⌘", Control: "⌃", Alt: "⌥", Shift: "⇧",
  Up: "↑", Down: "↓", Left: "←", Right: "→",
};

export function pretty(accel: string): string {
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

const MOD_CODE = /^(Meta|Control|Alt|Shift)(Left|Right)$/;

export interface Recorder {
  /** Show an accelerator (or the placeholder when null). */
  show(accel: string | null): void;
}

export function attachRecorder(
  el: HTMLElement,
  opts: {
    placeholder?: string;
    onCommit: (accel: string) => void;
    onError: (message: string) => void;
  },
): Recorder {
  const placeholder = opts.placeholder ?? "Click here, then press your shortcut";
  const held = new Set<string>();
  let chord = { mods: [] as string[], keys: [] as string[], bad: false };
  let shown: string | null = null;

  const show = (accel: string | null) => {
    shown = accel;
    el.classList.remove("recording", "bad");
    el.classList.toggle("set", accel !== null);
    el.textContent = accel ? pretty(accel) : placeholder;
  };

  const fail = (msg: string) => {
    el.classList.add("bad");
    opts.onError(msg);
  };

  el.addEventListener("focus", () => {
    if (!shown) el.classList.add("recording");
  });

  el.addEventListener("keydown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    if (e.key === "Escape" && held.size === 0) return el.blur();

    if (held.size === 0) chord = { mods: [], keys: [], bad: false };
    held.add(e.code);
    for (const [flag, name] of [[e.metaKey, "Super"], [e.ctrlKey, "Control"], [e.altKey, "Alt"], [e.shiftKey, "Shift"]] as const) {
      if (flag && !chord.mods.includes(name)) chord.mods.push(name);
    }
    if (!MOD_CODE.test(e.code)) {
      const key = keyName(e);
      if (!key) chord.bad = true;
      else if (!chord.keys.includes(key)) chord.keys.push(key);
    }
    el.classList.remove("set", "bad");
    el.classList.add("recording");
    el.textContent = pretty([...chord.mods, ...chord.keys].join("+")) || "…";
  });

  el.addEventListener("keyup", (e) => {
    e.preventDefault();
    held.delete(e.code);
    if (e.key === "Meta") held.clear(); // macOS sends no keyup for keys released under ⌘
    if (held.size > 0) return;

    const { mods, keys, bad } = chord;
    if (keys.length === 0) return show(shown);
    if (bad) return fail("That key can't be used. Try a letter, number or F-key.");
    if (keys.length > 1)
      return fail(`Shortcuts can use modifiers plus ONE other key. Try ${[...mods, keys[0]].join("+")}.`);
    if (mods.length === 0) return fail("Add a modifier key (⌘, ⌃, ⌥ or ⇧) so it doesn't fire while typing.");

    const accel = [...mods, keys[0]].join("+");
    show(accel);
    opts.onCommit(accel);
  });

  el.addEventListener("blur", () => {
    held.clear();
    if (!el.classList.contains("bad")) show(shown);
  });

  show(null);
  return { show };
}
