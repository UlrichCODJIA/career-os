export const shellHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark light" />
    <title>Career OS</title>
    <style>
      :root { font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #e8eef2; background: #071113; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; background: radial-gradient(circle at 75% 15%, #17383a 0, #071113 42%); }
      main { width: min(1120px, calc(100% - 32px)); margin: 0 auto; padding: 48px 0; }
      header { display: flex; align-items: center; justify-content: space-between; gap: 24px; }
      .brand { letter-spacing: .08em; text-transform: uppercase; font-weight: 800; }
      .status { color: #74e4b7; border: 1px solid #2a6c59; border-radius: 999px; padding: 8px 12px; }
      .hero { margin-top: 96px; max-width: 760px; }
      h1 { font-size: clamp(48px, 8vw, 92px); line-height: .95; margin: 0; letter-spacing: -.055em; }
      p { color: #a8bdc1; font-size: 20px; line-height: 1.6; }
      .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin-top: 56px; }
      article { min-height: 190px; padding: 24px; border: 1px solid #244247; border-radius: 20px; background: rgba(11, 28, 31, .72); }
      article span { color: #74e4b7; font: 700 12px ui-monospace, monospace; }
      h2 { margin: 36px 0 8px; font-size: 24px; }
      article p { margin: 0; font-size: 15px; }
      @media (max-width: 760px) { .grid { grid-template-columns: 1fr; } .hero { margin-top: 64px; } }
    </style>
  </head>
  <body>
    <main>
      <header><div class="brand">Career OS</div><div class="status">Local foundation online</div></header>
      <section class="hero">
        <h1>Your search.<br />Your evidence.<br />Your models.</h1>
        <p>An open, provider-neutral operating system for the complete path from trustworthy job discovery to applications, interviews, offers, and outcomes.</p>
      </section>
      <section class="grid" aria-label="Foundation boundaries">
        <article><span>01 / DISCOVERY</span><h2>Source-grounded</h2><p>Employer and approved ATS evidence stays attached to every canonical opportunity.</p></article>
        <article><span>02 / PRIVATE</span><h2>User-owned</h2><p>Candidate documents and decisions remain separate from the shared market index.</p></article>
        <article><span>03 / AI</span><h2>Provider-neutral</h2><p>Model and agent runtimes plug into explicit, approval-aware capability boundaries.</p></article>
      </section>
    </main>
  </body>
</html>`;
