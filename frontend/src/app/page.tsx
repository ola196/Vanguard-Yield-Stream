import StreamDashboard from "@/components/StreamDashboard";

/**
 * Root page — renders the full Vanguard Yield Stream dashboard.
 * All interactivity is handled in the client-side StreamDashboard component.
 */
export default function Home() {
  return (
    <main>
      <StreamDashboard />
    </main>
  );
}
