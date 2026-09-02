"use client";

import React, { useEffect, useState, useCallback } from "react";
import { Search, RefreshCw, Inbox } from "lucide-react";
import { Card, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import StreamCard from "@/components/StreamCard";
import { getStream, StreamData } from "@/lib/soroban";

interface StreamListProps {
  connectedAddress: string;
  refreshTrigger: number;
}

export default function StreamList({
  connectedAddress,
  refreshTrigger,
}: StreamListProps) {
  const [streamIdInput, setStreamIdInput] = useState("");
  const [streams, setStreams] = useState<StreamData[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchStreamById = useCallback(async (id: number) => {
    const data = await getStream(id);
    if (!data) return null;
    // Only show streams involving the connected wallet
    if (
      data.sender === connectedAddress ||
      data.recipient === connectedAddress
    ) {
      return data;
    }
    return null;
  }, [connectedAddress]);

  const handleAddStream = async () => {
    const id = parseInt(streamIdInput.trim());
    if (isNaN(id) || id < 1) {
      setFetchError("Please enter a valid stream ID (positive integer).");
      return;
    }
    if (streams.some((s) => s.id === id)) {
      setFetchError(`Stream #${id} is already in your dashboard.`);
      return;
    }

    setLoading(true);
    setFetchError(null);

    try {
      const data = await getStream(id);
      if (!data) {
        setFetchError(`Stream #${id} not found on-chain.`);
      } else if (
        data.sender !== connectedAddress &&
        data.recipient !== connectedAddress
      ) {
        setFetchError(
          `Stream #${id} exists but doesn't involve your connected wallet.`
        );
      } else {
        setStreams((prev) => [data, ...prev]);
        setStreamIdInput("");
      }
    } finally {
      setLoading(false);
    }
  };

  // Refresh all tracked streams
  const refreshAll = useCallback(async () => {
    if (streams.length === 0) return;
    setRefreshing(true);
    try {
      const updated = await Promise.all(
        streams.map((s) => getStream(s.id))
      );
      setStreams(
        updated.filter((s): s is StreamData => s !== null)
      );
    } finally {
      setRefreshing(false);
    }
  }, [streams]);

  // Auto-refresh when parent signals a new stream was created
  useEffect(() => {
    if (refreshTrigger > 0) refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTrigger]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleAddStream();
  };

  return (
    <div className="space-y-4">
      {/* Lookup bar */}
      <Card>
        <CardBody className="py-4">
          <div className="flex items-center gap-3">
            <div className="relative flex-1">
              <Search
                className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500"
                aria-hidden="true"
              />
              <input
                type="number"
                min="1"
                value={streamIdInput}
                onChange={(e) => {
                  setStreamIdInput(e.target.value);
                  setFetchError(null);
                }}
                onKeyDown={handleKeyDown}
                placeholder="Enter Stream ID to track..."
                className="w-full pl-9 pr-4 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white font-mono placeholder-slate-600 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/20 transition-colors"
                aria-label="Stream ID to look up"
              />
            </div>
            <Button onClick={handleAddStream} loading={loading} size="md">
              Track Stream
            </Button>
            {streams.length > 0 && (
              <Button
                onClick={refreshAll}
                loading={refreshing}
                variant="secondary"
                size="md"
                aria-label="Refresh all streams"
              >
                <RefreshCw className="w-4 h-4" aria-hidden="true" />
              </Button>
            )}
          </div>
          {fetchError && (
            <p className="mt-2 text-xs text-red-400" role="alert">
              {fetchError}
            </p>
          )}
        </CardBody>
      </Card>

      {/* Stream cards */}
      {streams.length === 0 ? (
        <Card>
          <CardBody className="py-12 flex flex-col items-center gap-3 text-center">
            <div className="p-4 bg-slate-800 rounded-full">
              <Inbox className="w-8 h-8 text-slate-500" aria-hidden="true" />
            </div>
            <p className="text-slate-400 font-medium">No streams tracked yet</p>
            <p className="text-sm text-slate-500 max-w-xs">
              Create a new stream using the form, or enter a stream ID above to
              start tracking it.
            </p>
          </CardBody>
        </Card>
      ) : (
        <div className="space-y-4">
          {streams.map((stream) => (
            <StreamCard
              key={stream.id}
              stream={stream}
              connectedAddress={connectedAddress}
              onUpdate={refreshAll}
            />
          ))}
        </div>
      )}
    </div>
  );
}
