import type { StudioMessage } from "@/lib/types/messaging";

export function buildDemoMessageRail(room: string): StudioMessage[] {
  const now = new Date().toISOString();

  return [
    {
      id: `${room}-cue-ready`,
      room,
      kind: "cue",
      priority: "high",
      target: {
        type: "guest",
        guestIds: ["guest-a"]
      },
      body: "Stand by. Hold contribution steady for studio take in 10 seconds.",
      createdAt: now,
      requiresAck: true,
      from: {
        id: "op-1",
        label: "Operator Desk",
        role: "operator"
      }
    },
    {
      id: `${room}-routing-check`,
      room,
      kind: "routing",
      priority: "normal",
      target: {
        type: "control-room",
        controlRoles: ["operator", "engineer"]
      },
      body: "Program return path healthy. Contribution ingest jitter below threshold.",
      createdAt: now,
      requiresAck: false,
      from: {
        id: "sys-1",
        label: "Router Health",
        role: "system"
      }
    },
    {
      id: `${room}-tally`,
      room,
      kind: "tally",
      priority: "critical",
      target: {
        type: "program-log"
      },
      body: "Program bus active. Confidence monitor receiving downstream return.",
      createdAt: now,
      requiresAck: false,
      from: {
        id: "prod-1",
        label: "Line Producer",
        role: "producer"
      }
    }
  ];
}
