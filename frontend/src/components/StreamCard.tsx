"use client";

import React, { useEffect, useState, useCallback } from "react";
import { Clock, TrendingUp, XCircle, Download, ExternalLink } from "lucide-react";
import { Card, CardBody } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import {
  StreamData,
  stroopsToXlm,
  streamProgress,
  formatTimestamp,
  secondsRemaining,
  formatDuration,
  withdrawFromStream,
  cancelStream,
  getBalanceOf,
} from "@/lib/soroban";
import { formatAddress } from "@/lib/freighter";

interface StreamCardProps {
  stream: StreamData;
  connectedAddress: string;
  onUpdate: () => void;
}

export default function StreamCard({
  stream,
  connectedAddress,
  onUpdate,
}: StreamCardProps) {
  const [balance, setBalance] = useState<bigint | null>(null);
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawLoading, setWithdrawLoading] = useState(false);
  const [cancelLoading, setCancelLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [progress, setProgress] = useState(streamProgress(stream));

  const isSender = connectedAddress === stream.sender;
  const isRecipient = connectedAddress === stream.recipient;
  const isActive = !stream.isCancelled && streamProgress(stream) < 100;
  const isCompleted = !stream.isCancelled && streamProgress(stream) >= 100;

  // Fetch live balance
  const refreshBalance = useCallback(async () => {
    const bal = await getBalanceOf(stream.id);
    setBalance(bal);
  }, [stream.id]);

  // Poll balance and progress every 5 seconds for active streams
  useEffect(() => {
    refreshBalance();
    if (!isActive) return;

    const interval = setInterval(() => {
      refreshBalance();
      setProgress(streamProgress(stream));
    }, 5_000);

    return () => clearInterval(interval);
  }, [isActive, refreshBalance, stream]);

  const handleWithdraw = async () => {
    setError(null);
    setTxHash(null);
    const amt = parseFloat(withdrawAmount);
    if (isNaN(amt) || amt <= 0) {
      setError("Enter a valid withdrawal amount.");
      return;
    }
    const stroops = BigInt(Math.floor(amt * 10_000_000));
    if (balance !== null && stroops > balance) {
      setError("Amount exceeds available balance.");
      return;
    }

    setWithdrawLoading(true);
    try {
      const result = await withdrawFromStream(connectedAddress, stream.id, stroops);
      if (result.success) {
        setTxHash(result.data);
        setWithdrawAmount("");
        onUpdate();
        refreshBalance();
      } else {
        setError(result.error);
      }
    } finally {
      setWithdrawLoading(false);
    }
  };

  const handleCancel = async () => {
    if (!confirm("Cancel this stream? Accrued tokens will be sent to the recipient and the remainder refunded to you.")) {
      return;
    }
    setError(null);
    setTxHash(null);
    setCancelLoading(true);
    try {
      const result = await cancelStream(connectedAddress, stream.id);
      if (result.success) {
        setTxHash(result.data);
        onUpdate();
      } else {
        setError(result.error);
      }
    } finally {
      setCancelLoading(false);
    }
  };

  const statusBadge = stream.isCancelled
    ? "cancelled"
    : isCompleted
    ? "completed"
    : isActive
    ? "active"
    : "pending";

  const statusLabel = stream.isCancelled
    ? "Cancelled"
    : isCompleted
    ? "Completed"
    : "Streaming";

  return (
    <Card className="overflow-hidden">
      {/* Progress bar */}
      <div className="h-1 w-full bg-slate-800">
        <div
          className={`h-full transition-all duration-1000 ${
            stream.isCancelled
              ? "bg-red-700"
              : isCompleted
              ? "bg-emerald-600"
              : "stream-flow"
          }`}
          style={{ width: `${progress}%` }}
          role="progressbar"
          aria-valuenow={progress}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Stream progress: ${progress}%`}
        />
      </div>

      <CardBody className="space-y-4">
        {/* Header row */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-slate-500">#{stream.id}</span>
              <Badge variant={statusBadge}>{statusLabel}</Badge>
            </div>
            <p className="mt-1.5 text-xs text-slate-500">
              {isSender && "You are sending"}
              {isRecipient && "You are receiving"}
              {!isSender && !isRecipient && "Observed stream"}
            </p>
          </div>
          <div className="text-right">
            <p className="text-lg font-bold text-slate-100 font-mono">
              {stroopsToXlm(stream.depositAmount)}
            </p>
            <p className="text-xs text-slate-500">XLM total</p>
          </div>
        </div>

        {/* Addresses */}
        <div className="grid grid-cols-2 gap-3">
          <div className="p-2.5 bg-slate-950 border border-slate-800 rounded-lg">
            <p className="text-xs text-slate-500 mb-1">Sender</p>
            <p className="text-xs font-mono text-slate-300 truncate">
              {formatAddress(stream.sender, 8)}
              {isSender && (
                <span className="ml-1 text-cyan-400">(you)</span>
              )}
            </p>
          </div>
          <div className="p-2.5 bg-slate-950 border border-slate-800 rounded-lg">
            <p className="text-xs text-slate-500 mb-1">Recipient</p>
            <p className="text-xs font-mono text-slate-300 truncate">
              {formatAddress(stream.recipient, 8)}
              {isRecipient && (
                <span className="ml-1 text-emerald-400">(you)</span>
              )}
            </p>
          </div>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-3 gap-3">
          <div className="p-2.5 bg-slate-950 border border-slate-800 rounded-lg text-center">
            <p className="text-xs text-slate-500 mb-1 flex items-center justify-center gap-1">
              <TrendingUp className="w-3 h-3" aria-hidden="true" /> Rate
            </p>
            <p className="text-xs font-mono text-cyan-400">
              {stroopsToXlm(stream.ratePerSecond)}/s
            </p>
          </div>
          <div className="p-2.5 bg-slate-950 border border-slate-800 rounded-lg text-center">
            <p className="text-xs text-slate-500 mb-1">Withdrawn</p>
            <p className="text-xs font-mono text-slate-300">
              {stroopsToXlm(stream.withdrawnAmount)} XLM
            </p>
          </div>
          <div className="p-2.5 bg-slate-950 border border-slate-800 rounded-lg text-center">
            <p className="text-xs text-slate-500 mb-1 flex items-center justify-center gap-1">
              <Clock className="w-3 h-3" aria-hidden="true" /> Remaining
            </p>
            <p className="text-xs font-mono text-slate-300">
              {formatDuration(secondsRemaining(stream))}
            </p>
          </div>
        </div>

        {/* Timeline */}
        <div className="flex items-center justify-between text-xs text-slate-500 font-mono">
          <span>{formatTimestamp(stream.startTime)}</span>
          <span className="text-slate-600">→</span>
          <span>{formatTimestamp(stream.stopTime)}</span>
        </div>

        {/* Live balance */}
        {balance !== null && (isRecipient || isSender) && (
          <div className="p-3 bg-cyan-950/30 border border-cyan-900/50 rounded-xl">
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-400">Available to withdraw</span>
              <span className="text-sm font-bold font-mono text-cyan-400">
                {stroopsToXlm(balance)} XLM
              </span>
            </div>
          </div>
        )}

        {/* Recipient withdraw panel */}
        {isRecipient && !stream.isCancelled && balance !== null && balance > 0n && (
          <div className="space-y-2">
            <div className="flex gap-2">
              <input
                type="number"
                value={withdrawAmount}
                onChange={(e) => {
                  setWithdrawAmount(e.target.value);
                  setError(null);
                }}
                placeholder={`Max: ${stroopsToXlm(balance)}`}
                className="flex-1 p-2.5 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white font-mono placeholder-slate-600 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/20"
                aria-label="Withdrawal amount in XLM"
              />
              <Button
                onClick={handleWithdraw}
                loading={withdrawLoading}
                size="sm"
                aria-label="Withdraw accrued tokens"
              >
                <Download className="w-3.5 h-3.5" aria-hidden="true" />
                Withdraw
              </Button>
            </div>
            <button
              onClick={() =>
                setWithdrawAmount((Number(balance) / 10_000_000).toString())
              }
              className="text-xs text-cyan-500 hover:text-cyan-400 underline"
            >
              Withdraw max available
            </button>
          </div>
        )}

        {/* Sender cancel button */}
        {isSender && !stream.isCancelled && isActive && (
          <Button
            onClick={handleCancel}
            loading={cancelLoading}
            variant="danger"
            size="sm"
            className="w-full"
            aria-label="Cancel stream"
          >
            <XCircle className="w-3.5 h-3.5" aria-hidden="true" />
            Cancel Stream
          </Button>
        )}

        {/* Error / success */}
        {error && (
          <p className="text-xs text-red-400 p-2 bg-red-950/40 border border-red-900 rounded-lg" role="alert">
            {error}
          </p>
        )}
        {txHash && (
          <a
            href={`https://stellar.expert/explorer/testnet/tx/${txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs text-emerald-400 hover:text-emerald-300 underline"
          >
            <ExternalLink className="w-3 h-3" aria-hidden="true" />
            View transaction on Stellar.expert
          </a>
        )}
      </CardBody>
    </Card>
  );
}
