// Spoken announcements for the car mode (built-in text-to-speech of the phone, works offline on Android).

let enabled = true;

export function setSpeechEnabled(on: boolean) {
  enabled = on;
  if (!on) window.speechSynthesis?.cancel();
}

function germanVoice(): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis?.getVoices() ?? [];
  return voices.find((v) => v.lang === 'de-DE' && v.localService) ?? voices.find((v) => v.lang.startsWith('de'));
}

/** Speak and resolve when done (or after a safety timeout, so playback never hangs on a silent engine). */
export function say(text: string): Promise<void> {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
  if (!enabled || !synth || !text) return Promise.resolve();
  synth.cancel();
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'de-DE';
    const v = germanVoice();
    if (v) u.voice = v;
    u.rate = 1.02;
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    u.onend = finish;
    u.onerror = finish;
    window.setTimeout(finish, Math.min(12000, 1500 + text.length * 90));
    synth.speak(u);
  });
}

export function stopSpeech() {
  window.speechSynthesis?.cancel();
}
