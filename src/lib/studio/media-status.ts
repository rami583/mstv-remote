import type { TrackRuntimeState } from "@/lib/types/runtime";

export interface MediaStatusIndicator {
  tone: "green" | "red" | "orange";
  label: "LIVE" | "MUTED" | "PROBLEM";
  detail: "LIVE" | "MUTED_REGIE" | "MUTED_LOCAL" | "OFF_REGIE" | "OFF_LOCAL";
  description: string;
  warning?: string;
}

export function computeAudioIndicator(input: {
  inProgram: boolean;
  trackState: TrackRuntimeState;
}): MediaStatusIndicator {
  if (!input.inProgram) {
    return {
      tone: "red",
      label: "MUTED",
      detail: "MUTED_REGIE",
      description: "Not in program. The control room is not taking your microphone."
    };
  }

  if (!input.trackState.published || input.trackState.muted || input.trackState.missing) {
    return {
      tone: "orange",
      label: "PROBLEM",
      detail: "MUTED_LOCAL",
      description: "In program, but the microphone is muted locally or not publishing.",
      warning: "Your microphone is muted locally. The control room cannot hear you."
    };
  }

  return {
    tone: "green",
    label: "LIVE",
    detail: "LIVE",
    description: "In program and microphone is active."
  };
}

export function computeVideoIndicator(input: {
  inProgram: boolean;
  trackState: TrackRuntimeState;
}): MediaStatusIndicator {
  if (!input.inProgram) {
    return {
      tone: "red",
      label: "MUTED",
      detail: "OFF_REGIE",
      description: "Not in program. The control room is not taking your camera."
    };
  }

  if (!input.trackState.published || input.trackState.muted || input.trackState.missing) {
    return {
      tone: "orange",
      label: "PROBLEM",
      detail: "OFF_LOCAL",
      description: "In program, but the camera is muted locally or not publishing."
    };
  }

  return {
    tone: "green",
    label: "LIVE",
    detail: "LIVE",
    description: "In program and camera is active."
  };
}

export function computeAudioDeviceIndicator(trackState: TrackRuntimeState): MediaStatusIndicator {
  if (!trackState.published || trackState.muted || trackState.missing) {
    return {
      tone: "red",
      label: "MUTED",
      detail: "MUTED_LOCAL",
      description: "Microphone is not publishing.",
      warning: "Your microphone is muted locally. The control room cannot hear you."
    };
  }

  return {
    tone: "green",
    label: "LIVE",
    detail: "LIVE",
    description: "Microphone is active."
  };
}

export function computeVideoDeviceIndicator(trackState: TrackRuntimeState): MediaStatusIndicator {
  if (!trackState.published || trackState.muted || trackState.missing) {
    return {
      tone: "red",
      label: "MUTED",
      detail: "OFF_LOCAL",
      description: "Camera is not publishing."
    };
  }

  return {
    tone: "green",
    label: "LIVE",
    detail: "LIVE",
    description: "Camera is active."
  };
}

export function getIndicatorClasses(tone: MediaStatusIndicator["tone"]) {
  switch (tone) {
    case "green":
      return "border-transparent bg-emerald-500 text-white shadow-[0_2px_10px_rgba(0,0,0,0.35)]";
    case "red":
      return "border-transparent bg-[#d4301f] text-white shadow-[0_2px_10px_rgba(0,0,0,0.35)]";
    case "orange":
      return "border-transparent bg-amber-500 text-white shadow-[0_2px_10px_rgba(0,0,0,0.35)]";
  }
}
