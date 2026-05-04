import type { ControlRole } from "@/lib/types/roles";

export const messageKinds = ["cue", "tally", "routing", "system", "ack"] as const;
export type MessageKind = (typeof messageKinds)[number];

export const messagePriorities = ["low", "normal", "high", "critical"] as const;
export type MessagePriority = (typeof messagePriorities)[number];

export type MessageTarget =
  | {
      type: "guest";
      guestIds: string[];
    }
  | {
      type: "control-room";
      controlRoles?: ControlRole[];
    }
  | {
      type: "program-log";
    };

export interface MessageSender {
  id: string;
  label: string;
  role: "system" | "operator" | "producer" | "supervisor" | "engineer";
}

export interface StudioMessage {
  id: string;
  room: string;
  kind: MessageKind;
  priority: MessagePriority;
  target: MessageTarget;
  body: string;
  createdAt: string;
  requiresAck: boolean;
  correlationId?: string;
  from: MessageSender;
}
