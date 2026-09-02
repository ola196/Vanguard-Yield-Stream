#!/usr/bin/env bash
# =============================================================================
#  Vanguard Yield Stream — Stellar Testnet Deployment Pipeline
# =============================================================================
#
#  Usage:
#    chmod +x scripts/deploy.sh
#    ./scripts/deploy.sh [--identity <key-name>] [--token <SAC-address>]
#
#  Prerequisites:
#    - Rust + cargo with target wasm32v1-none installed
#    - stellar-cli installed  (cargo install stellar-cli)
#    - A funded Testnet identity configured in stellar-cli
#      e.g.: stellar keys generate admin --network testnet
#            stellar keys fund admin --network testnet
#
#  What this script does:
#    1. Validates environment (tools present, identity exists)
#    2. Runs the full Cargo test suite — aborts on any failure
#    3. Compiles the contract to an optimised WASM binary
#    4. Uploads and deploys the WASM to Stellar Testnet
#    5. Invokes initialize() with admin address and token address
#    6. Writes NEXT_PUBLIC_STREAM_CONTRACT_ID to frontend/.env.local
# =============================================================================

set -euo pipefail

# ── Colour helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
RESET='\033[0m'

info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*" >&2; }
step()    { echo -e "\n${BOLD}${CYAN}══ $* ${RESET}"; }

# ── Default configuration (override via flags or environment) ─────────────────
IDENTITY="${STELLAR_IDENTITY:-admin}"
NETWORK="${STELLAR_NETWORK:-testnet}"
# SAC token address — if left empty the script deploys a test native XLM wrapper
TOKEN_ADDRESS="${STELLAR_TOKEN_ADDRESS:-}"
WASM_PATH="target/wasm32v1-none/release/vanguard_stream.wasm"

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --identity) IDENTITY="$2"; shift 2 ;;
    --token)    TOKEN_ADDRESS="$2"; shift 2 ;;
    --network)  NETWORK="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: $0 [--identity <key>] [--token <SAC-address>] [--network <testnet|futurenet>]"
      exit 0
      ;;
    *)
      error "Unknown argument: $1"
      exit 1
      ;;
  esac
done

# ── Banner ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${CYAN}"
echo "  ██╗   ██╗ █████╗ ███╗   ██╗ ██████╗ ██╗   ██╗ █████╗ ██████╗ ██████╗ "
echo "  ██║   ██║██╔══██╗████╗  ██║██╔════╝ ██║   ██║██╔══██╗██╔══██╗██╔══██╗"
echo "  ██║   ██║███████║██╔██╗ ██║██║  ███╗██║   ██║███████║██████╔╝██║  ██║"
echo "  ╚██╗ ██╔╝██╔══██║██║╚██╗██║██║   ██║██║   ██║██╔══██║██╔══██╗██║  ██║"
echo "   ╚████╔╝ ██║  ██║██║ ╚████║╚██████╔╝╚██████╔╝██║  ██║██║  ██║██████╔╝"
echo "    ╚═══╝  ╚═╝  ╚═╝╚═╝  ╚═══╝ ╚═════╝  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝ "
echo -e "${RESET}"
echo -e "  ${BOLD}Yield Stream — Soroban Deployment Pipeline${RESET}"
echo -e "  Network : ${CYAN}${NETWORK}${RESET}"
echo -e "  Identity: ${CYAN}${IDENTITY}${RESET}"
echo ""

# ── Step 0: Validate prerequisites ───────────────────────────────────────────
step "Step 0/5 — Validating prerequisites"

if ! command -v stellar &>/dev/null; then
  error "stellar-cli not found. Install it with:"
  error "  cargo install stellar-cli"
  exit 1
fi
success "stellar-cli found: $(stellar --version 2>&1 | head -1)"

if ! command -v cargo &>/dev/null; then
  error "cargo not found. Install Rust from https://rustup.rs"
  exit 1
fi
success "cargo found: $(cargo --version)"

# Verify the signing identity exists
if ! stellar keys address "${IDENTITY}" --network "${NETWORK}" &>/dev/null; then
  error "Stellar identity '${IDENTITY}' not found."
  error "Create and fund one with:"
  error "  stellar keys generate ${IDENTITY} --network ${NETWORK}"
  error "  stellar keys fund ${IDENTITY} --network ${NETWORK}"
  exit 1
fi

ADMIN_ADDRESS=$(stellar keys address "${IDENTITY}" --network "${NETWORK}")
success "Admin address: ${ADMIN_ADDRESS}"

# ── Step 1: Run tests ─────────────────────────────────────────────────────────
step "Step 1/5 — Running contract test suite"

info "Executing: cargo test"
if cargo test 2>&1; then
  success "All tests passed."
else
  error "Test suite failed. Aborting deployment."
  exit 1
fi

# ── Step 2: Build WASM ────────────────────────────────────────────────────────
step "Step 2/5 — Compiling WASM binary"

info "Executing: stellar contract build"
stellar contract build

if [[ ! -f "${WASM_PATH}" ]]; then
  error "WASM binary not found at expected path: ${WASM_PATH}"
  error "Check that the contract crate name matches 'vanguard_stream' in Cargo.toml"
  exit 1
fi

WASM_SIZE=$(du -sh "${WASM_PATH}" | cut -f1)
success "WASM binary compiled: ${WASM_PATH} (${WASM_SIZE})"

# ── Step 3: Deploy contract ───────────────────────────────────────────────────
step "Step 3/5 — Deploying to Stellar ${NETWORK}"

info "Uploading and deploying contract WASM..."
CONTRACT_ID=$(stellar contract deploy \
  --wasm "${WASM_PATH}" \
  --source "${IDENTITY}" \
  --network "${NETWORK}" \
  2>&1 | tail -1)

if [[ -z "${CONTRACT_ID}" || ${#CONTRACT_ID} -ne 56 ]]; then
  error "Deployment failed or returned unexpected output: ${CONTRACT_ID}"
  exit 1
fi

success "Contract deployed! ID: ${CONTRACT_ID}"

# ── Step 4: Resolve token address ─────────────────────────────────────────────
step "Step 4/5 — Resolving token address"

if [[ -z "${TOKEN_ADDRESS}" ]]; then
  warn "No --token provided. Wrapping native XLM as the stream token..."
  TOKEN_ADDRESS=$(stellar contract asset deploy \
    --asset native \
    --source "${IDENTITY}" \
    --network "${NETWORK}" \
    2>&1 | tail -1)
  success "Native XLM SAC deployed: ${TOKEN_ADDRESS}"
else
  success "Using provided token address: ${TOKEN_ADDRESS}"
fi

# ── Step 5: Initialize contract ───────────────────────────────────────────────
step "Step 5/5 — Initializing contract state"

info "Calling initialize(admin=${ADMIN_ADDRESS}, token=${TOKEN_ADDRESS})..."
stellar contract invoke \
  --id "${CONTRACT_ID}" \
  --source "${IDENTITY}" \
  --network "${NETWORK}" \
  -- \
  initialize \
  --admin "${ADMIN_ADDRESS}" \
  --token "${TOKEN_ADDRESS}"

success "Contract initialized."

# ── Write environment config ──────────────────────────────────────────────────
ENV_FILE="frontend/.env.local"
info "Writing contract ID to ${ENV_FILE}..."

mkdir -p frontend

cat > "${ENV_FILE}" <<EOF
# Auto-generated by scripts/deploy.sh — $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# ─────────────────────────────────────────────────────────────────────────────

# Soroban contract ID (deployed to ${NETWORK})
NEXT_PUBLIC_STREAM_CONTRACT_ID=${CONTRACT_ID}

# Stellar Network passphrase
NEXT_PUBLIC_NETWORK_PASSPHRASE=Test SDF Network ; September 2015

# Soroban RPC endpoint
NEXT_PUBLIC_SOROBAN_RPC_URL=https://soroban-testnet.stellar.org

# Stellar Horizon URL
NEXT_PUBLIC_HORIZON_URL=https://horizon-testnet.stellar.org
EOF

success "Environment config written to ${ENV_FILE}"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}══════════════════════════════════════════════════════════${RESET}"
echo -e "${BOLD}${GREEN}  Deployment Complete!${RESET}"
echo -e "${BOLD}${GREEN}══════════════════════════════════════════════════════════${RESET}"
echo ""
echo -e "  ${BOLD}Contract ID :${RESET} ${CYAN}${CONTRACT_ID}${RESET}"
echo -e "  ${BOLD}Token       :${RESET} ${CYAN}${TOKEN_ADDRESS}${RESET}"
echo -e "  ${BOLD}Network     :${RESET} ${CYAN}${NETWORK}${RESET}"
echo -e "  ${BOLD}Admin       :${RESET} ${CYAN}${ADMIN_ADDRESS}${RESET}"
echo ""
echo -e "  ${BOLD}Explorer:${RESET}"
echo -e "  https://stellar.expert/explorer/testnet/contract/${CONTRACT_ID}"
echo ""
echo -e "  ${BOLD}Next steps:${RESET}"
echo -e "  ${CYAN}cd frontend && npm install && npm run dev${RESET}"
echo ""
