import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Vi Telegram Bot" },
      {
        name: "description",
        content: "Service status page for the Vi Telegram trading bot.",
      },
      { property: "og:title", content: "Vi Telegram Bot" },
      {
        property: "og:description",
        content: "Service status page for the Vi Telegram trading bot.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <section className="w-full max-w-lg border-l-4 border-primary pl-6">
        <p className="text-sm font-semibold uppercase text-primary">Service status</p>
        <h1 className="mt-2 text-4xl font-bold">Vi Telegram Bot</h1>
        <p className="mt-4 text-muted-foreground">
          The bot service is installed. Open Telegram and send <strong className="text-foreground">/start</strong> to begin.
        </p>
      </section>
    </main>
  );
}
