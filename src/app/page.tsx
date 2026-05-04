import Link from "next/link";

const sampleRoom = "demo-studio";

export default function HomePage() {
  return (
    <main className="min-h-screen px-6 py-10 md:px-10">
      <div className="mx-auto flex max-w-6xl flex-col gap-8">
        <section className="panel-strong rounded-[28px] p-8 shadow-panel">
          <p className="text-sm uppercase tracking-[0.28em] text-air">MSTV Visio</p>
          <h1 className="mt-3 max-w-3xl text-4xl font-semibold tracking-tight md:text-6xl">
            Studio-first routing for remote contribution, not a generic meeting room.
          </h1>
          <p className="mt-4 max-w-3xl text-base leading-7 text-slate-300 md:text-lg">
            The scaffold separates guest contribution from studio program return so guests never
            subscribe to each other directly.
          </p>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            <Link
              href={`/guest/${sampleRoom}`}
              className="rounded-2xl border border-air/20 bg-air/10 p-5 transition hover:bg-air/15"
            >
              <p className="text-xs uppercase tracking-[0.25em] text-air">Guest Surface</p>
              <p className="mt-3 text-lg font-medium">Publish contribution and receive program return</p>
            </Link>
            <Link
              href={`/control/${sampleRoom}`}
              className="rounded-2xl border border-signal/20 bg-signal/10 p-5 transition hover:bg-signal/15"
            >
              <p className="text-xs uppercase tracking-[0.25em] text-signal">Control Surface</p>
              <p className="mt-3 text-lg font-medium">Monitor all guests and the live program path</p>
            </Link>
            <Link
              href={`/program/${sampleRoom}`}
              className="rounded-2xl border border-slate-400/20 bg-slate-400/10 p-5 transition hover:bg-slate-400/15"
            >
              <p className="text-xs uppercase tracking-[0.25em] text-slate-300">Program Surface</p>
              <p className="mt-3 text-lg font-medium">Confidence monitor for the downstream studio return</p>
            </Link>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-2">
          <article className="panel rounded-[24px] p-6">
            <p className="text-xs uppercase tracking-[0.25em] text-signal">Transport Model</p>
            <p className="mt-3 text-lg text-slate-200">
              Every room slug expands into two LiveKit rooms: one for contribution, one for
              program. This keeps asymmetric routing structural rather than optional.
            </p>
          </article>
          <article className="panel rounded-[24px] p-6">
            <p className="text-xs uppercase tracking-[0.25em] text-air">Implementation Notes</p>
            <p className="mt-3 text-lg text-slate-200">
              Token grants are created on Node.js API routes and scoped by route surface and
              channel. The UI is intentionally operator-first and avoids meeting-style galleries.
            </p>
          </article>
        </section>
      </div>
    </main>
  );
}
