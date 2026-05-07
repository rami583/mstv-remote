"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  ControlGuestGridSurface,
  ControlProgramRoutingBridge,
  ControlReturnFeedPublisher,
  type GuestVideoFramingAction,
  type ProgramRecordingCommand,
  type ProgramRecordingStatus,
  type ReturnFeedPublisherState
} from "@/components/livekit/minimal-studio-surfaces";
import { AudioLevelMeter } from "@/components/studio/audio-level-meter";
import type { CompanionControlCommand } from "@/lib/companion/control-actions";
import { fetchLiveKitToken } from "@/lib/livekit/browser-token";
import { buildParticipantIdentity } from "@/lib/livekit/identity";
import {
  computeAudioIndicator,
  computeVideoIndicator,
  type MediaStatusIndicator
} from "@/lib/studio/media-status";
import {
  acknowledgeCompanionAction,
  fetchProductionSnapshot,
  fetchPendingCompanionActions,
  disconnectGuest,
  updateGuestVideoFraming,
  updateGlobalReturnSource,
  updateGuestReturnOverride,
  updateProgramScene
} from "@/lib/studio/control-plane";
import type { TokenResponsePayload } from "@/lib/types/livekit";
import type {
  GuestVideoFraming,
  ProductionParticipantState,
  ProductionSnapshot,
  ReturnSource,
  RuntimeParticipantState,
  SlideControlCommandMessage
} from "@/lib/types/runtime";

interface ControlRoomClientProps {
  room: string;
}

interface DesktopRuntimeConfig {
  guestPublicBaseUrl: string | null;
  desktopRoomSlug: string;
}

interface DesktopProgramDisplay {
  id: number;
  label: string;
  isPrimary: boolean;
}

interface DesktopProgramWindowState {
  isOpen: boolean;
}

interface DesktopProgramWindowResponse {
  displays: DesktopProgramDisplay[];
  programWindow: DesktopProgramWindowState;
}

declare global {
  interface Window {
    mstvDesktop?: {
      getProgramDisplays: () => Promise<DesktopProgramWindowResponse>;
      toggleProgramWindow: (
        displayId?: number | string | null,
        roomSlug?: string
      ) => Promise<DesktopProgramWindowResponse>;
      setSessionSlug?: (roomSlug: string) => Promise<{
        ok: boolean;
        roomSlug: string;
        path?: string;
      }>;
      writeClipboardText?: (text: string) => Promise<{ ok: boolean }>;
      showItemInFolder?: (filePath: string) => Promise<{ ok: boolean }>;
      chooseProgramRecordingPath?: (input: {
        defaultFileName: string;
      }) => Promise<{ canceled: boolean; filePath: string | null }>;
      saveProgramRecording?: (input: {
        bytes: ArrayBuffer;
        filePath: string;
      }) => Promise<{ ok: boolean; filePath: string; fileSizeBytes?: number }>;
      sendSlideCommand: (input: {
        host: string;
        port: string;
        command: "NEXT_SLIDE" | "PREV_SLIDE";
      }) => Promise<{
        ok: boolean;
        statusCode?: number;
        url?: string;
      }>;
    };
  }
}

interface MediaDeviceOption {
  deviceId: string;
  label: string;
}

interface StudioInputConfig {
  id: ReturnSource;
  label: ReturnSource;
  videoDeviceId: string | null;
  audioDeviceId: string | null;
  imageDataUrl?: string | null;
  imageFileName?: string | null;
}

interface SlideCommandFeedback {
  id: string;
  label: string;
}

interface SlideReceiverStatus {
  state: "idle" | "not-configured" | "sending" | "success" | "error";
  message: string;
}

const studioInputSettingsStorageKey = "mstv.studioInputs";
const programDisplayStorageKey = "mstv.programDisplayId";
const programAudioOutputStorageKey = "mstv.programAudioOutputDeviceId";
const slideReceiverHostStorageKey = "mstv.slideReceiverHost";
const slideReceiverPortStorageKey = "mstv.slideReceiverPort";

function loadStoredString(key: string, fallback = "") {
  if (typeof window === "undefined") {
    return fallback;
  }

  try {
    const value = window.localStorage.getItem(key);
    return value?.trim() ? value : fallback;
  } catch {
    return fallback;
  }
}

function loadStoredProgramDisplayId() {
  const savedValue = loadStoredString(programDisplayStorageKey);

  if (!savedValue) {
    return null;
  }

  const parsedValue = Number(savedValue);
  return Number.isFinite(parsedValue) ? parsedValue : null;
}

function getDefaultStudioInputs(): Record<ReturnSource, StudioInputConfig> {
  return {
    STUDIO: {
      id: "STUDIO",
      label: "STUDIO",
      videoDeviceId: null,
      audioDeviceId: null
    },
    REGIE: {
      id: "REGIE",
      label: "REGIE",
      videoDeviceId: null,
      audioDeviceId: null
    },
    IMAGE: {
      id: "IMAGE",
      label: "IMAGE",
      videoDeviceId: null,
      audioDeviceId: null,
      imageDataUrl: null,
      imageFileName: null
    }
  };
}

function normalizeStoredStudioInputs(input: unknown): Record<ReturnSource, StudioInputConfig> {
  const defaults = getDefaultStudioInputs();
  const parsedInput =
    input && typeof input === "object"
      ? (input as Partial<Record<ReturnSource, Partial<StudioInputConfig>>>)
      : {};

  return {
    STUDIO: {
      ...defaults.STUDIO,
      videoDeviceId: parsedInput.STUDIO?.videoDeviceId ?? null,
      audioDeviceId: parsedInput.STUDIO?.audioDeviceId ?? null
    },
    REGIE: {
      ...defaults.REGIE,
      videoDeviceId: parsedInput.REGIE?.videoDeviceId ?? null,
      audioDeviceId: parsedInput.REGIE?.audioDeviceId ?? null
    },
    IMAGE: {
      ...defaults.IMAGE,
      imageDataUrl: parsedInput.IMAGE?.imageDataUrl ?? null,
      imageFileName: parsedInput.IMAGE?.imageFileName ?? null
    }
  };
}

function loadStoredStudioInputs(): Record<ReturnSource, StudioInputConfig> {
  if (typeof window === "undefined") {
    return getDefaultStudioInputs();
  }

  try {
    const rawValue = window.localStorage.getItem(studioInputSettingsStorageKey);

    return normalizeStoredStudioInputs(rawValue ? JSON.parse(rawValue) : null);
  } catch {
    return getDefaultStudioInputs();
  }
}

function isAcceptedImageFile(file: File) {
  const acceptedMimeTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
  const acceptedExtensions = /\.(png|jpe?g|webp)$/i;

  return acceptedMimeTypes.has(file.type) || acceptedExtensions.test(file.name);
}

function SelectorChevronIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
    >
      <path d="M4 6.25 8 10l4-3.75" />
    </svg>
  );
}

function StudioInputTile(input: {
  label: string;
  isActive: boolean;
  onActivate: () => void;
  previewStream: MediaStream | null;
  previewImageSrc?: string | null;
  statusToneClassName: string;
  tileToneClassName: string;
  error: string | null;
  inputsEnabled: boolean;
  videoInputs: MediaDeviceOption[];
  audioInputs: MediaDeviceOption[];
  selectedVideoInputId: string | null;
  selectedAudioInputId: string | null;
  onSelectVideoInput: (value: string | null) => void;
  onSelectAudioInput: (value: string | null) => void;
  onSelectImageFile?: (file: File | null) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const previewVideoTrackIdRef = useRef<string | null>(null);
  const [previewVideoReady, setPreviewVideoReady] = useState(false);
  const [isDraggingImage, setIsDraggingImage] = useState(false);
  const hasPreviewTrack = (input.previewStream?.getVideoTracks().length ?? 0) > 0;
  const hasPreviewVideo = hasPreviewTrack && previewVideoReady;
  const isImageTile = input.label === "IMAGE";
  const selectedVideoInputUnavailable = Boolean(
    input.selectedVideoInputId &&
      !input.videoInputs.some((device) => device.deviceId === input.selectedVideoInputId)
  );

  useEffect(() => {
    const element = videoRef.current;
    const nextVideoTrackId = input.previewStream?.getVideoTracks()[0]?.id ?? null;
    const videoTrackChanged = previewVideoTrackIdRef.current !== nextVideoTrackId;

    if (videoTrackChanged) {
      setPreviewVideoReady(false);
    }

    if (!element) {
      previewVideoTrackIdRef.current = nextVideoTrackId;
      return;
    }

    const markReady = () => {
      if (element.videoWidth > 0 && element.videoHeight > 0) {
        setPreviewVideoReady(true);
      }
    };

    element.srcObject = input.previewStream;
    previewVideoTrackIdRef.current = nextVideoTrackId;

    if (input.previewStream) {
      element.load();
      element.addEventListener("loadedmetadata", markReady);
      element.addEventListener("resize", markReady);
      markReady();
      void element.play().catch(() => undefined);
    }

    return () => {
      element.removeEventListener("loadedmetadata", markReady);
      element.removeEventListener("resize", markReady);
      if (element.srcObject === input.previewStream) {
        element.srcObject = null;
      }
    };
  }, [input.previewStream]);

  const handleImageDragEnter = (event: DragEvent<HTMLElement>) => {
    if (!isImageTile) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setIsDraggingImage(true);
  };

  const handleImageDragOver = (event: DragEvent<HTMLElement>) => {
    if (!isImageTile) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setIsDraggingImage(true);
  };

  const handleImageDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!isImageTile) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setIsDraggingImage(false);
    }
  };

  const handleImageDrop = (event: DragEvent<HTMLElement>) => {
    if (!isImageTile) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setIsDraggingImage(false);

    const droppedFile = Array.from(event.dataTransfer.files).find(isAcceptedImageFile);

    if (!droppedFile) {
      return;
    }

    input.onSelectImageFile?.(droppedFile);
  };

  return (
    <section
      role="button"
      tabIndex={0}
      onClick={input.onActivate}
      onDragEnter={handleImageDragEnter}
      onDragOver={handleImageDragOver}
      onDragLeave={handleImageDragLeave}
      onDrop={handleImageDrop}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          input.onActivate();
        }
      }}
      className={`mstv-source-tile overflow-hidden rounded-[24px] border bg-white/[0.03] transition ${
        isDraggingImage ? "border-sky-300/80 bg-sky-500/10" : input.tileToneClassName
      }`}
    >
      <div className="relative aspect-video bg-black">
        <video
          ref={videoRef}
          muted
          playsInline
          autoPlay
          className={`h-full w-full object-cover object-center ${hasPreviewVideo ? "opacity-100" : "opacity-0"}`}
        />
        {input.previewImageSrc ? (
          <img
            src={input.previewImageSrc}
            alt=""
            className="absolute inset-0 h-full w-full object-cover object-center"
          />
        ) : null}
        {!hasPreviewVideo && !input.previewImageSrc ? (
          <div className="absolute inset-0 flex items-center justify-center bg-black px-6 text-center">
            <p className="text-sm text-slate-400">
              {input.error
                ? input.error
                : isImageTile
                  ? "No image selected."
                  : !input.inputsEnabled
                  ? "Select a studio input to start preview."
                : selectedVideoInputUnavailable
                  ? "Selected video input unavailable."
                : input.selectedVideoInputId
                  ? "Opening selected video input..."
                  : "No video input selected."}
            </p>
          </div>
        ) : null}

        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
        {!isImageTile ? <AudioLevelMeter stream={input.previewStream} /> : null}

        {isImageTile && isDraggingImage ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center border-2 border-dashed border-sky-200/80 bg-sky-500/15">
            <span className="mstv-ui-badge border-transparent bg-sky-500 text-white shadow-[0_2px_10px_rgba(0,0,0,0.35)]">
              Glissez une image ici
            </span>
          </div>
        ) : null}

        <div className="absolute left-4 top-4 flex flex-wrap gap-2">
          <div
            className={`mstv-ui-badge border shadow-[0_2px_10px_rgba(0,0,0,0.35)] ${input.statusToneClassName}`}
          >
            {input.label}
          </div>
        </div>

        <div
          className="absolute bottom-0 left-0 right-0 p-4"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {isImageTile ? (
            <label
              className="mstv-ui-field relative inline-flex w-fit cursor-pointer gap-3 overflow-hidden border border-white/10 bg-black/80"
              onClick={(event) => event.stopPropagation()}
            >
              <span className="mstv-ui-label">Image</span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => {
                  event.stopPropagation();
                  const selectedFile = event.target.files?.[0] ?? null;

                  input.onSelectImageFile?.(
                    selectedFile && isAcceptedImageFile(selectedFile) ? selectedFile : null
                  );
                  event.currentTarget.value = "";
                }}
              />
            </label>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <label
                className="mstv-ui-field relative inline-flex w-fit gap-3 overflow-hidden border border-white/10 bg-black/80"
                onClick={(event) => event.stopPropagation()}
              >
                <span className="mstv-ui-label">Video Input</span>
                <span className="ml-auto inline-flex items-center justify-center text-slate-300">
                  <SelectorChevronIcon />
                </span>
                <select
                  value={input.selectedVideoInputId ?? ""}
                  aria-label="Video Input"
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => {
                    event.stopPropagation();
                    input.onSelectVideoInput(event.target.value || null);
                  }}
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                >
                  <option value="">No video</option>
                  {selectedVideoInputUnavailable ? (
                    <option value={input.selectedVideoInputId ?? ""}>Saved video unavailable</option>
                  ) : null}
                  {input.videoInputs.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label}
                    </option>
                  ))}
                </select>
              </label>

              <label
                className="mstv-ui-field relative inline-flex w-fit gap-3 overflow-hidden border border-white/10 bg-black/80"
                onClick={(event) => event.stopPropagation()}
              >
                <span className="mstv-ui-label">Audio Input</span>
                <span className="ml-auto inline-flex items-center justify-center text-slate-300">
                  <SelectorChevronIcon />
                </span>
                <select
                  value={input.selectedAudioInputId ?? ""}
                  aria-label="Audio Input"
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => {
                    event.stopPropagation();
                    input.onSelectAudioInput(event.target.value || null);
                  }}
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                >
                  <option value="">No audio</option>
                  {input.selectedAudioInputId &&
                  !input.audioInputs.some((device) => device.deviceId === input.selectedAudioInputId) ? (
                    <option value={input.selectedAudioInputId}>Saved audio unavailable</option>
                  ) : null}
                  {input.audioInputs.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function areGuestListsEqual(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sanitizeSessionSlug(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  return slug || "studio";
}

function formatDeviceLabel(
  device: MediaDeviceInfo,
  index: number,
  prefix: "Camera" | "Audio" | "Output"
) {
  return device.label || `${prefix} ${index + 1}`;
}

function buildSlideReceiverRequestUrl(host: string, port: string, command: "NEXT_SLIDE" | "PREV_SLIDE") {
  const trimmedHost = host.trim();

  if (!trimmedHost) {
    throw new Error("Receiver non configuré");
  }

  const url = new URL(trimmedHost.startsWith("http://") ? trimmedHost : `http://${trimmedHost}`);

  if (!url.port && port.trim()) {
    url.port = port.trim();
  }

  url.pathname = command === "NEXT_SLIDE" ? "/next" : "/prev";
  url.search = "";
  url.hash = "";

  return url.toString();
}

function buildSlideReceiverHealthUrl(host: string, port: string) {
  const trimmedHost = host.trim();

  if (!trimmedHost) {
    throw new Error("Receiver non configuré");
  }

  const url = new URL(trimmedHost.startsWith("http://") ? trimmedHost : `http://${trimmedHost}`);

  if (!url.port && port.trim()) {
    url.port = port.trim();
  }

  url.pathname = "/health";
  url.search = "";
  url.hash = "";

  return url.toString();
}

function setOverrideValue(
  overrides: Record<string, ReturnSource | undefined>,
  guestId: string,
  source?: ReturnSource
) {
  const nextOverrides = { ...overrides };

  if (source) {
    nextOverrides[guestId] = source;
  } else {
    delete nextOverrides[guestId];
  }

  return nextOverrides;
}

function sanitizeOverridesForProgramGuests(
  overrides: Record<string, ReturnSource | undefined>,
  programGuestIds: string[],
  globalReturnSource: ReturnSource
) {
  const programGuestIdSet = new Set(programGuestIds);

  return Object.fromEntries(
    Object.entries(overrides).filter(
      ([guestId, source]) => source && source !== globalReturnSource && !programGuestIdSet.has(guestId)
    )
  ) as Record<string, ReturnSource | undefined>;
}

function getConnectedGuestIds(
  snapshot: ProductionSnapshot | null,
  presentGuestIds: string[] | null
) {
  return (snapshot?.participants ?? [])
    .filter(
      (participant) =>
        participant.surfaceRole === "guest" &&
        participant.channel === "contribution" &&
        (presentGuestIds === null || presentGuestIds.includes(participant.participantId))
    )
    .map((participant) => participant.participantId);
}

function getEffectiveReturnSource(input: {
  guestId: string;
  programGuestIds: string[];
  globalReturnSource: ReturnSource;
  guestReturnOverrides: Record<string, ReturnSource | undefined>;
}) {
  if (input.programGuestIds.includes(input.guestId)) {
    return "STUDIO";
  }

  return input.guestReturnOverrides[input.guestId] ?? input.globalReturnSource;
}

const defaultGuestVideoFraming: GuestVideoFraming = {
  zoom: 1,
  x: 0,
  y: 0
};

function clampGuestVideoFraming(framing: GuestVideoFraming): GuestVideoFraming {
  const zoom = Math.max(1, Math.min(2, Number(framing.zoom.toFixed(2))));
  const maxOffset = Number(((zoom - 1) * 50).toFixed(1));

  return {
    zoom,
    x: Math.max(-maxOffset, Math.min(maxOffset, Number(framing.x.toFixed(1)))),
    y: Math.max(-maxOffset, Math.min(maxOffset, Number(framing.y.toFixed(1))))
  };
}

function getNextGuestVideoFraming(
  current: GuestVideoFraming | undefined,
  action: GuestVideoFramingAction
) {
  const base = current ?? defaultGuestVideoFraming;
  const positionStep = 3;

  switch (action) {
    case "zoom-in":
      return clampGuestVideoFraming({ ...base, zoom: base.zoom + 0.1 });
    case "zoom-out":
      return clampGuestVideoFraming({ ...base, zoom: base.zoom - 0.1 });
    case "up":
      return clampGuestVideoFraming({ ...base, y: base.y - positionStep });
    case "down":
      return clampGuestVideoFraming({ ...base, y: base.y + positionStep });
    case "left":
      return clampGuestVideoFraming({ ...base, x: base.x - positionStep });
    case "right":
      return clampGuestVideoFraming({ ...base, x: base.x + positionStep });
    case "reset":
      return defaultGuestVideoFraming;
  }
}

function getSingleEffectiveReturnSource(input: {
  snapshot: ProductionSnapshot | null;
  programGuestIds: string[];
  presentGuestIds: string[] | null;
}) {
  const guestIds = getConnectedGuestIds(input.snapshot, input.presentGuestIds);

  if (guestIds.length === 0 || !input.snapshot) {
    return null;
  }

  const effectiveSources = guestIds.map((guestId) =>
    getEffectiveReturnSource({
      guestId,
      programGuestIds: input.programGuestIds,
      globalReturnSource: input.snapshot!.globalReturnSource,
      guestReturnOverrides: input.snapshot!.guestReturnOverrides
    })
  );
const [firstSource] = effectiveSources;

  return effectiveSources.every((source) => source === firstSource) ? firstSource : null;
}

function formatRecordingDuration(elapsedMs: number) {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatFileSize(bytes?: number | null) {
  if (!bytes || bytes <= 0) {
    return null;
  }

  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} Go`;
  }

  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
  }

  return `${Math.round(bytes / 1024)} Ko`;
}

const topPanelClassName =
  "rounded-[18px] border border-white/[0.08] bg-black/60 px-4 py-3 text-sm text-slate-300 backdrop-blur-md";
const defaultSlideReceiverHost = "slides.local";
const defaultSlideReceiverPort = "4317";
const programRecordingActiveStates = new Set<ProgramRecordingStatus["state"]>([
  "starting",
  "recording",
  "stopping",
  "saving"
]);

function buildParticipantStateFromLiveKit(
  participant: RuntimeParticipantState,
  room: string,
  index: number,
  existing?: ProductionParticipantState
): ProductionParticipantState {
  const now = new Date().toISOString();

  return {
    room,
    roomName: `${room}--contribution`,
    participantId: participant.participantId,
    displayName: participant.displayName,
    surfaceRole: "guest",
    channel: "contribution",
    controlRole: participant.controlRole,
    connectionState: "connected",
    participantCount: existing?.participantCount ?? 0,
    videoTrackCount: existing?.videoTrackCount ?? (participant.cameraTrackState.published ? 1 : 0),
    cameraPublished: participant.cameraPublished,
    microphonePublished: participant.microphonePublished,
    cameraTrackState: participant.cameraTrackState,
    microphoneTrackState: participant.microphoneTrackState,
    hasProgramFeed: existing?.hasProgramFeed ?? false,
    isMicrophoneMutedByControl: existing?.isMicrophoneMutedByControl ?? false,
    joinedAt: existing?.joinedAt ?? now,
    arrivalIndex: existing?.arrivalIndex ?? index,
    lastSeen: now,
    updatedAt: now
  };
}

export function ControlRoomClient({ room }: ControlRoomClientProps) {
  const identities = useMemo(() => {
    const monitorInstanceId = crypto.randomUUID();
    const programRoutingInstanceId = crypto.randomUUID();
    const studioReturnInstanceId = crypto.randomUUID();
    const regieReturnInstanceId = crypto.randomUUID();
    const imageReturnInstanceId = crypto.randomUUID();

    return {
      monitor: buildParticipantIdentity({
        room,
        surfaceRole: "control",
        channel: "contribution",
        controlRole: "operator",
        instanceId: monitorInstanceId
      }),
      programRouting: buildParticipantIdentity({
        room,
        surfaceRole: "control",
        channel: "program",
        controlRole: "operator",
        instanceId: programRoutingInstanceId
      }),
      returnFeeds: {
        STUDIO: buildParticipantIdentity({
          room,
          surfaceRole: "programFeed",
          channel: "program",
          instanceId: studioReturnInstanceId
        }),
        REGIE: buildParticipantIdentity({
          room,
          surfaceRole: "programFeed",
          channel: "program",
          instanceId: regieReturnInstanceId
        }),
        IMAGE: buildParticipantIdentity({
          room,
          surfaceRole: "programFeed",
          channel: "program",
          instanceId: imageReturnInstanceId
        })
      }
    };
  }, [room]);
  const [session, setSession] = useState<TokenResponsePayload | null>(null);
  const [programRoutingSession, setProgramRoutingSession] = useState<TokenResponsePayload | null>(null);
  const [returnFeedSessions, setReturnFeedSessions] = useState<
    Record<ReturnSource, TokenResponsePayload | null>
  >({
    STUDIO: null,
    REGIE: null,
    IMAGE: null
  });
  const [productionSnapshot, setProductionSnapshot] = useState<ProductionSnapshot | null>(null);
  const [programGuestIds, setProgramGuestIds] = useState<string[]>([]);
  const [programMutedGuestIds, setProgramMutedGuestIds] = useState<string[]>([]);
  const [regieMutedGuestIds, setRegieMutedGuestIds] = useState<string[]>([]);
  const [pipModeEnabled, setPipModeEnabled] = useState(false);
  const [slideControlEnabledGuestIds, setSlideControlEnabledGuestIds] = useState<string[]>([]);
  const [videoInputs, setVideoInputs] = useState<MediaDeviceOption[]>([]);
  const [audioInputs, setAudioInputs] = useState<MediaDeviceOption[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceOption[]>([]);
  const [programAudioOutputDeviceId, setProgramAudioOutputDeviceId] = useState(() =>
    loadStoredString(programAudioOutputStorageKey)
  );
  const [studioInputs, setStudioInputs] =
    useState<Record<ReturnSource, StudioInputConfig>>(loadStoredStudioInputs);
  const [returnInputsEnabled, setReturnInputsEnabled] = useState(false);
  const [presentGuestIds, setPresentGuestIds] = useState<string[] | null>(null);
  const [liveGuestStates, setLiveGuestStates] = useState<RuntimeParticipantState[]>([]);
  const [returnFeedPublisherStates, setReturnFeedPublisherStates] = useState<
    Record<ReturnSource, ReturnFeedPublisherState>
  >({
    STUDIO: { connectionState: "disconnected", videoActive: false, audioActive: false, error: null },
    REGIE: { connectionState: "disconnected", videoActive: false, audioActive: false, error: null },
    IMAGE: { connectionState: "disconnected", videoActive: false, audioActive: false, error: null }
  });
  const [returnPreviewStreams, setReturnPreviewStreams] = useState<Record<ReturnSource, MediaStream | null>>({
    STUDIO: null,
    REGIE: null,
    IMAGE: null
  });
  const [desktopConfig, setDesktopConfig] = useState<DesktopRuntimeConfig | null>(null);
  const [isDesktopRuntime, setIsDesktopRuntime] = useState(false);
  const [programDisplays, setProgramDisplays] = useState<DesktopProgramDisplay[]>([]);
  const [selectedProgramDisplayId, setSelectedProgramDisplayId] = useState<number | null>(
    loadStoredProgramDisplayId
  );
  const [isProgramWindowOpen, setIsProgramWindowOpen] = useState(false);
  const [guestLinkCopied, setGuestLinkCopied] = useState(false);
  const [sessionSlugDraft, setSessionSlugDraft] = useState(room || "studio");
  const [isApplyingSessionSlug, setIsApplyingSessionSlug] = useState(false);
  const [slideReceiverHost, setSlideReceiverHost] = useState(() =>
    loadStoredString(slideReceiverHostStorageKey, defaultSlideReceiverHost)
  );
  const [slideReceiverPort, setSlideReceiverPort] = useState(() =>
    loadStoredString(slideReceiverPortStorageKey, defaultSlideReceiverPort)
  );
  const [slideReceiverStatus, setSlideReceiverStatus] = useState<SlideReceiverStatus>({
    state: "idle",
    message: "Receiver non configuré"
  });
  const [lastSlideCommandFeedback, setLastSlideCommandFeedback] = useState<SlideCommandFeedback | null>(null);
  const [programRecordingCommand, setProgramRecordingCommand] =
    useState<ProgramRecordingCommand | null>(null);
  const [programRecordingStatus, setProgramRecordingStatus] = useState<ProgramRecordingStatus>({
    state: "idle",
    startedAt: null
  });
  const [programRecordingElapsedMs, setProgramRecordingElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const companionActionProcessingRef = useRef(false);

  const refreshMediaDevices = useCallback(async (requestPermissions: boolean) => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices) {
      return;
    }

    if (requestPermissions) {
      try {
        const permissionStream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true
        });

        permissionStream.getTracks().forEach((track) => track.stop());
      } catch (permissionError) {
        throw permissionError;
      }
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const nextVideoInputs = devices
      .filter((device) => device.kind === "videoinput")
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: formatDeviceLabel(device, index, "Camera")
      }));
    const nextAudioInputs = devices
      .filter((device) => device.kind === "audioinput")
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: formatDeviceLabel(device, index, "Audio")
      }));
    const nextAudioOutputs = devices
      .filter((device) => device.kind === "audiooutput")
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: formatDeviceLabel(device, index, "Output")
      }));

    setVideoInputs(nextVideoInputs);
    setAudioInputs(nextAudioInputs);
    setAudioOutputs(nextAudioOutputs);
  }, []);

  useEffect(() => {
    let active = true;

    async function loadSession() {
      try {
        const [
          monitorToken,
          programRoutingToken,
          studioReturnToken,
          regieReturnToken,
          imageReturnToken
        ] = await Promise.all([
          fetchLiveKitToken({
            room,
            participantId: identities.monitor.participantId,
            displayName: identities.monitor.displayName,
            surfaceRole: "control",
            channel: "contribution",
            controlRole: "operator"
          }),
          fetchLiveKitToken({
            room,
            participantId: identities.programRouting.participantId,
            displayName: identities.programRouting.displayName,
            surfaceRole: "control",
            channel: "program",
            controlRole: "operator"
          }),
          fetchLiveKitToken({
            room,
            participantId: identities.returnFeeds.STUDIO.participantId,
            displayName: "STUDIO",
            surfaceRole: "programFeed",
            channel: "program",
            sourceLabel: "STUDIO"
          }),
          fetchLiveKitToken({
            room,
            participantId: identities.returnFeeds.REGIE.participantId,
            displayName: "REGIE",
            surfaceRole: "programFeed",
            channel: "program",
            sourceLabel: "REGIE"
          }),
          fetchLiveKitToken({
            room,
            participantId: identities.returnFeeds.IMAGE.participantId,
            displayName: "IMAGE",
            surfaceRole: "programFeed",
            channel: "program",
            sourceLabel: "IMAGE"
          })
        ]);

        if (!active) {
          return;
        }

        setSession(monitorToken);
        setProgramRoutingSession(programRoutingToken);
        setReturnFeedSessions({
          STUDIO: studioReturnToken,
          REGIE: regieReturnToken,
          IMAGE: imageReturnToken
        });
      } catch (requestError) {
        if (!active) {
          return;
        }

        setError(
          requestError instanceof Error
            ? requestError.message
            : "Unable to initialize the control surface."
        );
      }
    }

    void loadSession();

    return () => {
      active = false;
    };
  }, [
    identities.monitor.displayName,
    identities.monitor.participantId,
    identities.programRouting.displayName,
    identities.programRouting.participantId,
    identities.returnFeeds.IMAGE.participantId,
    identities.returnFeeds.REGIE.participantId,
    identities.returnFeeds.STUDIO.participantId,
    room
  ]);

  useEffect(() => {
    let active = true;

    async function refreshSnapshot() {
      try {
        const snapshot = await fetchProductionSnapshot(room);

        if (!active) {
          return;
        }

        const nextProgramGuestIds = pipModeEnabled
          ? snapshot.programGuestIds.slice(0, 3)
          : snapshot.programGuestIds.slice(0, 1);

        setProductionSnapshot(snapshot);
        setProgramGuestIds((current) => {
          return areGuestListsEqual(current, nextProgramGuestIds) ? current : nextProgramGuestIds;
        });

        if (!pipModeEnabled && snapshot.programGuestIds.length > 1) {
          await updateProgramScene(room, nextProgramGuestIds);
        }
      } catch (snapshotError) {
        if (!active) {
          return;
        }

        setError(
          snapshotError instanceof Error
            ? snapshotError.message
            : "Unable to refresh production state."
        );
      }
    }

    void refreshSnapshot();

    const interval = window.setInterval(() => {
      void refreshSnapshot();
    }, 1500);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [pipModeEnabled, room]);

  useEffect(() => {
    setIsDesktopRuntime(
      typeof window !== "undefined" &&
        Boolean(window.mstvDesktop) &&
        navigator.userAgent.includes("Electron")
    );
  }, []);

  useEffect(() => {
    window.localStorage.setItem(slideReceiverHostStorageKey, slideReceiverHost);
  }, [slideReceiverHost]);

  useEffect(() => {
    window.localStorage.setItem(slideReceiverPortStorageKey, slideReceiverPort);
  }, [slideReceiverPort]);

  useEffect(() => {
    if (!programRecordingStatus.startedAt || programRecordingStatus.state !== "recording") {
      setProgramRecordingElapsedMs(0);
      return;
    }

    const updateElapsed = () => {
      setProgramRecordingElapsedMs(Date.now() - programRecordingStatus.startedAt!);
    };

    updateElapsed();
    const interval = window.setInterval(updateElapsed, 500);

    return () => {
      window.clearInterval(interval);
    };
  }, [programRecordingStatus.startedAt, programRecordingStatus.state]);

  useEffect(() => {
    if (!programRecordingStatus.filePath || programRecordingStatus.state !== "idle") {
      return;
    }

    const timeout = window.setTimeout(() => {
      setProgramRecordingStatus((current) =>
        current.state === "idle" && current.filePath === programRecordingStatus.filePath
          ? {
              state: "idle",
              startedAt: null
            }
          : current
      );
    }, 5000);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [programRecordingStatus.filePath, programRecordingStatus.state]);

  useEffect(() => {
    window.localStorage.setItem(programAudioOutputStorageKey, programAudioOutputDeviceId);
  }, [programAudioOutputDeviceId]);

  useEffect(() => {
    if (selectedProgramDisplayId === null) {
      window.localStorage.removeItem(programDisplayStorageKey);
      return;
    }

    window.localStorage.setItem(programDisplayStorageKey, String(selectedProgramDisplayId));
  }, [selectedProgramDisplayId]);

  useEffect(() => {
    window.localStorage.setItem(studioInputSettingsStorageKey, JSON.stringify({
      STUDIO: {
        videoDeviceId: studioInputs.STUDIO.videoDeviceId,
        audioDeviceId: studioInputs.STUDIO.audioDeviceId
      },
      REGIE: {
        videoDeviceId: studioInputs.REGIE.videoDeviceId,
        audioDeviceId: studioInputs.REGIE.audioDeviceId
      },
      IMAGE: {
        imageDataUrl: studioInputs.IMAGE.imageDataUrl ?? null,
        imageFileName: studioInputs.IMAGE.imageFileName ?? null
      }
    }));
  }, [studioInputs]);

  useEffect(() => {
    if (!slideReceiverHost.trim()) {
      return;
    }

    let active = true;

    async function pingSlideReceiver() {
      try {
        const url = buildSlideReceiverHealthUrl(slideReceiverHost, slideReceiverPort);
        const response = await fetch(url, {
          cache: "no-store"
        });

        if (!active || !response.ok) {
          return;
        }
      } catch {
        // The visible receiver status is still driven by actual command sends.
        // This heartbeat only lets the receiver app know MSTV Visio is using it.
      }
    }

    void pingSlideReceiver();

    const interval = window.setInterval(() => {
      void pingSlideReceiver();
    }, 10_000);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [slideReceiverHost, slideReceiverPort]);

  useEffect(() => {
    if (!isDesktopRuntime || !window.mstvDesktop) {
      return;
    }

    let active = true;

    async function loadProgramDisplays() {
      try {
        const response = await window.mstvDesktop!.getProgramDisplays();

        if (!active) {
          return;
        }

        setProgramDisplays(response.displays);
        setIsProgramWindowOpen(response.programWindow.isOpen);
        setSelectedProgramDisplayId((current) => {
          if (current !== null) {
            return current;
          }

          return (
            response.displays.find((display) => !display.isPrimary)?.id ??
            response.displays.find((display) => display.isPrimary)?.id ??
            response.displays[0]?.id ??
            null
          );
        });
      } catch (displayError) {
        if (active) {
          setError(
            displayError instanceof Error
              ? displayError.message
              : "Impossible de lister les écrans Program."
          );
        }
      }
    }

    void loadProgramDisplays();

    return () => {
      active = false;
    };
  }, [isDesktopRuntime]);

  useEffect(() => {
    void refreshMediaDevices(isDesktopRuntime).catch((mediaError) => {
      setError(mediaError instanceof Error ? mediaError.message : "Impossible d’accéder aux entrées audio/vidéo.");
    });

    if (typeof navigator === "undefined" || !navigator.mediaDevices) {
      return;
    }

    const handleDeviceChange = () => {
      void refreshMediaDevices(false).catch(() => undefined);
    };

    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);

    return () => {
      navigator.mediaDevices.removeEventListener("devicechange", handleDeviceChange);
    };
  }, [isDesktopRuntime, refreshMediaDevices]);

  useEffect(() => {
    setSessionSlugDraft(room || "studio");
  }, [room]);

  useEffect(() => {
    let active = true;

    async function loadDesktopConfig() {
      try {
        const response = await fetch("/api/desktop/config", {
          cache: "no-store"
        });

        if (!response.ok) {
          return;
        }

        const config = (await response.json()) as DesktopRuntimeConfig;

        if (active) {
          setDesktopConfig(config);
        }
      } catch {
        // Guest link display is helpful, but it must never block the control room.
      }
    }

    void loadDesktopConfig();

    return () => {
      active = false;
    };
  }, []);

  const globalReturnSource = productionSnapshot?.globalReturnSource ?? "STUDIO";
  const guestReturnOverrides = productionSnapshot?.guestReturnOverrides ?? {};
  const updateLocalProductionSnapshot = useCallback(
    (updater: (snapshot: ProductionSnapshot) => ProductionSnapshot) => {
      setProductionSnapshot((current) =>
        current
          ? {
              ...updater(current),
              updatedAt: new Date().toISOString()
            }
          : current
      );
    },
    []
  );

  const guests = useMemo(
    () => {
      const productionParticipantsById = new Map(
        (productionSnapshot?.participants ?? []).map((participant) => [
          participant.participantId,
          participant
        ])
      );
      const liveGuestStatesById = new Map(
        liveGuestStates.map((participant) => [participant.participantId, participant])
      );
      const participantSource =
        liveGuestStates.length > 0
          ? liveGuestStates.map((participant, index) =>
              buildParticipantStateFromLiveKit(
                participant,
                room,
                index,
                productionParticipantsById.get(participant.participantId)
              )
            )
          : (productionSnapshot?.participants ?? []);

      return participantSource
        .filter(
          (participant) =>
            participant.surfaceRole === "guest" &&
            participant.channel === "contribution" &&
            (presentGuestIds === null || presentGuestIds.includes(participant.participantId))
        )
        .map((guest) => {
          const selectionOrder = programGuestIds.indexOf(guest.participantId);
          const inProgram = selectionOrder >= 0;
          const effectiveReturnSource = getEffectiveReturnSource({
            guestId: guest.participantId,
            programGuestIds,
            globalReturnSource,
            guestReturnOverrides
          });
          const isActiveInRegie = !inProgram && effectiveReturnSource === "REGIE";
          const regieAudioMuted = regieMutedGuestIds.includes(guest.participantId);
          const activeRegieIndicator: MediaStatusIndicator = {
            tone: "green",
            label: "LIVE",
            detail: "LIVE",
            description: "Active in Régie monitoring."
          };
          const mutedRegieIndicator: MediaStatusIndicator = {
            tone: "red",
            label: "MUTED",
            detail: "MUTED_REGIE",
            description: "Muted from Régie monitoring."
          };

          return {
            participantId: guest.participantId,
            displayName: guest.displayName,
            inProgram,
            selectionOrder: inProgram ? selectionOrder + 1 : null,
            effectiveReturnSource,
            videoFraming:
              productionSnapshot?.guestVideoFraming?.[guest.participantId] ??
              defaultGuestVideoFraming,
            connectionQuality:
              liveGuestStatesById.get(guest.participantId)?.connectionQuality ?? "unknown",
            programAudioMuted: programMutedGuestIds.includes(guest.participantId),
            regieAudioMuted,
            returnSourceControlDisabled: inProgram,
            disconnectControlDisabled: inProgram,
            slideControlEnabled: slideControlEnabledGuestIds.includes(guest.participantId),
            cameraIndicator: isActiveInRegie
              ? activeRegieIndicator
              : computeVideoIndicator({
                  inProgram,
                  trackState: guest.cameraTrackState
                }),
            microphoneIndicator: isActiveInRegie
              ? regieAudioMuted
                ? mutedRegieIndicator
                : activeRegieIndicator
              : computeAudioIndicator({
                  inProgram,
                  trackState: guest.microphoneTrackState
                })
          };
        });
    },
    [
      globalReturnSource,
      guestReturnOverrides,
      liveGuestStates,
      presentGuestIds,
      productionSnapshot?.guestVideoFraming,
      productionSnapshot?.participants,
      programMutedGuestIds,
      regieMutedGuestIds,
      programGuestIds,
      room,
      slideControlEnabledGuestIds
    ]
  );
  const visuallyActiveReturnSources = useMemo(
    () => new Set<ReturnSource>(guests.map((guest) => guest.effectiveReturnSource)),
    [guests]
  );
  const activeRegieGuestIds = useMemo(
    () =>
      guests
        .filter((guest) => !guest.inProgram && guest.effectiveReturnSource === "REGIE")
        .map((guest) => guest.participantId),
    [guests]
  );
  const companionStatusPayload = useMemo(() => {
    const guestIndexById = new Map(
      guests.slice(0, 9).map((guest, index) => [guest.participantId, index + 1])
    );
    const toGuestIndexes = (guestIds: string[]) =>
      guestIds
        .map((guestId) => guestIndexById.get(guestId) ?? null)
        .filter((guestIndex): guestIndex is number => guestIndex !== null);
    const programGuestIndexes = toGuestIndexes(programGuestIds);
    const programMutedGuestIndexes = toGuestIndexes(
      programGuestIds.filter((guestId) => programMutedGuestIds.includes(guestId))
    );
    const regieGuestIndexes = toGuestIndexes(activeRegieGuestIds);
    const regieMutedGuestIndexes = toGuestIndexes(
      activeRegieGuestIds.filter((guestId) => regieMutedGuestIds.includes(guestId))
    );
    const audibleGuestIds = [...programGuestIds, ...activeRegieGuestIds];
    const globalMuteEnabled =
      audibleGuestIds.length > 0 &&
      programGuestIds.every((guestId) => programMutedGuestIds.includes(guestId)) &&
      activeRegieGuestIds.every((guestId) => regieMutedGuestIds.includes(guestId));

    return {
      pipEnabled: pipModeEnabled,
      globalMuteEnabled,
      programGuestIndexes,
      programMutedGuestIndexes,
      regieGuestIndexes,
      regieMutedGuestIndexes,
      connectedGuestCount: guests.length
    };
  }, [
    activeRegieGuestIds,
    guests,
    pipModeEnabled,
    programGuestIds,
    programMutedGuestIds,
    regieMutedGuestIds
  ]);
  const studioInputStatuses = {
    STUDIO: getStudioInputStatus("STUDIO"),
    REGIE: getStudioInputStatus("REGIE"),
    IMAGE: getStudioInputStatus("IMAGE")
  };
  const sanitizedSessionSlug = sanitizeSessionSlug(sessionSlugDraft);
  const sessionSlugNeedsSanitizing = sessionSlugDraft.trim() !== sanitizedSessionSlug;
  const guestPublicLink = desktopConfig
    ? desktopConfig.guestPublicBaseUrl
      ? `${desktopConfig.guestPublicBaseUrl.replace(/\/+$/, "")}/guest/${encodeURIComponent(room)}`
      : null
    : null;
  const guestPublicLinkWarning =
    desktopConfig && !desktopConfig.guestPublicBaseUrl
      ? "GUEST_PUBLIC_BASE_URL manquant dans .env.local"
      : null;
  const slideReceiverCompactStatus = slideReceiverHost.trim()
    ? slideReceiverStatus.state === "error" || slideReceiverStatus.state === "not-configured"
      ? "erreur"
      : "connecté"
    : "non configuré";
  const selectedProgramDisplayUnavailable = Boolean(
    selectedProgramDisplayId !== null &&
      !programDisplays.some((display) => display.id === selectedProgramDisplayId)
  );
  const selectedProgramAudioOutputUnavailable = Boolean(
    programAudioOutputDeviceId &&
      !audioOutputs.some((device) => device.deviceId === programAudioOutputDeviceId)
  );
  const controlTileGridClassName = isDesktopRuntime
    ? "grid grid-cols-3 gap-4"
    : "grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,260px),1fr))]";

  const handlePresentGuestIdsChange = useCallback((nextGuestIds: string[]) => {
    setPresentGuestIds((current) => {
      if (current && areGuestListsEqual(current, nextGuestIds)) {
        return current;
      }

      return nextGuestIds;
    });
  }, []);

  const handleLiveGuestStatesChange = useCallback((nextGuests: RuntimeParticipantState[]) => {
    setLiveGuestStates((current) => {
      if (JSON.stringify(current) === JSON.stringify(nextGuests)) {
        return current;
      }

      return nextGuests;
    });
  }, []);

  useEffect(() => {
    const activeRegieGuestIdSet = new Set(activeRegieGuestIds);

    setRegieMutedGuestIds((current) => {
      const next = current.filter((participantId) => activeRegieGuestIdSet.has(participantId));
      return areGuestListsEqual(current, next) ? current : next;
    });
  }, [activeRegieGuestIds]);

  useEffect(() => {
    let active = true;

    async function publishCompanionStatus() {
      try {
        await fetch("/api/companion/status", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(companionStatusPayload)
        });
      } catch {
        // Companion feedback is optional and must never affect live operation.
      }
    }

    if (active) {
      void publishCompanionStatus();
    }

    return () => {
      active = false;
    };
  }, [companionStatusPayload]);

  const routingPayload = useMemo(
    () =>
      productionSnapshot
          ? {
            type: "return-routing" as const,
            room,
            globalReturnSource,
            programGuestIds,
            programMutedGuestIds,
            regieMutedGuestIds,
            slideControlEnabledGuestIds,
            guestReturnOverrides,
            routingVersion: Date.parse(productionSnapshot.updatedAt) || Date.now()
          }
        : null,
    [
      globalReturnSource,
      guestReturnOverrides,
      productionSnapshot,
      programMutedGuestIds,
      regieMutedGuestIds,
      programGuestIds,
      room,
      slideControlEnabledGuestIds
    ]
  );

  const updateReturnFeedPublisherState = useCallback(
    (source: ReturnSource, state: Partial<ReturnFeedPublisherState>) => {
      setReturnFeedPublisherStates((current) => ({
        ...current,
        [source]: {
          ...current[source],
          ...state
        }
      }));
    },
    []
  );

  const updateReturnPreviewStream = useCallback((source: ReturnSource, stream: MediaStream | null) => {
    setReturnPreviewStreams((current) => ({
      ...current,
      [source]: stream
    }));
  }, []);

  useEffect(() => {
    if (presentGuestIds === null) {
      return;
    }

    const nextSelection = programGuestIds.filter((participantId) =>
      presentGuestIds.includes(participantId)
    );

    if (areGuestListsEqual(programGuestIds, nextSelection)) {
      setSlideControlEnabledGuestIds((current) =>
        current.filter((participantId) => presentGuestIds.includes(participantId))
      );
      setProgramMutedGuestIds((current) =>
        current.filter((participantId) => presentGuestIds.includes(participantId))
      );
      return;
    }

    setProgramGuestIds(nextSelection);
    setProgramMutedGuestIds((current) =>
      current.filter((participantId) => nextSelection.includes(participantId))
    );
    setSlideControlEnabledGuestIds((current) =>
      current.filter((participantId) => presentGuestIds.includes(participantId))
    );
    updateLocalProductionSnapshot((snapshot) => ({
      ...snapshot,
      programGuestIds: nextSelection,
      guestReturnOverrides: sanitizeOverridesForProgramGuests(
        snapshot.guestReturnOverrides,
        nextSelection,
        snapshot.globalReturnSource
      )
    }));
    void updateProgramScene(room, nextSelection).catch((updateError) => {
      setError(
        updateError instanceof Error ? updateError.message : "Unable to update the program scene."
      );
    });
  }, [presentGuestIds, programGuestIds, room, updateLocalProductionSnapshot]);

  useEffect(() => {
    setProgramMutedGuestIds((current) =>
      current.filter((participantId) => programGuestIds.includes(participantId))
    );
  }, [programGuestIds]);

  useEffect(() => {
    if (returnInputsEnabled) {
      return;
    }

    const hasConfiguredStudioInput = Object.values(studioInputs).some(
      (input) => input.videoDeviceId || input.audioDeviceId || input.imageDataUrl
    );

    if (!hasConfiguredStudioInput) {
      return;
    }

    setReturnInputsEnabled(true);
  }, [returnInputsEnabled, studioInputs]);

  async function handleToggleGuest(participantId: string) {
    const previousSelection = programGuestIds;
    const previousSnapshot = productionSnapshot;
    const previousProgramMutedGuestIds = programMutedGuestIds;
    const nextSelection = pipModeEnabled
      ? programGuestIds.includes(participantId)
        ? programGuestIds.filter((id) => id !== participantId)
        : programGuestIds.length < 3
          ? [...programGuestIds, participantId]
          : programGuestIds
      : programGuestIds.includes(participantId)
        ? []
        : [participantId];

    if (areGuestListsEqual(programGuestIds, nextSelection)) {
      return;
    }

    setProgramGuestIds(nextSelection);
    setProgramMutedGuestIds((current) =>
      current.filter((participantId) => nextSelection.includes(participantId))
    );
    updateLocalProductionSnapshot((snapshot) => ({
      ...snapshot,
      programGuestIds: nextSelection,
      guestReturnOverrides: sanitizeOverridesForProgramGuests(
        snapshot.guestReturnOverrides,
        nextSelection,
        snapshot.globalReturnSource
      )
    }));

    try {
      await updateProgramScene(room, nextSelection);
      setError(null);
    } catch (updateError) {
      setProgramGuestIds(previousSelection);
      setProgramMutedGuestIds(previousProgramMutedGuestIds);
      setProductionSnapshot(previousSnapshot);
      setError(
        updateError instanceof Error ? updateError.message : "Unable to update the program scene."
      );
    }
  }

  async function handleTogglePipMode() {
    const nextPipModeEnabled = !pipModeEnabled;
    setPipModeEnabled(nextPipModeEnabled);

    if (nextPipModeEnabled || programGuestIds.length <= 1) {
      return;
    }

    const previousSelection = programGuestIds;
    const previousSnapshot = productionSnapshot;
    const previousProgramMutedGuestIds = programMutedGuestIds;
    const nextSelection = programGuestIds.slice(0, 1);

    setProgramGuestIds(nextSelection);
    setProgramMutedGuestIds((current) =>
      current.filter((participantId) => nextSelection.includes(participantId))
    );
    updateLocalProductionSnapshot((snapshot) => ({
      ...snapshot,
      programGuestIds: nextSelection,
      guestReturnOverrides: sanitizeOverridesForProgramGuests(
        snapshot.guestReturnOverrides,
        nextSelection,
        snapshot.globalReturnSource
      )
    }));

    try {
      await updateProgramScene(room, nextSelection);
      setError(null);
    } catch (updateError) {
      setPipModeEnabled(true);
      setProgramGuestIds(previousSelection);
      setProgramMutedGuestIds(previousProgramMutedGuestIds);
      setProductionSnapshot(previousSnapshot);
      setError(
        updateError instanceof Error ? updateError.message : "Unable to update the program scene."
      );
    }
  }

  function handleToggleProgramRecording() {
    const isRecordingActive = programRecordingActiveStates.has(programRecordingStatus.state);

    setProgramRecordingCommand({
      action: isRecordingActive ? "stop" : "start",
      requestId: Date.now()
    });
  }

  function handleShowRecordingInFinder() {
    if (!programRecordingStatus.filePath || !window.mstvDesktop?.showItemInFolder) {
      return;
    }

    void window.mstvDesktop.showItemInFolder(programRecordingStatus.filePath).catch((finderError) => {
      setError(
        finderError instanceof Error
          ? finderError.message
          : "Impossible d’afficher l’enregistrement dans le Finder."
      );
    });
  }

  function handleToggleProgramAudioMute(participantId: string) {
    if (!programGuestIds.includes(participantId)) {
      return;
    }

    setProgramMutedGuestIds((current) =>
      current.includes(participantId)
        ? current.filter((id) => id !== participantId)
        : [...current, participantId]
    );
  }

  function handleToggleRegieAudioMute(participantId: string) {
    if (!activeRegieGuestIds.includes(participantId)) {
      return;
    }

    setRegieMutedGuestIds((current) =>
      current.includes(participantId)
        ? current.filter((id) => id !== participantId)
        : [...current, participantId]
    );
  }

  function handleToggleGuestSlideControl(participantId: string) {
    setSlideControlEnabledGuestIds((current) =>
      current.includes(participantId)
        ? current.filter((guestId) => guestId !== participantId)
        : [...current, participantId]
    );
  }

  function handleAdjustGuestVideoFraming(
    participantId: string,
    action: GuestVideoFramingAction
  ) {
    const currentFraming =
      productionSnapshot?.guestVideoFraming?.[participantId] ?? defaultGuestVideoFraming;
    const nextFraming = getNextGuestVideoFraming(currentFraming, action);

    updateLocalProductionSnapshot((snapshot) => ({
      ...snapshot,
      guestVideoFraming: {
        ...(snapshot.guestVideoFraming ?? {}),
        [participantId]: nextFraming
      }
    }));

    void updateGuestVideoFraming(room, participantId, nextFraming).catch((updateError) => {
      setError(
        updateError instanceof Error ? updateError.message : "Unable to update guest framing."
      );
    });
  }

  const forwardSlideCommandToReceiver = useCallback(
    async (message: SlideControlCommandMessage) => {
      if (!slideReceiverHost.trim()) {
        setSlideReceiverStatus({
          state: "not-configured",
          message: "Receiver non configuré"
        });
        return;
      }

      const directionLabel = message.command === "NEXT_SLIDE" ? "suivante" : "précédente";

      setSlideReceiverStatus({
        state: "sending",
        message: `Envoi slide ${directionLabel}...`
      });

      try {
        if (window.mstvDesktop?.sendSlideCommand) {
          await window.mstvDesktop.sendSlideCommand({
            host: slideReceiverHost,
            port: slideReceiverPort,
            command: message.command
          });
        } else {
          const url = buildSlideReceiverRequestUrl(
            slideReceiverHost,
            slideReceiverPort,
            message.command
          );
          const response = await fetch(url, {
            method: "POST"
          });

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
        }

        setSlideReceiverStatus({
          state: "success",
          message: `Slide ${directionLabel} envoyée`
        });
      } catch (receiverError) {
        setSlideReceiverStatus({
          state: "error",
          message:
            receiverError instanceof Error
              ? `Receiver inaccessible: ${receiverError.message}`
              : "Receiver inaccessible"
        });
      }
    },
    [slideReceiverHost, slideReceiverPort]
  );

  const handleSlideCommandReceived = useCallback((message: SlideControlCommandMessage) => {
    const label =
      message.command === "NEXT_SLIDE"
        ? `Slide suivante demandé par ${message.guestName}`
        : `Slide précédente demandé par ${message.guestName}`;

    setLastSlideCommandFeedback({
      id: message.commandId,
      label
    });

    window.setTimeout(() => {
      setLastSlideCommandFeedback((current) => (current?.id === message.commandId ? null : current));
    }, 3500);

    void forwardSlideCommandToReceiver(message);
  }, [forwardSlideCommandToReceiver]);

  function updateStudioInputDevice(
    inputId: ReturnSource,
    key: "videoDeviceId" | "audioDeviceId",
    value: string | null
  ) {
    setStudioInputs((current) => ({
      ...current,
      [inputId]: {
        ...current[inputId],
        [key]: value
      }
    }));

    if (value) {
      setReturnInputsEnabled(true);
      setError(null);
    }
  }

  async function handleSelectImageInput(file: File | null) {
    if (!file) {
      return;
    }

    try {
      const imageDataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.onerror = () => reject(reader.error ?? new Error("Unable to read image file."));
        reader.readAsDataURL(file);
      });

      setStudioInputs((current) => ({
        ...current,
        IMAGE: {
          ...current.IMAGE,
          imageDataUrl,
          imageFileName: file.name
        }
      }));
      setReturnInputsEnabled(true);
      setError(null);
    } catch (imageError) {
      setError(imageError instanceof Error ? imageError.message : "Unable to load image.");
    }
  }

  async function handleSelectGlobalReturnSource(source: ReturnSource) {
    const hasGuestOverrides = Object.keys(guestReturnOverrides).length > 0;

    if (globalReturnSource === source && !(source === "STUDIO" && hasGuestOverrides)) {
      return;
    }

    const previousSnapshot = productionSnapshot;

    updateLocalProductionSnapshot((snapshot) => ({
      ...snapshot,
      globalReturnSource: source,
      guestReturnOverrides: {}
    }));

    try {
      await updateGlobalReturnSource(room, source);
      setError(null);
    } catch (updateError) {
      setProductionSnapshot(previousSnapshot);
      setError(
        updateError instanceof Error ? updateError.message : "Unable to update the return source."
      );
    }
  }

  async function handleSelectGuestReturnSource(participantId: string, source: ReturnSource) {
    if (programGuestIds.includes(participantId)) {
      return;
    }

    const previousSnapshot = productionSnapshot;

    if (!previousSnapshot) {
      return;
    }

    const nextSource = source === globalReturnSource ? undefined : source;

    updateLocalProductionSnapshot((snapshot) => ({
      ...snapshot,
      guestReturnOverrides: setOverrideValue(
        snapshot.guestReturnOverrides,
        participantId,
        nextSource
      )
    }));

    try {
      const response = await updateGuestReturnOverride(room, participantId, nextSource);
      setProductionSnapshot((current) =>
        current
          ? {
              ...current,
              globalReturnSource: response.globalReturnSource,
              guestReturnOverrides: response.guestReturnOverrides,
              updatedAt: new Date().toISOString()
            }
          : current
      );
      setError(null);
    } catch (updateError) {
      setProductionSnapshot(previousSnapshot);
      setError(
        updateError instanceof Error
          ? updateError.message
          : "Unable to update the guest return override."
      );
    }
  }

  async function handleDisconnectGuest(participantId: string) {
    const guest = guests.find((item) => item.participantId === participantId);

    if (!guest) {
      return;
    }

    if (guest.inProgram) {
      return;
    }

    const confirmed = window.confirm(`Déconnecter ${guest.displayName} ?`);

    if (!confirmed) {
      return;
    }

    const previousSnapshot = productionSnapshot;
    const previousSelection = programGuestIds;
    const nextSelection = programGuestIds.filter((id) => id !== participantId);

    setProgramGuestIds(nextSelection);
    setProgramMutedGuestIds((current) => current.filter((guestId) => guestId !== participantId));
    setPresentGuestIds((current) =>
      current ? current.filter((guestId) => guestId !== participantId) : current
    );
    setSlideControlEnabledGuestIds((current) =>
      current.filter((guestId) => guestId !== participantId)
    );
    updateLocalProductionSnapshot((snapshot) => ({
      ...snapshot,
      programGuestIds: nextSelection,
      guestReturnOverrides: setOverrideValue(snapshot.guestReturnOverrides, participantId, undefined),
      participants: snapshot.participants.filter(
        (participant) => participant.participantId !== participantId
      )
    }));

    try {
      await disconnectGuest(room, participantId);
      setError(null);
    } catch (disconnectError) {
      setProgramGuestIds(previousSelection);
      setProductionSnapshot(previousSnapshot);
      setError(
        disconnectError instanceof Error ? disconnectError.message : "Unable to disconnect guest."
      );
    }
  }

  function getStudioInputStatus(inputId: ReturnSource) {
    const isActive = visuallyActiveReturnSources.has(inputId);

    return {
      toneClassName: isActive
        ? "border-transparent bg-sky-500 text-white"
        : "border-transparent bg-slate-600 text-white",
      tileToneClassName: isActive
        ? "border-sky-500 bg-white/[0.06]"
        : "border-slate-600 bg-white/[0.03] hover:border-slate-600 hover:bg-white/[0.05]"
    };
  }

  async function handleCopyGuestLink() {
    if (!guestPublicLink) {
      return;
    }

    try {
      try {
        await navigator.clipboard.writeText(guestPublicLink);
      } catch (browserClipboardError) {
        if (!window.mstvDesktop?.writeClipboardText) {
          throw browserClipboardError;
        }

        await window.mstvDesktop.writeClipboardText(guestPublicLink);
      }
      setGuestLinkCopied(true);
      window.setTimeout(() => setGuestLinkCopied(false), 1600);
    } catch {
      setError("Impossible de copier le lien invité.");
    }
  }

  async function handleApplySessionSlug() {
    if (isApplyingSessionSlug) {
      return;
    }

    const nextRoom = sanitizedSessionSlug;

    if (
      nextRoom !== room &&
      isProgramWindowOpen &&
      !window.confirm(
        "La sortie Program est ouverte. Elle va être fermée avant de changer de session."
      )
    ) {
      return;
    }

    setIsApplyingSessionSlug(true);

    try {
      if (nextRoom !== room && isProgramWindowOpen && window.mstvDesktop) {
        const response = await window.mstvDesktop.toggleProgramWindow(selectedProgramDisplayId, room);

        setProgramDisplays(response.displays);
        setIsProgramWindowOpen(response.programWindow.isOpen);
      }

      if (window.mstvDesktop?.setSessionSlug) {
        await window.mstvDesktop.setSessionSlug(nextRoom);
      } else {
        window.localStorage.setItem("mstv.sessionSlug", nextRoom);
      }
    } catch (programWindowError) {
      setError(
        programWindowError instanceof Error
          ? programWindowError.message
          : "Impossible d’appliquer cette session."
      );
      setIsApplyingSessionSlug(false);
      return;
    }

    setSessionSlugDraft(nextRoom);

    if (nextRoom !== room) {
      window.location.assign(`/control/${encodeURIComponent(nextRoom)}`);
      return;
    }

    setIsApplyingSessionSlug(false);
  }

  async function handleToggleProgramWindow() {
    if (!window.mstvDesktop) {
      return;
    }

    try {
      const response = await window.mstvDesktop.toggleProgramWindow(selectedProgramDisplayId, room);

      setProgramDisplays(response.displays);
      setIsProgramWindowOpen(response.programWindow.isOpen);
      setSelectedProgramDisplayId((current) => {
        if (current !== null) {
          return current;
        }

        return response.displays.find((display) => display.isPrimary)?.id ?? response.displays[0]?.id ?? null;
      });
      setError(null);
    } catch (programWindowError) {
      setError(
        programWindowError instanceof Error
          ? programWindowError.message
          : "Impossible de lancer la sortie Program."
      );
    }
  }

  async function executeCompanionAction(command: CompanionControlCommand) {
    switch (command.action.action) {
      case "selectGuest": {
        const guest = guests[command.action.guestIndex - 1];

        if (guest) {
          await handleToggleGuest(guest.participantId);
        }
        return;
      }
      case "togglePip":
        await handleTogglePipMode();
        return;
      case "muteAllProgramGuests":
        setProgramMutedGuestIds(programGuestIds);
        return;
      case "unmuteAllProgramGuests":
        setProgramMutedGuestIds([]);
        return;
      case "toggleMuteAllProgramGuests": {
        const allAudibleGuestIds = [...programGuestIds, ...activeRegieGuestIds];
        const hasUnmutedProgramGuest = programGuestIds.some(
          (guestId) => !programMutedGuestIds.includes(guestId)
        );
        const hasUnmutedRegieGuest = activeRegieGuestIds.some(
          (guestId) => !regieMutedGuestIds.includes(guestId)
        );
        const shouldMuteAll = allAudibleGuestIds.length > 0 && (hasUnmutedProgramGuest || hasUnmutedRegieGuest);

        setProgramMutedGuestIds(shouldMuteAll ? programGuestIds : []);
        setRegieMutedGuestIds(shouldMuteAll ? activeRegieGuestIds : []);
        return;
      }
    }
  }

  useEffect(() => {
    let active = true;

    async function pollCompanionActions() {
      if (companionActionProcessingRef.current) {
        return;
      }

      companionActionProcessingRef.current = true;

      try {
        const commands = await fetchPendingCompanionActions(room);

        for (const command of commands) {
          if (!active) {
            return;
          }

          await executeCompanionAction(command);
          await acknowledgeCompanionAction(command.id);
        }
      } catch {
        // Companion control must never interrupt live operation.
      } finally {
        companionActionProcessingRef.current = false;
      }
    }

    void pollCompanionActions();
    const interval = window.setInterval(() => {
      void pollCompanionActions();
    }, 300);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [guests, pipModeEnabled, productionSnapshot, programGuestIds, programMutedGuestIds, room]);

  return (
    <main
      className={`mstv-control min-h-screen bg-black text-white ${
        isDesktopRuntime ? "mstv-desktop-control" : ""
      }`}
    >
      <div className="bg-[#333333] px-4 py-4 md:px-6 md:py-6">
      <div className="mx-auto flex w-full max-w-[1680px] flex-col gap-4">
        {error ? (
          <div className="rounded-[18px] border border-tally/30 bg-tally/10 px-4 py-3 text-sm text-tally">
            {error}
          </div>
        ) : null}

        {programRecordingStatus.filePath && programRecordingStatus.state === "idle" ? (
          <div className="flex flex-wrap items-center gap-3 rounded-[18px] border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-white">
            <span className="mstv-ui-badge border-transparent bg-emerald-500 text-white">
              Enregistrement terminé
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-100">
              {programRecordingStatus.filePath}
            </span>
            {formatFileSize(programRecordingStatus.fileSizeBytes) ? (
              <span className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-200">
                {formatFileSize(programRecordingStatus.fileSizeBytes)}
              </span>
            ) : null}
            <button
              type="button"
              onClick={handleShowRecordingInFinder}
              className="mstv-ui-button border border-white/10 bg-white/10 text-white transition hover:bg-white/15"
            >
              Afficher dans le Finder
            </button>
          </div>
        ) : null}

        {programRecordingStatus.state === "error" && programRecordingStatus.error ? (
          <div className="flex flex-wrap items-center gap-3 rounded-[18px] border border-tally/30 bg-tally/10 px-4 py-3 text-sm text-white">
            <span className="mstv-ui-badge border-transparent bg-[#d4301f] text-white">
              Échec de l’enregistrement
            </span>
            <span className="min-w-0 flex-1 text-sm text-slate-100">
              {programRecordingStatus.error}
            </span>
          </div>
        ) : null}

        {desktopConfig ? (
          <div className={`flex flex-wrap items-center gap-3 ${topPanelClassName}`}>
            <span className="mstv-ui-label">
              Lien invité
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-200">
              {guestPublicLink ?? guestPublicLinkWarning}
            </span>
            <form
              className="contents"
              onSubmit={(event) => {
                event.preventDefault();
                void handleApplySessionSlug();
              }}
            >
              <label className="mstv-ui-field min-w-[260px] gap-3 border border-white/10 bg-black">
                <span className="mstv-ui-label">Session</span>
                <input
                  value={sessionSlugDraft}
                  onChange={(event) => setSessionSlugDraft(event.target.value)}
                  placeholder="studio"
                  className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-slate-600"
                />
              </label>
              {sessionSlugNeedsSanitizing ? (
                <span className="text-xs text-slate-500">
                  Suggestion : {sanitizedSessionSlug}
                </span>
              ) : null}
              <button
                type="submit"
                disabled={isApplyingSessionSlug}
                className="mstv-ui-button border border-white/10 bg-white/10 text-white transition hover:bg-white/15 disabled:cursor-wait disabled:opacity-60"
              >
                Appliquer
              </button>
            </form>
            <button
              type="button"
              onClick={() => {
                void handleCopyGuestLink();
              }}
              disabled={!guestPublicLink}
              className="mstv-ui-button border border-white/10 bg-white/10 text-white transition hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {guestLinkCopied ? "Copié" : "Copier"}
            </button>
          </div>
        ) : null}

        {isDesktopRuntime ? (
          <div className={`flex flex-wrap items-center gap-3 ${topPanelClassName}`}>
            <label className="mstv-ui-field w-[320px] max-w-full gap-3 border border-white/10 bg-black">
              <span className="mstv-ui-label shrink-0">
                Video Program
              </span>
              <select
                value={selectedProgramDisplayId ?? ""}
                onChange={(event) => {
                  setSelectedProgramDisplayId(Number(event.target.value));
                }}
                disabled={isProgramWindowOpen}
                className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none disabled:opacity-60"
              >
                {selectedProgramDisplayUnavailable ? (
                  <option value={selectedProgramDisplayId ?? ""}>
                    Écran sauvegardé indisponible
                  </option>
                ) : null}
                {programDisplays.map((display) => (
                  <option key={display.id} value={display.id}>
                    {display.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="mstv-ui-field w-[320px] max-w-full gap-3 border border-white/10 bg-black">
              <span className="mstv-ui-label shrink-0">
                Audio Program
              </span>
              <select
                value={programAudioOutputDeviceId}
                onChange={(event) => setProgramAudioOutputDeviceId(event.target.value)}
                className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none"
              >
                <option value="">Sortie système</option>
                {selectedProgramAudioOutputUnavailable ? (
                  <option value={programAudioOutputDeviceId}>
                    Sortie sauvegardée indisponible
                  </option>
                ) : null}
                {audioOutputs.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
              </select>
            </label>
            {audioOutputs.length === 0 ? (
              <span className="text-xs text-slate-500">
                Sélection de sortie audio indisponible sur ce runtime.
              </span>
            ) : null}
            <div className="ml-auto flex items-center gap-3">
              <button
                type="button"
                onClick={handleToggleProgramRecording}
                className={`mstv-ui-button inline-flex items-center gap-2 border transition ${
                  programRecordingActiveStates.has(programRecordingStatus.state)
                    ? "border-transparent bg-[#d4301f] text-white hover:bg-[#e13a28]"
                    : "border-white/10 bg-white/10 text-slate-300 hover:border-white/20 hover:text-white"
                }`}
              >
                {programRecordingStatus.state === "recording" ? (
                  <span className="h-2 w-2 rounded-full bg-white" />
                ) : null}
                <span>
                  {programRecordingActiveStates.has(programRecordingStatus.state)
                    ? `Stop ${formatRecordingDuration(programRecordingElapsedMs)}`
                    : "Rec"}
                </span>
              </button>
              <button
                type="button"
                aria-pressed={pipModeEnabled}
                onClick={() => {
                  void handleTogglePipMode();
                }}
                className={`mstv-ui-button border transition ${
                  pipModeEnabled
                    ? "border-emerald-500 bg-emerald-500 text-white hover:bg-emerald-400"
                    : "border-white/10 bg-white/10 text-slate-300 hover:border-white/20 hover:text-white"
                }`}
              >
                PIP
              </button>
            <button
              type="button"
              onClick={() => {
                void handleToggleProgramWindow();
              }}
              className={`mstv-ui-button inline-flex items-center gap-2 border transition ${
                isProgramWindowOpen
                  ? "border-air/30 bg-air/10 text-air hover:bg-air/15"
                  : "border-white/10 bg-white/10 text-slate-300 hover:border-white/20 hover:text-white"
              }`}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
              >
                <rect x="3" y="4" width="18" height="12" rx="2" />
                <path d="M8 20h8" />
                <path d="M12 16v4" />
              </svg>
              <span>Diffuser</span>
            </button>
            </div>
          </div>
        ) : (
          <div className={`flex flex-wrap items-center gap-3 ${topPanelClassName}`}>
            <span className="mstv-ui-label">
              Audio Program
            </span>
            <select
              value={programAudioOutputDeviceId}
              onChange={(event) => setProgramAudioOutputDeviceId(event.target.value)}
              className="mstv-ui-field min-w-[260px] border border-white/10 bg-black text-white outline-none"
            >
              <option value="">Sortie système</option>
              {selectedProgramAudioOutputUnavailable ? (
                <option value={programAudioOutputDeviceId}>
                  Sortie sauvegardée indisponible
                </option>
              ) : null}
              {audioOutputs.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              aria-pressed={pipModeEnabled}
              onClick={() => {
                void handleTogglePipMode();
              }}
              className={`mstv-ui-button ml-auto border transition ${
                pipModeEnabled
                  ? "border-emerald-500 bg-emerald-500 text-white hover:bg-emerald-400"
                  : "border-white/10 bg-white/10 text-slate-300 hover:border-white/20 hover:text-white"
              }`}
            >
              PIP
            </button>
          </div>
        )}

        <details className={topPanelClassName}>
          <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3">
            <span className="mstv-ui-label">
              Réglages slides
            </span>
            {lastSlideCommandFeedback ? (
              <span className="text-xs text-slate-400">{lastSlideCommandFeedback.label}</span>
            ) : null}
            <span
              className={`mstv-ui-badge ml-auto border ${
                slideReceiverCompactStatus === "connecté"
                  ? "border-transparent bg-emerald-500 text-white"
                  : slideReceiverCompactStatus === "erreur"
                    ? "border-transparent bg-tally text-white"
                    : "border-transparent bg-slate-600 text-white"
              }`}
            >
              Slides : {slideReceiverCompactStatus}
            </span>
          </summary>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <input
              value={slideReceiverHost}
              onChange={(event) => setSlideReceiverHost(event.target.value)}
              placeholder="slides.local"
              className="mstv-ui-field min-w-[220px] flex-1 border border-white/10 bg-black text-white outline-none placeholder:text-slate-600"
            />
            <input
              value={slideReceiverPort}
              onChange={(event) => setSlideReceiverPort(event.target.value)}
              placeholder="4317"
              inputMode="numeric"
              className="mstv-ui-field w-24 border border-white/10 bg-black text-white outline-none placeholder:text-slate-600"
            />
            {slideReceiverStatus.state !== "idle" ? (
              <span className="mstv-ui-badge border border-white/10 bg-black/40 text-slate-400">
                {slideReceiverStatus.message}
              </span>
            ) : null}
          </div>
        </details>

        <div className={controlTileGridClassName}>
            <StudioInputTile
              label={studioInputs.STUDIO.label}
              isActive={visuallyActiveReturnSources.has("STUDIO")}
              onActivate={() => {
                void handleSelectGlobalReturnSource("STUDIO");
              }}
              previewStream={returnPreviewStreams.STUDIO}
              statusToneClassName={studioInputStatuses.STUDIO.toneClassName}
              tileToneClassName={studioInputStatuses.STUDIO.tileToneClassName}
              error={returnFeedPublisherStates.STUDIO.error}
              inputsEnabled={returnInputsEnabled}
              videoInputs={videoInputs}
              audioInputs={audioInputs}
              selectedVideoInputId={studioInputs.STUDIO.videoDeviceId}
              selectedAudioInputId={studioInputs.STUDIO.audioDeviceId}
              onSelectVideoInput={(value) => {
                updateStudioInputDevice("STUDIO", "videoDeviceId", value);
              }}
              onSelectAudioInput={(value) => {
                updateStudioInputDevice("STUDIO", "audioDeviceId", value);
              }}
            />
            <StudioInputTile
              label={studioInputs.REGIE.label}
              isActive={visuallyActiveReturnSources.has("REGIE")}
              onActivate={() => {
                void handleSelectGlobalReturnSource("REGIE");
              }}
              previewStream={returnPreviewStreams.REGIE}
              statusToneClassName={studioInputStatuses.REGIE.toneClassName}
              tileToneClassName={studioInputStatuses.REGIE.tileToneClassName}
              error={returnFeedPublisherStates.REGIE.error}
              inputsEnabled={returnInputsEnabled}
              videoInputs={videoInputs}
              audioInputs={audioInputs}
              selectedVideoInputId={studioInputs.REGIE.videoDeviceId}
              selectedAudioInputId={studioInputs.REGIE.audioDeviceId}
              onSelectVideoInput={(value) => {
                updateStudioInputDevice("REGIE", "videoDeviceId", value);
              }}
              onSelectAudioInput={(value) => {
                updateStudioInputDevice("REGIE", "audioDeviceId", value);
              }}
            />
            <StudioInputTile
              label={studioInputs.IMAGE.label}
              isActive={visuallyActiveReturnSources.has("IMAGE")}
              onActivate={() => {
                void handleSelectGlobalReturnSource("IMAGE");
              }}
              previewStream={null}
              previewImageSrc={studioInputs.IMAGE.imageDataUrl ?? null}
              statusToneClassName={studioInputStatuses.IMAGE.toneClassName}
              tileToneClassName={studioInputStatuses.IMAGE.tileToneClassName}
              error={null}
              inputsEnabled={returnInputsEnabled}
              videoInputs={videoInputs}
              audioInputs={audioInputs}
              selectedVideoInputId={null}
              selectedAudioInputId={null}
              onSelectVideoInput={() => undefined}
              onSelectAudioInput={() => undefined}
              onSelectImageFile={(file) => {
                void handleSelectImageInput(file);
              }}
            />
          </div>
        </div>
      </div>

      <div className="px-4 py-4 md:px-6 md:py-6">
      <div className="mx-auto flex w-full max-w-[1680px] flex-col gap-4">

        <ControlGuestGridSurface
          session={session}
          channel="contribution"
          guests={guests}
          onToggleGuest={handleToggleGuest}
          onToggleProgramAudioMute={handleToggleProgramAudioMute}
          onToggleRegieAudioMute={handleToggleRegieAudioMute}
          onToggleGuestSlideControl={handleToggleGuestSlideControl}
          onAdjustGuestVideoFraming={handleAdjustGuestVideoFraming}
          onSelectGuestReturnSource={handleSelectGuestReturnSource}
          onDisconnectGuest={handleDisconnectGuest}
          onPresentGuestIdsChange={handlePresentGuestIdsChange}
          onLiveGuestStatesChange={handleLiveGuestStatesChange}
          recordingCommand={programRecordingCommand}
          onRecordingStatusChange={(status) => {
            setProgramRecordingStatus(status);
          }}
          programAudioOutputDeviceId={programAudioOutputDeviceId}
          regieMonitorOutputDeviceId=""
          gridClassName={controlTileGridClassName}
        />

        <ControlProgramRoutingBridge
          session={programRoutingSession}
          channel="program"
          routingPayload={routingPayload}
          onSlideCommandReceived={handleSlideCommandReceived}
        />

        <ControlReturnFeedPublisher
          session={returnFeedSessions.STUDIO}
          videoDeviceId={returnInputsEnabled ? studioInputs.STUDIO.videoDeviceId : null}
          audioDeviceId={returnInputsEnabled ? studioInputs.STUDIO.audioDeviceId : null}
          enabled={
            returnInputsEnabled &&
            Boolean(studioInputs.STUDIO.videoDeviceId || studioInputs.STUDIO.audioDeviceId)
          }
          onStateChange={(state) => updateReturnFeedPublisherState("STUDIO", state)}
          onPreviewStreamChange={(stream) => updateReturnPreviewStream("STUDIO", stream)}
        />
        <ControlReturnFeedPublisher
          session={returnFeedSessions.REGIE}
          videoDeviceId={returnInputsEnabled ? studioInputs.REGIE.videoDeviceId : null}
          audioDeviceId={returnInputsEnabled ? studioInputs.REGIE.audioDeviceId : null}
          enabled={
            returnInputsEnabled &&
            Boolean(studioInputs.REGIE.videoDeviceId || studioInputs.REGIE.audioDeviceId)
          }
          onStateChange={(state) => updateReturnFeedPublisherState("REGIE", state)}
          onPreviewStreamChange={(stream) => updateReturnPreviewStream("REGIE", stream)}
        />
        <ControlReturnFeedPublisher
          session={returnFeedSessions.IMAGE}
          videoDeviceId={null}
          audioDeviceId={null}
          imageDataUrl={returnInputsEnabled ? studioInputs.IMAGE.imageDataUrl ?? null : null}
          enabled={returnInputsEnabled && Boolean(studioInputs.IMAGE.imageDataUrl)}
          onStateChange={(state) => updateReturnFeedPublisherState("IMAGE", state)}
          onPreviewStreamChange={(stream) => updateReturnPreviewStream("IMAGE", stream)}
        />
      </div>
      </div>
    </main>
  );
}
