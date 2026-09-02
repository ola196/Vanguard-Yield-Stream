/**
 * Freighter Wallet Integration Service
 *
 * Wraps @stellar/freighter-api with clean async helpers and error handling.
 * All functions return null / false on failure rather than throwing, so the
 * UI can handle connectivity issues gracefully.
 */

import {
  isConnected,
  requestAccess,
  getAddress,
  signTransaction,
} from "@stellar/freighter-api";

export interface WalletState {
  connected: boolean;
  publicKey: string | null;
  error: string | null;
}

/**
 * Check whether the Freighter extension is installed in the browser.
 * Returns false both when extension is absent and when the page is SSR.
 */
export async function isFreighterInstalled(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  try {
    return await isConnected();
  } catch {
    return false;
  }
}

/**
 * Prompt the user to grant access and return their public key.
 *
 * @returns The G... Stellar public key string, or null on failure.
 */
export async function connectWallet(): Promise<string | null> {
  try {
    const installed = await isFreighterInstalled();
    if (!installed) {
      console.warn(
        "Freighter wallet not found. Please install the browser extension."
      );
      return null;
    }

    // requestAccess triggers the Freighter permission popup
    await requestAccess();

    // getAddress returns the currently selected account public key
    const publicKey = await getAddress();
    return publicKey || null;
  } catch (error) {
    console.error("Wallet connection failed:", error);
    return null;
  }
}

/**
 * Retrieve the currently selected public key without re-prompting.
 * Use this to re-hydrate wallet state on page load.
 *
 * @returns Public key string or null if not connected.
 */
export async function getConnectedAddress(): Promise<string | null> {
  try {
    const installed = await isFreighterInstalled();
    if (!installed) return null;
    const publicKey = await getAddress();
    return publicKey || null;
  } catch {
    return null;
  }
}

/**
 * Sign an XDR transaction envelope using Freighter.
 *
 * @param xdr              Base64-encoded transaction XDR
 * @param networkPassphrase Stellar network passphrase
 * @returns Signed XDR string, or null on user rejection / error
 */
export async function signTx(
  xdr: string,
  networkPassphrase: string
): Promise<string | null> {
  try {
    const signedXdr = await signTransaction(xdr, { networkPassphrase });
    return signedXdr || null;
  } catch (error) {
    console.error("Transaction signing failed:", error);
    return null;
  }
}

/**
 * Format a Stellar public key for display: G...XXXX (truncated middle)
 */
export function formatAddress(address: string, chars = 6): string {
  if (!address || address.length < chars * 2) return address;
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}
