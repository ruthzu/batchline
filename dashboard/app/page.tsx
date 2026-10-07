import Link from "next/link";

const navCards = [
  { href: "/orders", eyebrow: "01 / RESPOND", title: "Order Board", description: "See every customer order and its recall-response status at a glance.", accent: "var(--terracotta)" },
  { href: "/batches", eyebrow: "02 / PRODUCE", title: "Batch Board", description: "Keep production runs and their ingredient lots connected.", accent: "var(--amber)" },
  { href: "/trace", eyebrow: "03 / TRACE", title: "Trace a Lot", description: "Follow one ingredient from a lot number to affected customers.", accent: "var(--sage)" },
  { href: "/voice", eyebrow: "04 / SPEAK", title: "Try Voice", description: "Ask the simulated Alexa+ interface to do the digging for you.", accent: "var(--plum)" },
];

const flow = ["Lot", "Batch", "Order", "Customer"];

export default function Home() {
  return (
    <main className="min-h-screen overflow-hidden bg-[var(--cream)]">
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6 lg:px-10">
        <Link href="/" className="display-font text-2xl font-semibold tracking-tight text-[var(--ink)]">batchline<span className="text-[var(--terracotta)]">.</span></Link>
        <Link href="/voice" className="rounded-full border border-[var(--line)] bg-[var(--paper)] px-4 py-2 text-sm font-semibold text-[var(--ink)] transition hover:border-[var(--terracotta)] hover:text-[var(--terracotta)]">Try the voice demo <span aria-hidden>↗</span></Link>
      </nav>

      <section className="mx-auto grid max-w-6xl gap-12 px-6 pb-20 pt-10 lg:grid-cols-[1.05fr_.95fr] lg:items-center lg:px-10 lg:pt-16">
        <div>
          <p className="mb-5 text-xs font-bold uppercase tracking-[0.22em] text-[var(--terracotta)]">A calmer way to recall</p>
          <h1 className="display-font max-w-2xl text-6xl font-semibold leading-[.95] tracking-[-0.04em] text-[var(--ink)] sm:text-7xl">Know exactly where your ingredients went.</h1>
          <p className="mt-7 max-w-xl text-lg leading-8 text-[var(--muted)]">Voice-first recall tracing for small food producers.</p>
          <p className="mt-4 max-w-xl leading-7 text-[var(--muted)]">When a lot is called back, Batchline connects the ingredient lot to batches, orders, and customers in seconds — without digging through notebooks or half-remembered spreadsheets.</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/trace" className="rounded-full bg-[var(--terracotta)] px-5 py-3 text-sm font-bold text-white shadow-[0_8px_20px_rgba(185,87,63,.22)] transition hover:bg-[var(--terracotta-dark)]">Trace an ingredient <span aria-hidden>→</span></Link>
            <Link href="/batches" className="rounded-full border border-[var(--line)] bg-[var(--paper)] px-5 py-3 text-sm font-bold text-[var(--ink)] transition hover:border-[var(--terracotta)]">Explore the boards</Link>
          </div>
        </div>
        <div className="relative rounded-[2rem] border border-[var(--line)] bg-[var(--paper)] p-6 shadow-[var(--shadow)] sm:p-8">
          <div className="absolute -right-3 -top-3 rounded-full bg-[var(--amber)] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[.16em] text-white">One clear line</div>
          <p className="mb-6 text-xs font-bold uppercase tracking-[.18em] text-[var(--muted)]">The trace in plain sight</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:items-center sm:gap-2">
            {flow.map((item, index) => (
              <div key={item} className="contents">
                <div className="flex h-28 flex-col justify-between rounded-2xl border border-[var(--line)] bg-[var(--cream)] p-4 sm:h-32">
                  <span className="text-xs font-bold text-[var(--terracotta)]">0{index + 1}</span>
                  <span className="display-font text-xl font-semibold text-[var(--ink)]">{item}</span>
                </div>
                {index < flow.length - 1 && <span className="hidden text-center text-xl text-[var(--amber)] sm:block" aria-hidden>→</span>}
              </div>
            ))}
          </div>
          <p className="mt-6 border-t border-[var(--line)] pt-5 text-sm leading-6 text-[var(--muted)]">One ingredient question. One connected answer. A team that can act with confidence.</p>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-20 lg:px-10">
        <div className="mb-6 flex items-end justify-between"><div><p className="text-xs font-bold uppercase tracking-[.18em] text-[var(--terracotta)]">Your working bench</p><h2 className="display-font mt-2 text-4xl font-semibold text-[var(--ink)]">Everything in its place.</h2></div><span className="hidden text-sm text-[var(--muted)] sm:block">Choose a starting point →</span></div>
        <div className="grid gap-4 md:grid-cols-2">
          {navCards.map((card) => <Link key={card.href} href={card.href} className="group rounded-3xl border border-[var(--line)] bg-[var(--paper)] p-6 transition hover:-translate-y-1 hover:shadow-[var(--shadow)]"><span className="text-xs font-bold tracking-[.16em]" style={{ color: card.accent }}>{card.eyebrow}</span><div className="mt-12 flex items-end justify-between gap-4"><div><h3 className="display-font text-3xl font-semibold text-[var(--ink)]">{card.title}</h3><p className="mt-2 max-w-sm text-sm leading-6 text-[var(--muted)]">{card.description}</p></div><span className="text-2xl text-[var(--terracotta)] transition group-hover:translate-x-1" aria-hidden>↗</span></div></Link>)}
        </div>
      </section>

      <section className="border-y border-[var(--line)] bg-[var(--paper-deep)]"><div className="mx-auto max-w-6xl px-6 py-16 lg:px-10"><div className="grid gap-10 lg:grid-cols-[.7fr_1.3fr]"><div><p className="text-xs font-bold uppercase tracking-[.18em] text-[var(--terracotta)]">The four-step demo</p><h2 className="display-font mt-3 text-4xl font-semibold leading-tight text-[var(--ink)]">From a spoken note to a clear next step.</h2></div><ol className="grid gap-5 sm:grid-cols-2">{[["Record", "Tell Batchline what you made, by voice."], ["Recall", "A lot becomes a question that needs answering."], ["Trace", "Follow the lot through batches and orders."], ["Respond", "See who needs a hold, notice, or follow-up."]].map(([title, text], i) => <li key={title} className="flex gap-4"><span className="display-font text-3xl font-semibold text-[var(--amber)]">0{i + 1}</span><div><h3 className="font-bold text-[var(--ink)]">{title}</h3><p className="mt-1 text-sm leading-6 text-[var(--muted)]">{text}</p></div></li>)}</ol></div></div></section>

      <footer className="mx-auto flex max-w-6xl flex-col gap-3 px-6 py-8 text-sm text-[var(--muted)] sm:flex-row sm:items-center sm:justify-between lg:px-10"><span>Built for the Amazon Developer Hackathon — Alexa+ track</span><a href="https://github.com/ruthzu/batchline" target="_blank" rel="noreferrer" className="font-semibold text-[var(--terracotta)] hover:text-[var(--terracotta-dark)]">View the GitHub repo ↗</a></footer>
    </main>
  );
}
