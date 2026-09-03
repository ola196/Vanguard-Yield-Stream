/**
 * Soroban Contract Interaction Service
 *
 * Handles building, simulating, and submitting Soroban contract invocations
 * using @stellar/stellar-sdk. Connects to Stellar Testnet by default.
 */

import {
  Contract,
  Networks,
  SorobanRpc,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
  BASE_FEE,
  Keypair,
  Address,
  Account,
} from "@stellar/stellar-sdk";
import { signTx } from "./freighter";

// ─────────────────────────────────────────────────────────────────────────────
// NETWORK CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────

const RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ||
  "https://soroban-testnet.stellar.org";

const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || Networks.TESTNET;

const CONTRACT_ID = process.env.NEXT_PUBLIC_STREAM_CONTRACT_ID || "";

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface StreamData {
  id: number;
  sender: string;
  recipient: string;
  depositAmount: bigint;
  withdrawnAmount: bigint;
  startTime: number;
  stopTime: number;
  ratePerSecond: bigint;
  isCancelled: boolean;
}

export interface CreateStreamParams {
  sender: string;
  recipient: string;
  amount: bigint;
  startTime: number;
  stopTime: number;
}

export type InvokeResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function getRpcServer(): SorobanRpc.Server {
  return new SorobanRpc.Server(RPC_URL, { allowHttp: false });
}

/**
 * Build a base transaction for a contract call, simulate it to get
 * the correct fee/footprint, then return the prepared XDR for signing.
 */
async function buildAndPrepare(
  callerPublicKey: string,
  method: string,
  args: xdr.ScVal[]
): Promise<{ xdr: string; error?: string }> {
  const server = getRpcServer();

  const account = await server.getAccount(callerPublicKey);
  const contract = new Contract(CONTRACT_ID);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  try {
    const prepared = await server.prepareTransaction(tx);
    return { xdr: prepared.toXDR() };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { xdr: "", error: msg };
  }
}

/**
 * Submit a signed XDR transaction and poll until confirmed or failed.
 */
async function submitAndPoll(signedXdr: string): Promise<InvokeResult<string>> {
  const server = getRpcServer();

  let sendResponse;
  try {
    sendResponse = await server.sendTransaction(
      TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE)
    );
  } catch (e: unknown) {
    return { success: false, error: String(e) };
  }

  if (sendResponse.status === "ERROR") {
    return { success: false, error: "Transaction submission failed." };
  }

  const txHash = sendResponse.hash;

  // Poll for confirmation (up to 30 seconds)
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2_000));
    const result = await server.getTransaction(txHash);
    if (result.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      return { success: true, data: txHash };
    }
    if (result.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
      return { success: false, error: "Transaction failed on-chain." };
    }
  }

  return { success: false, error: "Transaction timed out waiting for confirmation." };
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT CALLS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new payment stream. Requires Freighter signature from the sender.
 */
export async function createStream(
  params: CreateStreamParams
): Promise<InvokeResult<string>> {
  const args = [
    new Address(params.sender).toScVal(),
    new Address(params.recipient).toScVal(),
    nativeToScVal(params.amount, { type: "i128" }),
    nativeToScVal(params.startTime, { type: "u64" }),
    nativeToScVal(params.stopTime, { type: "u64" }),
  ];

  const { xdr: txXdr, error } = await buildAndPrepare(
    params.sender,
    "create_stream",
    args
  );
  if (error) return { success: false, error };

  const signedXdr = await signTx(txXdr, NETWORK_PASSPHRASE);
  if (!signedXdr) return { success: false, error: "Transaction signing was rejected." };

  return submitAndPoll(signedXdr);
}

/**
 * Withdraw accrued tokens from a stream. Only callable by the recipient.
 */
export async function withdrawFromStream(
  callerPublicKey: string,
  streamId: number,
  amount: bigint
): Promise<InvokeResult<string>> {
  const args = [
    nativeToScVal(streamId, { type: "u64" }),
    nativeToScVal(amount, { type: "i128" }),
  ];

  const { xdr: txXdr, error } = await buildAndPrepare(
    callerPublicKey,
    "withdraw",
    args
  );
  if (error) return { success: false, error };

  const signedXdr = await signTx(txXdr, NETWORK_PASSPHRASE);
  if (!signedXdr) return { success: false, error: "Transaction signing was rejected." };

  return submitAndPoll(signedXdr);
}

/**
 * Cancel a stream and settle final balances. Only callable by the sender.
 */
export async function cancelStream(
  callerPublicKey: string,
  streamId: number
): Promise<InvokeResult<string>> {
  const args = [nativeToScVal(streamId, { type: "u64" })];

  const { xdr: txXdr, error } = await buildAndPrepare(
    callerPublicKey,
    "cancel_stream",
    args
  );
  if (error) return { success: false, error };

  const signedXdr = await signTx(txXdr, NETWORK_PASSPHRASE);
  if (!signedXdr) return { success: false, error: "Transaction signing was rejected." };

  return submitAndPoll(signedXdr);
}

/**
 * Read-only query: get the current withdrawable balance for a stream.
 * Uses simulate (no signature needed).
 */
export async function getBalanceOf(streamId: number): Promise<bigint | null> {
  try {
    const server = getRpcServer();
    const contract = new Contract(CONTRACT_ID);

    // Use a dummy keypair for read-only simulation
    const dummyKeypair = Keypair.random();
    const account = await server
      .getAccount(dummyKeypair.publicKey())
      .catch(() => new Account(dummyKeypair.publicKey(), "0"));

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        contract.call("balance_of", nativeToScVal(streamId, { type: "u64" }))
      )
      .setTimeout(30)
      .build();

    const result = await server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationSuccess(result) && result.result) {
      return scValToNative(result.result.retval) as bigint;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read-only query: fetch full stream metadata by ID.
 */
export async function getStream(streamId: number): Promise<StreamData | null> {
  try {
    const server = getRpcServer();
    const contract = new Contract(CONTRACT_ID);

    const dummyKeypair = Keypair.random();
    const account = await server
      .getAccount(dummyKeypair.publicKey())
      .catch(() => new Account(dummyKeypair.publicKey(), "0"));

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        contract.call("get_stream", nativeToScVal(streamId, { type: "u64" }))
      )
      .setTimeout(30)
      .build();

    const result = await server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationSuccess(result) && result.result) {
      const raw = scValToNative(result.result.retval) as Record<string, unknown>;
      return {
        id: Number(raw.id),
        sender: String(raw.sender),
        recipient: String(raw.recipient),
        depositAmount: BigInt(String(raw.deposit_amount)),
        withdrawnAmount: BigInt(String(raw.withdrawn_amount)),
        startTime: Number(raw.start_time),
        stopTime: Number(raw.stop_time),
        ratePerSecond: BigInt(String(raw.rate_per_second)),
        isCancelled: Boolean(raw.is_cancelled),
      };
    }
    return null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Convert stroops (1/10,000,000 XLM) to a human-readable XLM string */
export function stroopsToXlm(stroops: bigint): string {
  const xlm = Number(stroops) / 10_000_000;
  return xlm.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 7 });
}

/** Convert XLM to stroops */
export function xlmToStroops(xlm: number): bigint {
  return BigInt(Math.floor(xlm * 10_000_000));
}

/** Calculate stream progress percentage (0–100) */
export function streamProgress(stream: StreamData): number {
  const now = Math.floor(Date.now() / 1000);
  if (now <= stream.startTime) return 0;
  if (now >= stream.stopTime) return 100;
  const elapsed = now - stream.startTime;
  const total = stream.stopTime - stream.startTime;
  return Math.min(100, Math.floor((elapsed / total) * 100));
}

/** Format a Unix timestamp as a human-readable local date/time string */
export function formatTimestamp(ts: number): string {
  return new Date(ts * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Calculate seconds remaining in a stream */
export function secondsRemaining(stream: StreamData): number {
  const now = Math.floor(Date.now() / 1000);
  return Math.max(0, stream.stopTime - now);
}

/** Format seconds into a human-readable duration string */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return "Completed";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
