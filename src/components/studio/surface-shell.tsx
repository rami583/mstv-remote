import clsx from "clsx";

interface SurfaceShellProps {
  eyebrow: string;
  title: string;
  description: string;
  accentClassName?: string;
  children: React.ReactNode;
}

export function SurfaceShell({
  eyebrow,
  title,
  description,
  accentClassName,
  children
}: SurfaceShellProps) {
  return (
    <main className="min-h-screen px-4 py-6 md:px-8 md:py-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6">
        <header
          className={clsx(
            "panel-strong rounded-[28px] p-7 shadow-panel md:p-8",
            accentClassName
          )}
        >
          <p className="text-xs uppercase tracking-[0.3em] text-slate-300">{eyebrow}</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-5xl">{title}</h1>
          <p className="mt-4 max-w-3xl text-base leading-7 text-slate-300 md:text-lg">
            {description}
          </p>
        </header>
        {children}
      </div>
    </main>
  );
}
