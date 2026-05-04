import type { StudioMessage } from "@/lib/types/messaging";

interface MessageRailProps {
  title: string;
  messages: StudioMessage[];
}

const priorityClassNames: Record<StudioMessage["priority"], string> = {
  low: "border-slate-500/30 bg-slate-500/10 text-slate-200",
  normal: "border-air/30 bg-air/10 text-air",
  high: "border-signal/30 bg-signal/10 text-signal",
  critical: "border-tally/40 bg-tally/10 text-tally"
};

export function MessageRail({ title, messages }: MessageRailProps) {
  return (
    <section className="panel rounded-[24px] p-5 md:p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{title}</h2>
        <span className="text-xs uppercase tracking-[0.25em] text-slate-400">Cue Rail</span>
      </div>
      <div className="mt-5 flex flex-col gap-3">
        {messages.map((message) => (
          <article
            key={message.id}
            className="rounded-2xl border border-white/10 bg-white/[0.03] p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-slate-400">
                  {message.kind}
                </p>
                <p className="mt-2 text-sm leading-6 text-slate-100">{message.body}</p>
              </div>
              <span
                className={`rounded-full border px-3 py-1 text-[11px] font-medium uppercase tracking-[0.2em] ${priorityClassNames[message.priority]}`}
              >
                {message.priority}
              </span>
            </div>
            <div className="mt-3 flex items-center justify-between text-xs text-slate-400">
              <span>{message.from.label}</span>
              <span>{message.requiresAck ? "Ack required" : "Informational"}</span>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
