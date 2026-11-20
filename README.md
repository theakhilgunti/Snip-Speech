# SnipSpeech

**Select any text on your screen and hear it read aloud.** Press a shortcut, drag a box around the text, and SnipSpeech reads it to you. Everything happens on your computer: no accounts, no AI, no internet.

## Download

**[Download the latest version](https://github.com/theakhilgunti/Snip-Speech/releases/latest)**

| Platform | Status |
| --- | --- |
| macOS (Apple Silicon and Intel) | Available |
| Windows | Coming soon |
| Linux | Coming soon |

### Install on Mac

1. Download the `.dmg` file from the link above and open it.
2. Drag **SnipSpeech** into your **Applications** folder.
3. Open SnipSpeech from Applications. If macOS says it can't verify the app, **right-click (or Control-click) the app, choose Open, then click Open** again. You only need to do this once.
4. Pick your snip shortcut when the welcome window appears.
5. The first time you snip, macOS asks for **Screen Recording** permission. Turn it on for SnipSpeech in System Settings › Privacy & Security › Screen Recording, then quit and reopen SnipSpeech.

## How to use it

1. Press your shortcut. The screen freezes and dims.
2. Drag a box around any text. Press `Esc` or right-click to cancel.
3. SnipSpeech reads the text and starts speaking right away.

The small floating bar has:

- **Play / pause**, **stop**, and a **speed** control (0× to 4×, snaps to normal speed, or type any value).
- **Volume** with its own slider.
- **Expand** to open the transcript, where the word being spoken is highlighted and any word can be clicked to jump there.
- **History** of your past snips (just the text), with a one-click **Clear History**.
- **Settings** to change your shortcut and pick any voice installed on your computer, with a preview.

## Privacy

- Text recognition and speech both run **locally**, using your operating system's built-in tools.
- Nothing is uploaded and there is no tracking.
- Screenshots are kept only in a temporary folder while the app is open, and are **deleted when you quit** (and swept again on the next launch if the app ever crashes).
- History stores only the extracted text, on your computer, until you clear it.

## Build from source

You need [Rust](https://rustup.rs), [Node.js](https://nodejs.org) 20 or newer, and on macOS the Xcode command line tools.

```bash
git clone https://github.com/theakhilgunti/Snip-Speech.git
cd Snip-Speech
npm install
npm run tauri dev      # run it
npm run tauri build    # make an installer
```

Built with [Tauri](https://tauri.app) (Rust and web technologies). macOS uses Apple Vision for text recognition and `AVSpeechSynthesizer` for speech.

## License

[MIT](LICENSE)
