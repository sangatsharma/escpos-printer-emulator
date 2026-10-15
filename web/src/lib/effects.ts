let audio: AudioContext | undefined;

/** The printer's beeper: a 2.7 kHz tone, `count` times. */
export function beep(count: number, durationMs: number): void {
  try {
    audio ??= new AudioContext();
    const dur = Math.max(0.05, Math.min(0.5, durationMs / 1000));
    for (let i = 0; i < Math.min(count, 9); i++) {
      const t = audio.currentTime + i * (dur + 0.08);
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.frequency.value = 2700;
      gain.gain.setValueAtTime(0.06, t);
      gain.gain.setValueAtTime(0, t + dur);
      osc.connect(gain).connect(audio.destination);
      osc.start(t);
      osc.stop(t + dur);
    }
  } catch {
    // No audio device or autoplay blocked: the badge still shows the beep.
  }
}

export function download(blob: Blob, name: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
