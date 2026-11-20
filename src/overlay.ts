import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

const label = getCurrentWebviewWindow().label;
const bg = document.getElementById("bg") as HTMLImageElement;
const dim = document.getElementById("dim") as HTMLDivElement;
const sel = document.getElementById("sel") as HTMLDivElement;
const sizeLabel = document.getElementById("size") as HTMLDivElement;

let start: { x: number; y: number } | null = null;
let rect = { x: 0, y: 0, w: 0, h: 0 };

/** Physical pixels per CSS pixel (2 on Retina), from the frozen frame's real size. */
function scale(): number {
  return bg.naturalWidth > 0 ? bg.naturalWidth / window.innerWidth : window.devicePixelRatio;
}

let frameLoaded = false;

/** Fetch the frozen screenshot. It may not be captured yet when the page loads, so this
 *  runs once on load and again when Rust signals that the frame is ready. */
async function loadFrame() {
  if (frameLoaded) return;
  try {
    const bytes = await invoke<ArrayBuffer>("overlay_frame", { label });
    frameLoaded = true;
    // Reveal once decoded. (Not requestAnimationFrame: a hidden window never fires it.)
    bg.onload = () => bg.decode().catch(() => {}).then(() => invoke("overlay_ready", { label }));
    bg.src = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
  } catch {
    /* not captured yet: the "overlay-frame-ready" event will call us again */
  }
}

function cancel() {
  invoke("cancel_snip");
}

function drawSelection() {
  sel.style.display = "block";
  sel.style.left = `${rect.x}px`;
  sel.style.top = `${rect.y}px`;
  sel.style.width = `${rect.w}px`;
  sel.style.height = `${rect.h}px`;

  const s = scale();
  sizeLabel.style.display = "block";
  sizeLabel.textContent = `${Math.round(rect.w * s)} × ${Math.round(rect.h * s)}`;
  // Sit above the box; flip below it when there's no room at the top.
  const ly = rect.y > 28 ? rect.y - 26 : rect.y + rect.h + 6;
  sizeLabel.style.left = `${rect.x}px`;
  sizeLabel.style.top = `${ly}px`;
}

window.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  (e.target as Element).setPointerCapture?.(e.pointerId);
  start = { x: e.clientX, y: e.clientY };
  rect = { x: e.clientX, y: e.clientY, w: 0, h: 0 };
  dim.style.display = "none"; // the box's shadow takes over the dimming
  drawSelection();
});

window.addEventListener("pointermove", (e) => {
  if (!start) return;
  rect = {
    x: Math.min(start.x, e.clientX),
    y: Math.min(start.y, e.clientY),
    w: Math.abs(e.clientX - start.x),
    h: Math.abs(e.clientY - start.y),
  };
  drawSelection();
});

window.addEventListener("pointerup", async () => {
  if (!start) return;
  start = null;
  const s = scale();
  await invoke("finish_snip", {
    label,
    x: Math.round(rect.x * s),
    y: Math.round(rect.y * s),
    w: Math.round(rect.w * s),
    h: Math.round(rect.h * s),
  });
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") cancel();
});

// Right-click also cancels, like most snipping tools.
window.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  cancel();
});

listen("overlay-frame-ready", loadFrame);
loadFrame();
