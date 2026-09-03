"use client";

import React, { useState, useCallback } from "react";
import { Zap, Github, BookOpen } from "lucide-react";
import WalletConnect from "@/components/WalletConnect";
import CreateStreamForm from "@/components/CreateStreamForm";
import StreamList from "@/components/StreamList";
import { Badge } from "@/components/ui/Badge";

export default function StreamDashboard() {
  const [connectedAddress, setConnectedAddress] = useState<string | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const handleConnect = useCallback((address: string) => {
    setConnectedAddress(address);
  }, []);

  const handleDisconnect = useCallback(() => {
    setConnectedAddress(null);
  }, []);

  const handleStreamCreated = useCallback(() => {
    // Bump trigger to tell StreamList to refresh
    setRefreshTrigger((n) => n + 1);
  }, []);

  return (
    <div className="min-h-screen bg-grid-pattern bg-grid relative">
      {/* Ambient background glow */}
      <div
        className="fixed top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-cyan-500/5 rounded-full blur-3xl pointer-events-none"
        aria-hidden="true"
      />

      {/* ── Header ── */}
      <header className="sticky top-0 z-10 backdrop-blur-md bg-slate-950/80 border-b border-slate-800/60">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between gap-4">
          {/* Brand */}
          <div className="flex items-center gap-3">
            <div className="p-2 bg-cyan-950 border border-cyan-800 rounded-xl">
              <Zap className="w-5 h-5 text-cyan-400" aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-base font-bold text-slate-100 leading-tight">
                Vanguard Yield Stream
              </h1>
              <p className="text-xs text-slate-500 leading-tight hidden sm:block">
                Continuous RWA Yield &amp; Payroll Protocol
              </p>
            </div>
          </div>

          {/* Right side */}
          <div className="flex items-center gap-3">
            <Badge variant="testnet" className="hidden sm:inline-flex">
              Soroban Testnet
            </Badge>
            <WalletConnect
              connectedAddress={connectedAddress}
              onConnect={handleConnect}
              onDisconnect={handleDisconnect}
            />
          </div>
        </div>
      </header>

      {/* ── Main Content ── */}
      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        {!connectedAddress ? (
          /* ── Landing / not connected ── */
          <div className="max-w-2xl mx-auto text-center py-20 space-y-8">
            <div className="space-y-4">
              <div className="inline-flex p-4 bg-cyan-950 border border-cyan-800 rounded-2xl mb-4">
                <Zap className="w-10 h-10 text-cyan-400" aria-hidden="true" />
              </div>
              <h2 className="text-4xl font-bold text-slate-100 tracking-tight">
                Stream Value,{" "}
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-blue-500">
                  Second by Second
                </span>
              </h2>
              <p className="text-lg text-slate-400 leading-relaxed max-w-lg mx-auto">
                Vanguard Yield Stream brings trustless, continuous token
                distribution to the Stellar ecosystem — enabling RWA yield
                disbursements, streaming payroll, and milestone vesting with
                zero friction.
              </p>
            </div>

            {/* Feature grid */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-left">
              {[
                {
                  title: "Real-Time Accrual",
                  description:
                    "Tokens accrue every second with integer-precise math — no rounding errors, no floating points.",
                },
                {
                  title: "Non-Custodial",
                  description:
                    "Funds are locked in Soroban escrow. Only the designated recipient can withdraw. Only the sender can cancel.",
                },
                {
                  title: "Circuit Breaker",
                  description:
                    "Admin-controlled emergency pause halts all operations instantly for incident response.",
                },
              ].map((f) => (
                <div
                  key={f.title}
                  className="p-4 bg-slate-900/60 border border-slate-800 rounded-xl text-left"
                >
                  <h3 className="text-sm font-semibold text-cyan-400 mb-1.5">
                    {f.title}
                  </h3>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    {f.description}
                  </p>
                </div>
              ))}
            </div>

            <p className="text-sm text-slate-500">
              Connect your{" "}
              <a
                href="https://www.freighter.app"
                target="_blank"
                rel="noopener noreferrer"
                className="text-cyan-400 hover:text-cyan-300 underline"
              >
                Freighter wallet
              </a>{" "}
              to create and manage payment streams.
            </p>
          </div>
        ) : (
          /* ── Connected dashboard ── */
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
            {/* Left column: create form */}
            <div className="space-y-6">
              <CreateStreamForm
                senderAddress={connectedAddress}
                onStreamCreated={handleStreamCreated}
              />

              {/* Protocol stats card */}
              <div className="p-4 bg-slate-900/60 border border-slate-800 rounded-2xl space-y-3">
                <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  Protocol Info
                </h3>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { label: "Network", value: "Stellar Testnet" },
                    { label: "Contract", value: process.env.NEXT_PUBLIC_STREAM_CONTRACT_ID ? "Deployed" : "Not deployed" },
                    { label: "SDK", value: "Soroban 22.0.0" },
                    { label: "Token standard", value: "Stellar SAC" },
                  ].map((item) => (
                    <div key={item.label}>
                      <p className="text-xs text-slate-500">{item.label}</p>
                      <p className="text-xs font-mono text-slate-300 mt-0.5">
                        {item.value}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Right column: stream list */}
            <div>
              <StreamList
                connectedAddress={connectedAddress}
                refreshTrigger={refreshTrigger}
              />
            </div>
          </div>
        )}
      </main>

      {/* ── Footer ── */}
      <footer className="border-t border-slate-800/60 mt-16">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-500">
          <p>
            Built on{" "}
            <a
              href="https://stellar.org"
              target="_blank"
              rel="noopener noreferrer"
              className="text-cyan-500 hover:text-cyan-400"
            >
              Stellar
            </a>{" "}
            &amp; Soroban — Vanguard Yield Stream
          </p>
          <div className="flex items-center gap-4">
            <a
              href="https://developers.stellar.org/docs/smart-contracts"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 hover:text-slate-300 transition-colors"
            >
              <BookOpen className="w-3.5 h-3.5" aria-hidden="true" />
              Soroban Docs
            </a>
            <a
              href="https://github.com"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 hover:text-slate-300 transition-colors"
            >
              <Github className="w-3.5 h-3.5" aria-hidden="true" />
              Source Code
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
