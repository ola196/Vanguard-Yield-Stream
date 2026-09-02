"use client";

import React, { useState } from "react";
import { Plus, Info } from "lucide-react";
import { Card, CardHeader, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { createStream, xlmToStroops } from "@/lib/soroban";

interface CreateStreamFormProps {
  senderAddress: string;
  onStreamCreated: (streamId: string) => void;
}

interface FormState {
  recipient: string;
  amount: string;
  durationDays: string;
  durationHours: string;
  durationMinutes: string;
  delayMinutes: string;
}

const initialForm: FormState = {
  recipient: "",
  amount: "",
  durationDays: "0",
  durationHours: "1",
  durationMinutes: "0",
  delayMinutes: "5",
};

export default function CreateStreamForm({
  senderAddress,
  onStreamCreated,
}: CreateStreamFormProps) {
  const [form, setForm] = useState<FormState>(initialForm);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const totalDurationSeconds =
    parseInt(form.durationDays || "0") * 86_400 +
    parseInt(form.durationHours || "0") * 3_600 +
    parseInt(form.durationMinutes || "0") * 60;

  const ratePerSecond =
    totalDurationSeconds > 0 && parseFloat(form.amount) > 0
      ? (parseFloat(form.amount) * 10_000_000) / totalDurationSeconds
      : 0;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
    setError(null);
    setTxHash(null);
  };

  const validate = (): string | null => {
    if (!form.recipient.startsWith("G") || form.recipient.length !== 56) {
      return "Recipient must be a valid Stellar public key (starts with G, 56 characters).";
    }
    if (form.recipient === senderAddress) {
      return "Recipient cannot be the same as the sender.";
    }
    const amt = parseFloat(form.amount);
    if (isNaN(amt) || amt <= 0) {
      return "Amount must be a positive number.";
    }
    if (totalDurationSeconds < 60) {
      return "Stream duration must be at least 60 seconds.";
    }
    if (ratePerSecond < 1) {
      return "Amount is too small for the selected duration. Minimum rate is 1 stroop/second.";
    }
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const now = Math.floor(Date.now() / 1000);
      const delaySeconds = parseInt(form.delayMinutes || "5") * 60;
      const startTime = now + delaySeconds;
      const stopTime = startTime + totalDurationSeconds;
      const stroops = xlmToStroops(parseFloat(form.amount));

      const result = await createStream({
        sender: senderAddress,
        recipient: form.recipient,
        amount: stroops,
        startTime,
        stopTime,
      });

      if (result.success) {
        setTxHash(result.data);
        onStreamCreated(result.data);
        setForm(initialForm);
      } else {
        setError(result.error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "An unexpected error occurred.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card glow>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="p-2 bg-cyan-950 border border-cyan-800 rounded-lg">
            <Plus className="w-4 h-4 text-cyan-400" aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-slate-100">Create Yield Stream</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Lock tokens and stream them second-by-second to a recipient
            </p>
          </div>
        </div>
      </CardHeader>

      <CardBody>
        <form onSubmit={handleSubmit} className="space-y-5" noValidate>
          {/* Recipient */}
          <div>
            <label
              htmlFor="recipient"
              className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2"
            >
              Recipient Stellar Address
            </label>
            <input
              id="recipient"
              name="recipient"
              type="text"
              required
              value={form.recipient}
              onChange={handleChange}
              placeholder="G..."
              autoComplete="off"
              spellCheck={false}
              className="w-full p-3 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white font-mono placeholder-slate-600 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/20 transition-colors"
              aria-describedby="recipient-hint"
            />
            <p id="recipient-hint" className="mt-1.5 text-xs text-slate-500">
              The Stellar public key of the stream beneficiary
            </p>
          </div>

          {/* Amount */}
          <div>
            <label
              htmlFor="amount"
              className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2"
            >
              Total Deposit (XLM)
            </label>
            <div className="relative">
              <input
                id="amount"
                name="amount"
                type="number"
                required
                min="0"
                step="0.0000001"
                value={form.amount}
                onChange={handleChange}
                placeholder="100.00"
                className="w-full p-3 pr-16 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white font-mono placeholder-slate-600 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/20 transition-colors"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-500 font-mono">
                XLM
              </span>
            </div>
          </div>

          {/* Duration */}
          <div>
            <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
              Stream Duration
            </label>
            <div className="grid grid-cols-3 gap-3">
              {(
                [
                  { label: "Days", name: "durationDays" },
                  { label: "Hours", name: "durationHours" },
                  { label: "Minutes", name: "durationMinutes" },
                ] as const
              ).map(({ label, name }) => (
                <div key={name}>
                  <input
                    id={name}
                    name={name}
                    type="number"
                    min="0"
                    value={form[name]}
                    onChange={handleChange}
                    className="w-full p-3 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white font-mono text-center focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/20 transition-colors"
                    aria-label={label}
                  />
                  <p className="mt-1 text-xs text-slate-500 text-center">{label}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Start Delay */}
          <div>
            <label
              htmlFor="delayMinutes"
              className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2"
            >
              Start Delay (Minutes)
            </label>
            <input
              id="delayMinutes"
              name="delayMinutes"
              type="number"
              min="1"
              value={form.delayMinutes}
              onChange={handleChange}
              className="w-full p-3 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white font-mono focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/20 transition-colors"
              aria-describedby="delay-hint"
            />
            <p id="delay-hint" className="mt-1.5 text-xs text-slate-500">
              How many minutes from now the stream starts
            </p>
          </div>

          {/* Rate Preview */}
          {ratePerSecond > 0 && (
            <div className="flex items-start gap-2 p-3 bg-cyan-950/40 border border-cyan-900/60 rounded-xl">
              <Info className="w-4 h-4 text-cyan-400 flex-shrink-0 mt-0.5" aria-hidden="true" />
              <div className="text-xs text-cyan-300 space-y-1">
                <p>
                  <span className="font-semibold">Rate:</span>{" "}
                  {ratePerSecond.toLocaleString("en-US", { maximumFractionDigits: 2 })} stroops/sec
                  &nbsp;≈&nbsp;
                  {(ratePerSecond / 10_000_000).toFixed(7)} XLM/sec
                </p>
                <p>
                  <span className="font-semibold">Duration:</span>{" "}
                  {Math.floor(totalDurationSeconds / 3600)}h{" "}
                  {Math.floor((totalDurationSeconds % 3600) / 60)}m{" "}
                  {totalDurationSeconds % 60}s
                </p>
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div
              className="p-3 bg-red-950/60 border border-red-900 rounded-xl text-xs text-red-400"
              role="alert"
            >
              {error}
            </div>
          )}

          {/* Success */}
          {txHash && (
            <div className="p-3 bg-emerald-950/60 border border-emerald-900 rounded-xl text-xs text-emerald-400">
              <p className="font-semibold mb-1">Stream created on Testnet!</p>
              <a
                href={`https://stellar.expert/explorer/testnet/tx/${txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono underline hover:text-emerald-300 break-all"
              >
                {txHash}
              </a>
            </div>
          )}

          <Button
            type="submit"
            loading={loading}
            size="lg"
            className="w-full"
            disabled={totalDurationSeconds < 60 || !form.recipient || !form.amount}
          >
            {loading ? "Submitting to Soroban..." : "Create Yield Stream"}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
