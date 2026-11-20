//! Offline text-to-speech with live word positions.
//!
//! macOS: `AVSpeechSynthesizer` driven directly so its delegate can report the exact
//! range of each word as it is spoken (events: `tts-word`, `tts-state`).
//! Windows/Linux (via the `tts` crate) are added in a later milestone.
//!
//! All offsets are UTF-16 code units, the same unit JavaScript string indices use.

use tauri::AppHandle;

/// Map a speed multiplier onto AVSpeech's 0..1 rate (0.5 = normal).
///
/// The relationship is not linear, so this interpolates measured points: for each rate
/// the (speed vs. 1x, rate) pairs below come from timing the default macOS voice with
/// `AVSpeechSynthesizer.write`. The voice can't go below ~0.5x or above ~4x.
#[cfg(target_os = "macos")]
fn rate_for(multiplier: f32) -> f32 {
    const TABLE: [(f32, f32); 11] = [
        (0.50, 0.0),
        (0.59, 0.1),
        (0.72, 0.2),
        (0.77, 0.3),
        (0.91, 0.4),
        (1.00, 0.5),
        (1.59, 0.6),
        (2.11, 0.7),
        (2.80, 0.8),
        (3.52, 0.9),
        (4.03, 1.0),
    ];
    let m = multiplier.clamp(TABLE[0].0, TABLE[TABLE.len() - 1].0);
    for w in TABLE.windows(2) {
        let ((s0, r0), (s1, r1)) = (w[0], w[1]);
        if m <= s1 {
            return r0 + (r1 - r0) * (m - s0) / (s1 - s0);
        }
    }
    1.0
}

#[cfg(target_os = "macos")]
mod mac {
    use std::{
        cell::RefCell,
        sync::atomic::{AtomicUsize, Ordering},
    };

    use objc2::{
        define_class, msg_send, rc::Retained, runtime::ProtocolObject, AnyThread, DefinedClass,
    };
    use objc2_avf_audio::{
        AVSpeechBoundary, AVSpeechSynthesisVoice, AVSpeechSynthesizer, AVSpeechSynthesizerDelegate,
        AVSpeechUtterance,
    };
    use objc2_foundation::{NSObject, NSObjectProtocol, NSRange, NSString};
    use serde_json::json;
    use tauri::{AppHandle, Emitter};

    pub struct Ivars {
        app: AppHandle,
        /// UTF-16 offset of the utterance's first character within the full text.
        offset: AtomicUsize,
        /// Address of the utterance currently being spoken (0 = none). Callbacks for
        /// older, replaced utterances are ignored.
        current: AtomicUsize,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "SnipSpeechSpeechDelegate"]
        #[ivars = Ivars]
        pub struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl AVSpeechSynthesizerDelegate for Delegate {
            #[unsafe(method(speechSynthesizer:didStartSpeechUtterance:))]
            fn did_start(&self, _s: &AVSpeechSynthesizer, u: &AVSpeechUtterance) {
                if self.is_current(u) {
                    self.state("speaking");
                }
            }

            #[unsafe(method(speechSynthesizer:didFinishSpeechUtterance:))]
            fn did_finish(&self, _s: &AVSpeechSynthesizer, u: &AVSpeechUtterance) {
                if self.is_current(u) {
                    self.ivars().current.store(0, Ordering::SeqCst);
                    self.state("idle");
                    let _ = self.ivars().app.emit("tts-finished", ());
                }
            }

            #[unsafe(method(speechSynthesizer:didPauseSpeechUtterance:))]
            fn did_pause(&self, _s: &AVSpeechSynthesizer, u: &AVSpeechUtterance) {
                if self.is_current(u) {
                    self.state("paused");
                }
            }

            #[unsafe(method(speechSynthesizer:didContinueSpeechUtterance:))]
            fn did_continue(&self, _s: &AVSpeechSynthesizer, u: &AVSpeechUtterance) {
                if self.is_current(u) {
                    self.state("speaking");
                }
            }

            #[unsafe(method(speechSynthesizer:didCancelSpeechUtterance:))]
            fn did_cancel(&self, _s: &AVSpeechSynthesizer, u: &AVSpeechUtterance) {
                if self.is_current(u) {
                    self.ivars().current.store(0, Ordering::SeqCst);
                    self.state("idle");
                }
            }

            #[unsafe(method(speechSynthesizer:willSpeakRangeOfSpeechString:utterance:))]
            fn will_speak(&self, _s: &AVSpeechSynthesizer, range: NSRange, u: &AVSpeechUtterance) {
                if self.is_current(u) {
                    let base = self.ivars().offset.load(Ordering::SeqCst);
                    let _ = self.ivars().app.emit(
                        "tts-word",
                        json!({ "start": base + range.location, "length": range.length }),
                    );
                }
            }
        }
    );

    impl Delegate {
        fn new(app: AppHandle) -> Retained<Self> {
            let this = Self::alloc().set_ivars(Ivars {
                app,
                offset: AtomicUsize::new(0),
                current: AtomicUsize::new(0),
            });
            unsafe { msg_send![super(this), init] }
        }

        fn is_current(&self, u: &AVSpeechUtterance) -> bool {
            self.ivars().current.load(Ordering::SeqCst) == u as *const AVSpeechUtterance as usize
        }

        fn state(&self, s: &str) {
            let _ = self.ivars().app.emit("tts-state", s);
        }
    }

    struct Engine {
        synth: Retained<AVSpeechSynthesizer>,
        // The synthesizer holds its delegate weakly, so keep it alive here.
        delegate: Retained<Delegate>,
    }

    thread_local! {
        // Only ever touched on the main thread (see `on_main` in the parent module).
        static ENGINE: RefCell<Option<Engine>> = const { RefCell::new(None) };
    }

    fn with_engine<R>(app: &AppHandle, f: impl FnOnce(&Engine) -> R) -> R {
        ENGINE.with(|cell| {
            let mut slot = cell.borrow_mut();
            if slot.is_none() {
                let delegate = Delegate::new(app.clone());
                let synth = unsafe { AVSpeechSynthesizer::new() };
                unsafe {
                    synth.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
                }
                *slot = Some(Engine { synth, delegate });
            }
            f(slot.as_ref().unwrap())
        })
    }

    pub fn speak(
        app: &AppHandle,
        text: &str,
        offset: usize,
        speed: f32,
        volume: f32,
        voice: Option<&str>,
    ) {
        with_engine(app, |e| {
            let full = NSString::from_str(text);
            let offset = offset.min(full.length());
            let rest = full.substringFromIndex(offset);
            if rest.length() == 0 {
                return;
            }

            let utt = unsafe { AVSpeechUtterance::speechUtteranceWithString(&rest) };
            unsafe {
                utt.setRate(super::rate_for(speed));
                utt.setVolume(volume.clamp(0.0, 1.0));
                if let Some(id) = voice {
                    let v = AVSpeechSynthesisVoice::voiceWithIdentifier(&NSString::from_str(id));
                    utt.setVoice(v.as_deref());
                }
            }

            // Point the delegate at the NEW utterance first so the cancel callback for
            // whatever we are interrupting is ignored.
            let iv = e.delegate.ivars();
            iv.offset.store(offset, Ordering::SeqCst);
            iv.current.store(Retained::as_ptr(&utt) as usize, Ordering::SeqCst);
            unsafe {
                e.synth.stopSpeakingAtBoundary(AVSpeechBoundary::Immediate);
                e.synth.speakUtterance(&utt);
            }
        });
    }

    pub fn pause(app: &AppHandle) {
        with_engine(app, |e| unsafe {
            e.synth.pauseSpeakingAtBoundary(AVSpeechBoundary::Immediate);
        });
    }

    pub fn resume(app: &AppHandle) {
        with_engine(app, |e| unsafe {
            e.synth.continueSpeaking();
        });
    }

    pub fn stop(app: &AppHandle) {
        with_engine(app, |e| {
            e.delegate.ivars().current.store(0, Ordering::SeqCst);
            unsafe {
                e.synth.stopSpeakingAtBoundary(AVSpeechBoundary::Immediate);
            }
            e.delegate.state("idle");
        });
    }
}

/// AVSpeechSynthesizer must be driven from the main thread.
#[cfg(target_os = "macos")]
fn on_main(app: &AppHandle, f: impl FnOnce(&AppHandle) + Send + 'static) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || f(&handle))
        .map_err(|e| e.to_string())
}

// ------------------------------------------------------------------- commands

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn tts_speak(
    app: AppHandle,
    text: String,
    offset: usize,
    speed: f32,
    volume: f32,
    voice: Option<String>,
) -> Result<(), String> {
    on_main(&app, move |a| mac::speak(a, &text, offset, speed, volume, voice.as_deref()))
}

#[derive(serde::Serialize)]
pub struct VoiceInfo {
    id: String,
    name: String,
    /// BCP-47 language tag, e.g. "en-US".
    language: String,
}

/// Every voice installed on this Mac.
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn tts_voices() -> Vec<VoiceInfo> {
    use objc2_avf_audio::AVSpeechSynthesisVoice;
    let voices = unsafe { AVSpeechSynthesisVoice::speechVoices() };
    voices
        .iter()
        .map(|v| unsafe {
            VoiceInfo {
                id: v.identifier().to_string(),
                name: v.name().to_string(),
                language: v.language().to_string(),
            }
        })
        .collect()
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn tts_voices() -> Vec<VoiceInfo> {
    Vec::new()
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn tts_pause(app: AppHandle) -> Result<(), String> {
    on_main(&app, mac::pause)
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn tts_resume(app: AppHandle) -> Result<(), String> {
    on_main(&app, mac::resume)
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn tts_stop(app: AppHandle) -> Result<(), String> {
    on_main(&app, mac::stop)
}

#[cfg(not(target_os = "macos"))]
const UNSUPPORTED: &str = "Speech isn't implemented for this operating system yet.";

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn tts_speak(
    _app: AppHandle,
    _text: String,
    _offset: usize,
    _speed: f32,
    _volume: f32,
    _voice: Option<String>,
) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn tts_pause(_app: AppHandle) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn tts_resume(_app: AppHandle) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn tts_stop(_app: AppHandle) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}
