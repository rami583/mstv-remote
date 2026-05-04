export const surfaceRoles = ["guest", "control", "program", "programFeed"] as const;
export type SurfaceRole = (typeof surfaceRoles)[number];

export const controlRoles = ["operator", "producer", "supervisor", "engineer"] as const;
export type ControlRole = (typeof controlRoles)[number];

export const sessionChannels = ["contribution", "program"] as const;
export type SessionChannel = (typeof sessionChannels)[number];

export interface StudioIdentity {
  room: string;
  participantId: string;
  displayName: string;
  surfaceRole: SurfaceRole;
  controlRole?: ControlRole;
}

export interface SurfaceDescriptor {
  surfaceRole: SurfaceRole;
  label: string;
  deliveryPolicy:
    | "publish-contribution-only"
    | "publish-program-only"
    | "subscribe-program-only"
    | "monitor-all";
}

export const surfaceDescriptors: Record<SurfaceRole, SurfaceDescriptor> = {
  guest: {
    surfaceRole: "guest",
    label: "Guest Surface",
    deliveryPolicy: "publish-contribution-only"
  },
  control: {
    surfaceRole: "control",
    label: "Control Surface",
    deliveryPolicy: "monitor-all"
  },
  program: {
    surfaceRole: "program",
    label: "Program Surface",
    deliveryPolicy: "subscribe-program-only"
  },
  programFeed: {
    surfaceRole: "programFeed",
    label: "Program Feed Publisher",
    deliveryPolicy: "publish-program-only"
  }
};
