export default function Page() {
  return (
    <main>
      <h1>open-pr-review</h1>
      <p>Webhook bridge for org-wide automated pull-request review.</p>
      <p>
        The only live surface is <code>POST /api/github-webhook</code>, which
        your organisation&apos;s webhook calls. This page exists so the
        deployment has something to serve.
      </p>
    </main>
  );
}
