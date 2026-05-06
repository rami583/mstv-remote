"use client";

import { useEffect, useRef, useState } from "react";

interface AudioLevelMeterProps {
  track?: MediaStreamTrack | null;
  stream?: MediaStream | null;
}

const meterThresholds = [0.08, 0.18, 0.32, 0.5, 0.72];
const activeSegmentClasses = [
  "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.75)]",
  "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.75)]",
  "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.75)]",
  "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.75)]",
  "bg-[#d4301f] shadow-[0_0_8px_rgba(212,48,31,0.75)]"
];

export function AudioLevelMeter({ track, stream }: AudioLevelMeterProps) {
  const [level, setLevel] = useState(0);
  const audioTrack = track ?? stream?.getAudioTracks()[0] ?? null;

  useEffect(() => {
    if (!audioTrack || audioTrack.readyState !== "live") {
      setLevel(0);
      return;
    }

    let active = true;
    let animationFrame = 0;
    let smoothedLevel = 0;
    const analyserTrack = audioTrack.clone();
    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    const silentGain = audioContext.createGain();
    const source = audioContext.createMediaStreamSource(new MediaStream([analyserTrack]));

    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.72;
    silentGain.gain.value = 0;
    const samples = new Uint8Array(analyser.fftSize);
    source.connect(analyser);
    analyser.connect(silentGain);
    silentGain.connect(audioContext.destination);
    void audioContext.resume().catch(() => undefined);

    const tick = () => {
      if (!active) {
        return;
      }

      analyser.getByteTimeDomainData(samples);

      let sum = 0;
      for (const sample of samples) {
        const normalized = (sample - 128) / 128;
        sum += normalized * normalized;
      }

      const rms = Math.sqrt(sum / samples.length);
      const nextLevel = Math.min(1, rms * 5.5);
      smoothedLevel = smoothedLevel * 0.72 + nextLevel * 0.28;
      setLevel(smoothedLevel);
      animationFrame = window.requestAnimationFrame(tick);
    };

    tick();

    return () => {
      active = false;
      window.cancelAnimationFrame(animationFrame);
      source.disconnect();
      analyser.disconnect();
      silentGain.disconnect();
      analyserTrack.stop();
      void audioContext.close().catch(() => undefined);
    };
  }, [audioTrack]);

  if (!audioTrack) {
    return null;
  }

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute right-4 top-1/2 z-20 grid -translate-y-1/2 grid-cols-2 gap-x-1 gap-y-1"
    >
      {meterThresholds.map((threshold, index) => {
        const isActive = level >= threshold;

        return [
          <div
            key={`${index}-left`}
            className={`h-2.5 w-2.5 rounded-full transition-colors duration-75 ${
              isActive ? activeSegmentClasses[index] : "bg-zinc-800/90"
            }`}
            style={{ gridColumn: 1, gridRow: meterThresholds.length - index }}
          />,
          <div
            key={`${index}-right`}
            className={`h-2.5 w-2.5 rounded-full transition-colors duration-75 ${
              isActive ? activeSegmentClasses[index] : "bg-zinc-800/90"
            }`}
            style={{ gridColumn: 2, gridRow: meterThresholds.length - index }}
          />
        ];
      })}
    </div>
  );
}
