"use client";

import React, { useEffect, useState } from "react";
import { Wallet, LogOut, CheckCircle, AlertCircle } from "lucide-react";
import { connectWallet, getConnectedAddress, formatAddress } from "@/lib/freighter";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";

interface WalletConnectProps {
  onConnect: (address: string) => void;
  onDisconnect: () => void;
  connectedAddress: string | null;
}

export default function WalletConnect({
  onConnect,
  onDisconnect,
  connectedAddress,
}: WalletConnectProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [freighterAvailable, setFreighterAvailable] = useState<boolean | null>(null);

  // On mount, check if Freighter is installed and attempt to restore session
  useEffect(() => {
    async function init() {
      const { isFreighterInstalled } = await import("@/lib/freighter");
      const installed = await isFreighterInstalled();
      setFreighterAvailable(installed);

      if (installed) {
        const addr = await getConnectedAddress();
        if (addr) onConnect(addr);
      }
    }
    init();
  }, [onConnect]);

  const handleConnect = async () => {
    setLoading(true);
    setError(null);
    try {
      const addr = await connectWallet();
      if (addr) {
        onConnect(addr);
      } else {
        setError(
          freighterAvailable
            ? "Connection was rejected. Please approve the request in Freighter."
            : "Freighter wallet extension not found. Please install it from freighter.app"
        );
      }
    } catch {
      setError("An unexpected error occurred connecting to Freighter.");
    } finally {
      setLoading(false);
    }
  };

  // Connected state
  if (connectedAddress) {
    return (
      <div className="flex items-center gap-3">
        <div className="hidden sm:flex items-center gap-2 px-3 py-2 bg-slate-800/80 border border-slate-700 rounded-xl">
          <CheckCircle className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" aria-hidden="true" />
          <span className="text-xs font-mono text-slate-300">
            {formatAddress(connectedAddress)}
          </span>
        </div>
        <button
          onClick={onDisconnect}
          className="flex items-center gap-1.5 px-3 py-2 text-xs text-slate-400 hover:text-red-400 bg-slate-800 border border-slate-700 hover:border-red-900 rounded-xl transition-colors"
          aria-label="Disconnect wallet"
        >
          <LogOut className="w-3.5 h-3.5" aria-hidden="true" />
          <span className="hidden sm:inline">Disconnect</span>
        </button>
      </div>
    );
  }

  // Disconnected state
  return (
    <div className="flex flex-col items-end gap-2">
      <Button
        onClick={handleConnect}
        loading={loading}
        size="md"
        aria-label="Connect Freighter wallet"
      >
        <Wallet className="w-4 h-4" aria-hidden="true" />
        {loading ? "Connecting..." : "Connect Freighter"}
      </Button>
      {error && (
        <p className="flex items-center gap-1.5 text-xs text-red-400 max-w-xs text-right" role="alert">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}
      {freighterAvailable === false && !error && (
        <a
          href="https://www.freighter.app"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-cyan-400 hover:text-cyan-300 underline"
        >
          Install Freighter →
        </a>
      )}
    </div>
  );
}
