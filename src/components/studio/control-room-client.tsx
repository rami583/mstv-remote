"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  ControlGuestGridSurface,
  ControlProgramRoutingBridge,
  ControlReturnFeedPublisher,
  type ReturnFeedPublisherDebugState,
  type ReturnFeedPublisherState
} from "@/components/livekit/minimal-studio-surfaces";
import { fetchLiveKitToken } from "@/lib/livekit/browser-token";
import { buildParticipantIdentity } from "@/lib/livekit/identity";
import {
  computeAudioIndicator,
  computeVideoIndicator
} from "@/lib/studio/media-status";
import {
  fetchProductionSnapshot,
  disconnectGuest,
  updateGlobalReturnSource,
  updateGuestReturnOverride,
  updateProgramScene
} from "@/lib/studio/control-plane";
import type { TokenResponsePayload } from "@/lib/types/livekit";
import type {
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
      writeClipboardText?: (text: string) => Promise<{ ok: boolean }>;
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

function useStudioInputPreview(videoDeviceId: string | null, enabled: boolean) {
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let currentStream: MediaStream | null = null;

    async function loadPreview() {
      if (!enabled || !videoDeviceId) {
        setPreviewStream(null);
        setError(null);
        return;
      }

      try {
        console.info("[MSTV Control] Preview getUserMedia requesting", JSON.stringify({
          videoDeviceId
        }));
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: videoDeviceId } },
          audio: false
        });
        console.info("[MSTV Control] Preview getUserMedia resolved", JSON.stringify({
          videoDeviceId,
          videoTracks: stream.getVideoTracks().map((track) => ({
            label: track.label,
            readyState: track.readyState,
            muted: track.muted
          }))
        }));

        if (!active) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        currentStream = stream;
        setPreviewStream(stream);
        setError(null);
      } catch (previewError) {
        if (!active) {
          return;
        }

        console.info("[MSTV Control] Preview getUserMedia failed", JSON.stringify({
          videoDeviceId,
          name: previewError instanceof DOMException ? previewError.name : previewError instanceof Error ? previewError.name : null,
          message: previewError instanceof Error ? previewError.message : String(previewError)
        }));
        setPreviewStream(null);
        setError(
          previewError instanceof Error
            ? previewError.message
            : "Impossible d’ouvrir cette entrée vidéo."
        );
      }
    }

    void loadPreview();

    return () => {
      active = false;
      currentStream?.getTracks().forEach((track) => track.stop());
    };
  }, [enabled, videoDeviceId]);

  return {
    previewStream,
    error
  };
}

function isAcceptedImageFile(file: File) {
  const acceptedMimeTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
  const acceptedExtensions = /\.(png|jpe?g|webp)$/i;

  return acceptedMimeTypes.has(file.type) || acceptedExtensions.test(file.name);
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
  imageFileName?: string | null;
  onSelectVideoInput: (value: string | null) => void;
  onSelectAudioInput: (value: string | null) => void;
  onSelectImageFile?: (file: File | null) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [previewVideoReady, setPreviewVideoReady] = useState(false);
  const [isDraggingImage, setIsDraggingImage] = useState(false);
  const hasPreviewTrack = (input.previewStream?.getVideoTracks().length ?? 0) > 0;
  const hasPreviewVideo = hasPreviewTrack && previewVideoReady;
  const isImageTile = input.label === "IMAGE";

  useEffect(() => {
    const element = videoRef.current;

    setPreviewVideoReady(false);

    if (!element) {
      return;
    }

    const markReady = () => {
      if (element.videoWidth > 0 && element.videoHeight > 0) {
        setPreviewVideoReady(true);
      }
    };

    element.srcObject = input.previewStream;

    if (input.previewStream) {
      element.load();
      element.addEventListener("loadedmetadata", markReady);
      element.addEventListener("resize", markReady);
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
                : input.selectedVideoInputId
                  ? "Opening selected video input..."
                  : "No video input selected."}
            </p>
          </div>
        ) : null}

        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />

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
              className="mstv-ui-field w-full cursor-pointer gap-3 border border-white/10 bg-black/80"
              onClick={(event) => event.stopPropagation()}
            >
              <span className="mstv-ui-label">Image</span>
              <span className="min-w-0 flex-1 truncate text-sm text-white">
                {input.imageFileName ?? "Select image"}
              </span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
                className="hidden"
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
            <div className="grid gap-3 md:grid-cols-2">
              <label
                className="mstv-ui-field gap-3 border border-white/10 bg-black/80"
                onClick={(event) => event.stopPropagation()}
              >
                <span className="mstv-ui-label">Video Input</span>
                <select
                  value={input.selectedVideoInputId ?? ""}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => {
                    event.stopPropagation();
                    input.onSelectVideoInput(event.target.value || null);
                  }}
                  className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none"
                >
                  <option value="">No video</option>
                  {input.videoInputs.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label}
                    </option>
                  ))}
                </select>
              </label>

              <label
                className="mstv-ui-field gap-3 border border-white/10 bg-black/80"
                onClick={(event) => event.stopPropagation()}
              >
                <span className="mstv-ui-label">Audio Input</span>
                <select
                  value={input.selectedAudioInputId ?? ""}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => {
                    event.stopPropagation();
                    input.onSelectAudioInput(event.target.value || null);
                  }}
                  className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none"
                >
                  <option value="">No audio</option>
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

const topPanelClassName =
  "rounded-[18px] border border-white/[0.08] bg-black/60 px-4 py-3 text-sm text-slate-300 backdrop-blur-md";
const defaultSlideReceiverHost = "slides.local";
const defaultSlideReceiverPort = "4317";

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
  const [slideControlEnabledGuestIds, setSlideControlEnabledGuestIds] = useState<string[]>([]);
  const [videoInputs, setVideoInputs] = useState<MediaDeviceOption[]>([]);
  const [audioInputs, setAudioInputs] = useState<MediaDeviceOption[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceOption[]>([]);
  const [programAudioOutputDeviceId, setProgramAudioOutputDeviceId] = useState("");
  const [studioInputs, setStudioInputs] = useState<Record<ReturnSource, StudioInputConfig>>({
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
  });
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
  const [returnFeedDebugStates, setReturnFeedDebugStates] = useState<
    Record<ReturnSource, ReturnFeedPublisherDebugState>
  >({
    STUDIO: {
      selectedVideoDeviceId: null,
      selectedAudioDeviceId: null,
      getUserMediaState: "idle",
      getUserMediaError: null,
      videoTrackCreated: false,
      videoTrackReadyState: null,
      previewStreamHasVideo: false
    },
    REGIE: {
      selectedVideoDeviceId: null,
      selectedAudioDeviceId: null,
      getUserMediaState: "idle",
      getUserMediaError: null,
      videoTrackCreated: false,
      videoTrackReadyState: null,
      previewStreamHasVideo: false
    },
    IMAGE: {
      selectedVideoDeviceId: null,
      selectedAudioDeviceId: null,
      getUserMediaState: "idle",
      getUserMediaError: null,
      videoTrackCreated: false,
      videoTrackReadyState: null,
      previewStreamHasVideo: false
    }
  });
  const [returnPreviewStreams, setReturnPreviewStreams] = useState<Record<ReturnSource, MediaStream | null>>({
    STUDIO: null,
    REGIE: null,
    IMAGE: null
  });
  const [desktopConfig, setDesktopConfig] = useState<DesktopRuntimeConfig | null>(null);
  const [isDesktopRuntime, setIsDesktopRuntime] = useState(false);
  const [programDisplays, setProgramDisplays] = useState<DesktopProgramDisplay[]>([]);
  const [selectedProgramDisplayId, setSelectedProgramDisplayId] = useState<number | null>(null);
  const [isProgramWindowOpen, setIsProgramWindowOpen] = useState(false);
  const [guestLinkCopied, setGuestLinkCopied] = useState(false);
  const [sessionSlugDraft, setSessionSlugDraft] = useState(room || "studio");
  const [slideReceiverHost, setSlideReceiverHost] = useState(defaultSlideReceiverHost);
  const [slideReceiverPort, setSlideReceiverPort] = useState(defaultSlideReceiverPort);
  const [slideReceiverSettingsLoaded, setSlideReceiverSettingsLoaded] = useState(false);
  const [slideReceiverStatus, setSlideReceiverStatus] = useState<SlideReceiverStatus>({
    state: "idle",
    message: "Receiver non configuré"
  });
  const [lastSlideCommandFeedback, setLastSlideCommandFeedback] = useState<SlideCommandFeedback | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshMediaDevices = useCallback(async (requestPermissions: boolean) => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices) {
      console.info("[MSTV Control] mediaDevices unavailable");
      return;
    }

    if (requestPermissions) {
      try {
        console.info("[MSTV Control] Permission getUserMedia requesting");
        const permissionStream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true
        });

        console.info("[MSTV Control] Permission getUserMedia resolved", JSON.stringify({
          videoTrackCount: permissionStream.getVideoTracks().length,
          audioTrackCount: permissionStream.getAudioTracks().length
        }));
        permissionStream.getTracks().forEach((track) => track.stop());
      } catch (permissionError) {
        console.info("[MSTV Control] Permission getUserMedia failed", JSON.stringify({
          name: permissionError instanceof DOMException ? permissionError.name : permissionError instanceof Error ? permissionError.name : null,
          message: permissionError instanceof Error ? permissionError.message : String(permissionError)
        }));
        throw permissionError;
      }
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    console.info("[MSTV Control] enumerateDevices result", JSON.stringify({
      total: devices.length,
      videoInputs: devices.filter((device) => device.kind === "videoinput").length,
      audioInputs: devices.filter((device) => device.kind === "audioinput").length,
      audioOutputs: devices.filter((device) => device.kind === "audiooutput").length,
      labeledDevices: devices.filter((device) => Boolean(device.label)).length
    }));
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
    setProgramAudioOutputDeviceId((current) =>
      current && nextAudioOutputs.some((device) => device.deviceId === current) ? current : ""
    );
    setStudioInputs((current) => ({
      STUDIO: {
        ...current.STUDIO,
        videoDeviceId:
          current.STUDIO.videoDeviceId &&
          nextVideoInputs.some((device) => device.deviceId === current.STUDIO.videoDeviceId)
            ? current.STUDIO.videoDeviceId
            : nextVideoInputs[0]?.deviceId ?? null,
        audioDeviceId:
          current.STUDIO.audioDeviceId &&
          nextAudioInputs.some((device) => device.deviceId === current.STUDIO.audioDeviceId)
            ? current.STUDIO.audioDeviceId
            : nextAudioInputs[0]?.deviceId ?? null
      },
      REGIE: {
        ...current.REGIE,
        videoDeviceId:
          current.REGIE.videoDeviceId &&
          nextVideoInputs.some((device) => device.deviceId === current.REGIE.videoDeviceId)
            ? current.REGIE.videoDeviceId
            : nextVideoInputs[1]?.deviceId ?? null,
        audioDeviceId:
          current.REGIE.audioDeviceId &&
          nextAudioInputs.some((device) => device.deviceId === current.REGIE.audioDeviceId)
            ? current.REGIE.audioDeviceId
            : nextAudioInputs[1]?.deviceId ?? null
      },
      IMAGE: {
        ...current.IMAGE
      }
    }));
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

        setProductionSnapshot(snapshot);
        setProgramGuestIds((current) => {
          const next = snapshot.programGuestIds.slice(0, 3);
          return areGuestListsEqual(current, next) ? current : next;
        });
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
  }, [room]);

  useEffect(() => {
    setIsDesktopRuntime(
      typeof window !== "undefined" &&
        Boolean(window.mstvDesktop) &&
        navigator.userAgent.includes("Electron")
    );
  }, []);

  useEffect(() => {
    const savedHost = window.localStorage.getItem("mstv.slideReceiverHost");
    const savedPort = window.localStorage.getItem("mstv.slideReceiverPort");
    const savedProgramAudioOutput = window.localStorage.getItem("mstv.programAudioOutputDeviceId");

    setSlideReceiverHost(savedHost?.trim() ? savedHost : defaultSlideReceiverHost);
    setSlideReceiverPort(savedPort?.trim() ? savedPort : defaultSlideReceiverPort);

    if (savedProgramAudioOutput) {
      setProgramAudioOutputDeviceId(savedProgramAudioOutput);
    }

    setSlideReceiverSettingsLoaded(true);
  }, []);

  useEffect(() => {
    if (!slideReceiverSettingsLoaded) {
      return;
    }

    window.localStorage.setItem("mstv.slideReceiverHost", slideReceiverHost);
  }, [slideReceiverHost, slideReceiverSettingsLoaded]);

  useEffect(() => {
    if (!slideReceiverSettingsLoaded) {
      return;
    }

    window.localStorage.setItem("mstv.slideReceiverPort", slideReceiverPort);
  }, [slideReceiverPort, slideReceiverSettingsLoaded]);

  useEffect(() => {
    window.localStorage.setItem("mstv.programAudioOutputDeviceId", programAudioOutputDeviceId);
  }, [programAudioOutputDeviceId]);

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
          if (current && response.displays.some((display) => display.id === current)) {
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
  const singleEffectiveReturnSource = useMemo(
    () => {
      if (liveGuestStates.length > 0) {
        const effectiveSources = liveGuestStates.map((guest) =>
          getEffectiveReturnSource({
            guestId: guest.participantId,
            programGuestIds,
            globalReturnSource,
            guestReturnOverrides
          })
        );
        const [firstSource] = effectiveSources;

        return effectiveSources.every((source) => source === firstSource) ? firstSource : null;
      }

      return getSingleEffectiveReturnSource({
        snapshot: productionSnapshot,
        programGuestIds,
        presentGuestIds
      });
    },
    [
      globalReturnSource,
      guestReturnOverrides,
      liveGuestStates,
      presentGuestIds,
      productionSnapshot,
      programGuestIds
    ]
  );

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

          return {
            participantId: guest.participantId,
            displayName: guest.displayName,
            inProgram,
            selectionOrder: inProgram ? selectionOrder + 1 : null,
            effectiveReturnSource,
            returnSourceControlDisabled: inProgram,
            disconnectControlDisabled: inProgram,
            slideControlEnabled: slideControlEnabledGuestIds.includes(guest.participantId),
            cameraIndicator: computeVideoIndicator({
              inProgram,
              trackState: guest.cameraTrackState
            }),
            microphoneIndicator: computeAudioIndicator({
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
      productionSnapshot?.participants,
      programGuestIds,
      room,
      slideControlEnabledGuestIds
    ]
  );
  const visuallyActiveReturnSource = singleEffectiveReturnSource ?? (guests.length === 0 ? globalReturnSource : null);
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

  const routingPayload = useMemo(
    () =>
      productionSnapshot
          ? {
            type: "return-routing" as const,
            room,
            globalReturnSource,
            programGuestIds,
            slideControlEnabledGuestIds,
            guestReturnOverrides,
            routingVersion: Date.parse(productionSnapshot.updatedAt) || Date.now()
          }
        : null,
    [
      globalReturnSource,
      guestReturnOverrides,
      productionSnapshot,
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

  const updateReturnFeedDebugState = useCallback(
    (source: ReturnSource, state: Partial<ReturnFeedPublisherDebugState>) => {
      setReturnFeedDebugStates((current) => ({
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
      return;
    }

    setProgramGuestIds(nextSelection);
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
    const nextSelection = programGuestIds.includes(participantId)
      ? programGuestIds.filter((id) => id !== participantId)
      : programGuestIds.length < 3
        ? [...programGuestIds, participantId]
        : programGuestIds;

    if (areGuestListsEqual(programGuestIds, nextSelection)) {
      return;
    }

    setProgramGuestIds(nextSelection);
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
      setProductionSnapshot(previousSnapshot);
      setError(
        updateError instanceof Error ? updateError.message : "Unable to update the program scene."
      );
    }
  }

  function handleToggleGuestSlideControl(participantId: string) {
    setSlideControlEnabledGuestIds((current) =>
      current.includes(participantId)
        ? current.filter((guestId) => guestId !== participantId)
        : [...current, participantId]
    );
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
    const activeToneClassNames: Record<ReturnSource, string> = {
      STUDIO: "border-transparent bg-emerald-500 text-white",
      REGIE: "border-transparent bg-amber-500 text-white",
      IMAGE: "border-transparent bg-sky-500 text-white"
    };
    const activeTileClassNames: Record<ReturnSource, string> = {
      STUDIO: "border-emerald-500/60 bg-white/[0.06]",
      REGIE: "border-amber-500/60 bg-white/[0.06]",
      IMAGE: "border-sky-500/60 bg-white/[0.06]"
    };
    const isActive = inputId === visuallyActiveReturnSource;

    return {
      toneClassName: isActive ? activeToneClassNames[inputId] : "border-transparent bg-tally text-white",
      tileToneClassName: isActive
        ? activeTileClassNames[inputId]
        : "border-tally/30 bg-white/[0.03] hover:border-tally/40 hover:bg-white/[0.05]"
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
    const nextRoom = sanitizedSessionSlug;

    if (nextRoom === room) {
      setSessionSlugDraft(nextRoom);
      return;
    }

    if (
      isProgramWindowOpen &&
      !window.confirm(
        "La sortie Program est ouverte. Elle va être fermée avant de changer de session."
      )
    ) {
      return;
    }

    try {
      if (isProgramWindowOpen && window.mstvDesktop) {
        const response = await window.mstvDesktop.toggleProgramWindow(selectedProgramDisplayId, room);

        setProgramDisplays(response.displays);
        setIsProgramWindowOpen(response.programWindow.isOpen);
      }
    } catch (programWindowError) {
      setError(
        programWindowError instanceof Error
          ? programWindowError.message
          : "Impossible de fermer la sortie Program."
      );
      return;
    }

    window.location.assign(`/control/${encodeURIComponent(nextRoom)}`);
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
        if (current && response.displays.some((display) => display.id === current)) {
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

        {desktopConfig ? (
          <div className={`flex flex-wrap items-center gap-3 ${topPanelClassName}`}>
            <span className="mstv-ui-label">
              Lien invité
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-200">
              {guestPublicLink ?? guestPublicLinkWarning}
            </span>
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
              type="button"
              onClick={() => {
                void handleApplySessionSlug();
              }}
              className="mstv-ui-button border border-white/10 bg-white/10 text-white transition hover:bg-white/15"
            >
              Appliquer
            </button>
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
            <button
              type="button"
              onClick={() => {
                void handleToggleProgramWindow();
              }}
              className={`mstv-ui-button ml-auto border transition ${
                isProgramWindowOpen
                  ? "border-air/30 bg-air/10 text-air hover:bg-air/15"
                  : "border-white/10 bg-white/10 text-slate-300 hover:border-white/20 hover:text-white"
              }`}
            >
              Program
            </button>
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
              {audioOutputs.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                </option>
              ))}
            </select>
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
              isActive={visuallyActiveReturnSource === "STUDIO"}
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
              isActive={visuallyActiveReturnSource === "REGIE"}
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
              isActive={visuallyActiveReturnSource === "IMAGE"}
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
              imageFileName={studioInputs.IMAGE.imageFileName ?? null}
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
          onToggleGuestSlideControl={handleToggleGuestSlideControl}
          onSelectGuestReturnSource={handleSelectGuestReturnSource}
          onDisconnectGuest={handleDisconnectGuest}
          onPresentGuestIdsChange={handlePresentGuestIdsChange}
          onLiveGuestStatesChange={handleLiveGuestStatesChange}
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
          onDebugStateChange={(state) => updateReturnFeedDebugState("STUDIO", state)}
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
          onDebugStateChange={(state) => updateReturnFeedDebugState("REGIE", state)}
        />
        <ControlReturnFeedPublisher
          session={returnFeedSessions.IMAGE}
          videoDeviceId={null}
          audioDeviceId={null}
          imageDataUrl={returnInputsEnabled ? studioInputs.IMAGE.imageDataUrl ?? null : null}
          enabled={returnInputsEnabled && Boolean(studioInputs.IMAGE.imageDataUrl)}
          onStateChange={(state) => updateReturnFeedPublisherState("IMAGE", state)}
          onPreviewStreamChange={(stream) => updateReturnPreviewStream("IMAGE", stream)}
          onDebugStateChange={(state) => updateReturnFeedDebugState("IMAGE", state)}
        />
      </div>
      </div>
    </main>
  );
}
