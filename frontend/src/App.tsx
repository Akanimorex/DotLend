import React, { useState, useEffect, useCallback } from "react";
import { BrowserProvider, Contract, parseUnits, formatUnits } from "ethers";

// ── Deployed contract addresses (Paseo Asset Hub testnet) ─────────────────────
const LENDING_POOL_ADDRESS = "0xC9FcA5ec58c9C2B3cf42cC25C653293594Ca85a4";
const WDOT_ADDRESS         = "0x3aB375b76E7EE81b6bF0828496bD4EA9ea03Ad95";
const USDC_ADDRESS         = "0x6eadc1da36FeB2A4307027E520977Fdc2A50702b";

// ── ABIs ─────────────────────────────────────────────────────────────────────
const POOL_ABI = [
  "function depositCollateral(uint256 amount) external",
  "function borrowStablecoin(uint256 amount) external",
  "function repayLoan(uint256 amount) external",
  "function withdrawCollateral(uint256 amount) external",
  "function liquidate(address borrower) external",
  "function getHealthFactor(address user) external view returns (uint256)",
  "function getUserPosition(address user) external view returns (uint256 collateral, uint256 debt, uint256 healthFactor)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
];

type Tab = "deposit" | "borrow" | "repay" | "withdraw" | "liquidate";

interface Position {
  collateral: string;
  debt: string;
  healthFactor: string;
  wdotBalance: string;
  usdcBalance: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getProvider() { return new BrowserProvider(window.ethereum as any); }

export default function App(): React.ReactElement {
  const [account, setAccount]       = useState<string>("");
  const [position, setPosition]     = useState<Position | null>(null);
  const [activeTab, setActiveTab]   = useState<Tab>("deposit");
  const [amount, setAmount]         = useState<string>("");
  const [borrowerAddr, setBorrowerAddr] = useState<string>("");
  const [loading, setLoading]       = useState<boolean>(false);
  const [txHash, setTxHash]         = useState<string>("");
  const [error, setError]           = useState<string>("");
  const [refreshing, setRefreshing] = useState<boolean>(false);

  // ── Wallet connection ───────────────────────────────────────────────────────
  async function connectWallet() {
    if (!window.ethereum) {
      alert("MetaMask not detected. Please install it to use this app.");
      return;
    }
    setError("");
    try {
      const provider = getProvider();
      await provider.send("eth_requestAccounts", []);
      const signer = await provider.getSigner();
      setAccount(await signer.getAddress());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // ── Fetch position ──────────────────────────────────────────────────────────
  const fetchPosition = useCallback(async () => {
    if (!account || !window.ethereum) return;
    setRefreshing(true);
    try {
      const provider = getProvider();
      const pool  = new Contract(LENDING_POOL_ADDRESS, POOL_ABI, provider);
      const wdot  = new Contract(WDOT_ADDRESS, ERC20_ABI, provider);
      const usdc  = new Contract(USDC_ADDRESS, ERC20_ABI, provider);

      const [collateral, debt, hf] = await pool.getUserPosition(account);
      const wdotBal = await wdot.balanceOf(account);
      const usdcBal = await usdc.balanceOf(account);

      setPosition({
        collateral:   formatUnits(collateral, 18),
        debt:         formatUnits(debt, 6),
        healthFactor: debt === 0n ? "∞" : parseFloat(formatUnits(hf, 18)).toFixed(4),
        wdotBalance:  parseFloat(formatUnits(wdotBal, 18)).toFixed(4),
        usdcBalance:  parseFloat(formatUnits(usdcBal, 6)).toFixed(2),
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }, [account]);

  useEffect(() => {
    if (account) fetchPosition();
  }, [account, fetchPosition]);

  // ── Generic approve + action ────────────────────────────────────────────────
  async function approveAndCall(
    tokenAddress: string,
    decimals: number,
    rawAmount: string,
    action: (signer: Awaited<ReturnType<BrowserProvider["getSigner"]>>) => Promise<{ hash: string }>
  ) {
    setLoading(true); setError(""); setTxHash("");
    try {
      const provider = getProvider();
      const signer = await provider.getSigner();
      const token  = new Contract(tokenAddress, ERC20_ABI, signer);
      const parsed = parseUnits(rawAmount, decimals);

      // Always approve — Polkadot EVM returns 0x for eth_call view queries
      // (like allowance()), causing BAD_DATA errors. Approving unconditionally
      // is the reliable workaround.
      const approveTx = await token.approve(LENDING_POOL_ADDRESS, parsed);
      await approveTx.wait();

      const tx = await action(signer);
      setTxHash(tx.hash);
      await (tx as unknown as { wait: () => Promise<unknown> }).wait();
      await fetchPosition();
      setAmount("");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function callPool(action: (signer: Awaited<ReturnType<BrowserProvider["getSigner"]>>) => Promise<{ hash: string }>) {
    setLoading(true); setError(""); setTxHash("");
    try {
      const provider = getProvider();
      const signer = await provider.getSigner();
      const tx = await action(signer);
      setTxHash(tx.hash);
      await (tx as unknown as { wait: () => Promise<unknown> }).wait();
      await fetchPosition();
      setAmount(""); setBorrowerAddr("");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  // ── Action handlers ─────────────────────────────────────────────────────────
  function handleDeposit() {
    approveAndCall(WDOT_ADDRESS, 18, amount, async (signer) => {
      const pool = new Contract(LENDING_POOL_ADDRESS, POOL_ABI, signer);
      return pool.depositCollateral(parseUnits(amount, 18));
    });
  }

  function handleBorrow() {
    callPool(async (signer) => {
      const pool = new Contract(LENDING_POOL_ADDRESS, POOL_ABI, signer);
      return pool.borrowStablecoin(parseUnits(amount, 6));
    });
  }

  function handleRepay() {
    approveAndCall(USDC_ADDRESS, 6, amount, async (signer) => {
      const pool = new Contract(LENDING_POOL_ADDRESS, POOL_ABI, signer);
      return pool.repayLoan(parseUnits(amount, 6));
    });
  }

  function handleWithdraw() {
    callPool(async (signer) => {
      const pool = new Contract(LENDING_POOL_ADDRESS, POOL_ABI, signer);
      return pool.withdrawCollateral(parseUnits(amount, 18));
    });
  }

  function handleLiquidate() {
    callPool(async (signer) => {
      const pool = new Contract(LENDING_POOL_ADDRESS, POOL_ABI, signer);
      return pool.liquidate(borrowerAddr);
    });
  }

  // ── Health factor colour ────────────────────────────────────────────────────
  function hfColor(hf: string): string {
    if (hf === "∞") return "#4ade80";
    const v = parseFloat(hf);
    if (v >= 1.5) return "#4ade80";
    if (v >= 1.2) return "#facc15";
    return "#f87171";
  }

  // ── Tab config ──────────────────────────────────────────────────────────────
  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: "deposit",   label: "Deposit",   icon: "⬇" },
    { id: "borrow",    label: "Borrow",    icon: "💸" },
    { id: "repay",     label: "Repay",     icon: "↩" },
    { id: "withdraw",  label: "Withdraw",  icon: "⬆" },
    { id: "liquidate", label: "Liquidate", icon: "⚡" },
  ];

  const tabConfig: Record<Tab, { title: string; desc: string; token: string; label: string; unit: string }> = {
    deposit:   { title: "Deposit WDOT Collateral", desc: "Lock WDOT to increase your borrowing power. Requires 150% collateral ratio to borrow.", token: "WDOT", label: "Amount to Deposit", unit: "WDOT" },
    borrow:    { title: "Borrow MockUSDC", desc: "Borrow stablecoin against your locked collateral. Min 150% collateral ratio required.", token: "USDC", label: "Amount to Borrow", unit: "USDC" },
    repay:     { title: "Repay Loan", desc: "Repay principal + accrued interest (10% APR). Overpayment is automatically capped.", token: "USDC", label: "Amount to Repay", unit: "USDC" },
    withdraw:  { title: "Withdraw Collateral", desc: "Reclaim your WDOT. Position must remain above 150% collateral ratio after withdrawal.", token: "WDOT", label: "Amount to Withdraw", unit: "WDOT" },
    liquidate: { title: "Liquidate Position", desc: "Repay an undercollateralised borrower's debt and receive their WDOT collateral + 5% bonus.", token: "USDC", label: "Borrower Address", unit: "" },
  };

  const cfg = tabConfig[activeTab];

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        body {
          font-family: 'Inter', sans-serif;
          background: #050a18;
          min-height: 100vh;
          color: #e2e8f0;
          overflow-x: hidden;
        }

        .bg-orb {
          position: fixed;
          border-radius: 50%;
          filter: blur(120px);
          opacity: 0.15;
          pointer-events: none;
          z-index: 0;
        }

        .app-wrapper {
          position: relative;
          z-index: 1;
          max-width: 900px;
          margin: 0 auto;
          padding: 32px 16px 64px;
        }

        /* ── Header ── */
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 40px;
        }
        .logo {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .logo-icon {
          width: 40px; height: 40px;
          background: linear-gradient(135deg, #7c3aed, #2563eb);
          border-radius: 12px;
          display: flex; align-items: center; justify-content: center;
          font-size: 20px;
        }
        .logo-text h1 { font-size: 20px; font-weight: 700; letter-spacing: -0.5px; }
        .logo-text p  { font-size: 11px; color: #64748b; }

        .connect-btn {
          padding: 10px 20px;
          background: linear-gradient(135deg, #7c3aed, #2563eb);
          border: none; border-radius: 12px;
          color: #fff; font-size: 14px; font-weight: 600;
          cursor: pointer;
          transition: opacity 0.2s, transform 0.15s;
        }
        .connect-btn:hover { opacity: 0.9; transform: translateY(-1px); }

        .account-badge {
          padding: 8px 14px;
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 12px;
          font-size: 13px;
          color: #94a3b8;
          display: flex; align-items: center; gap: 8px;
        }
        .account-badge span.dot {
          width: 8px; height: 8px;
          background: #4ade80; border-radius: 50%;
          display: inline-block;
        }

        /* ── Stats row ── */
        .stats-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
          gap: 12px;
          margin-bottom: 24px;
        }
        .stat-card {
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 16px;
          padding: 20px;
          transition: border-color 0.2s;
        }
        .stat-card:hover { border-color: rgba(124,58,237,0.3); }
        .stat-label {
          font-size: 11px; font-weight: 500;
          color: #64748b; letter-spacing: 0.5px;
          text-transform: uppercase; margin-bottom: 8px;
        }
        .stat-value {
          font-size: 22px; font-weight: 700;
          letter-spacing: -0.5px;
        }
        .stat-sub { font-size: 11px; color: #475569; margin-top: 4px; }

        .refresh-btn {
          background: none; border: none;
          color: #64748b; cursor: pointer;
          font-size: 13px; padding: 4px 8px;
          border-radius: 8px;
          transition: color 0.2s, background 0.2s;
        }
        .refresh-btn:hover { color: #7c3aed; background: rgba(124,58,237,0.1); }

        /* ── Wallet balances ── */
        .balances {
          display: flex; gap: 10px;
          margin-bottom: 24px;
          flex-wrap: wrap;
        }
        .balance-chip {
          display: flex; align-items: center; gap: 6px;
          padding: 6px 12px;
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 100px;
          font-size: 12px; color: #94a3b8;
        }
        .balance-chip strong { color: #e2e8f0; }

        /* ── Main card ── */
        .main-card {
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 24px;
          overflow: hidden;
          backdrop-filter: blur(16px);
        }

        /* ── Tabs ── */
        .tabs {
          display: flex;
          background: rgba(0,0,0,0.2);
          padding: 6px;
          gap: 4px;
        }
        .tab-btn {
          flex: 1;
          padding: 10px 6px;
          border: none; border-radius: 12px;
          background: none;
          color: #64748b; font-size: 13px; font-weight: 500;
          cursor: pointer;
          transition: background 0.2s, color 0.2s;
          display: flex; align-items: center; justify-content: center; gap: 6px;
        }
        .tab-btn:hover { color: #94a3b8; background: rgba(255,255,255,0.04); }
        .tab-btn.active {
          background: linear-gradient(135deg, rgba(124,58,237,0.3), rgba(37,99,235,0.3));
          color: #e2e8f0;
          border: 1px solid rgba(124,58,237,0.3);
        }

        /* ── Form panel ── */
        .panel {
          padding: 32px;
        }
        .panel-title { font-size: 20px; font-weight: 700; margin-bottom: 6px; }
        .panel-desc  { font-size: 13px; color: #64748b; margin-bottom: 28px; line-height: 1.6; }

        .field-label {
          display: block;
          font-size: 12px; font-weight: 600;
          color: #94a3b8; text-transform: uppercase;
          letter-spacing: 0.5px; margin-bottom: 8px;
        }

        .input-wrap {
          position: relative; margin-bottom: 20px;
        }
        .input-wrap input {
          width: 100%;
          padding: 14px 60px 14px 16px;
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 14px;
          color: #e2e8f0; font-size: 16px; font-family: 'Inter', sans-serif;
          outline: none;
          transition: border-color 0.2s, box-shadow 0.2s;
        }
        .input-wrap input:focus {
          border-color: rgba(124,58,237,0.6);
          box-shadow: 0 0 0 3px rgba(124,58,237,0.15);
        }
        .input-wrap input::placeholder { color: #475569; }

        .input-unit {
          position: absolute; right: 14px; top: 50%;
          transform: translateY(-50%);
          font-size: 12px; font-weight: 600;
          color: #7c3aed;
        }

        .address-input {
          width: 100%;
          padding: 14px 16px;
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 14px;
          color: #e2e8f0; font-size: 14px; font-family: 'Inter', monospace;
          outline: none;
          transition: border-color 0.2s, box-shadow 0.2s;
          margin-bottom: 20px;
        }
        .address-input:focus {
          border-color: rgba(124,58,237,0.6);
          box-shadow: 0 0 0 3px rgba(124,58,237,0.15);
        }
        .address-input::placeholder { color: #475569; }

        /* ── Info box ── */
        .info-box {
          background: rgba(124,58,237,0.08);
          border: 1px solid rgba(124,58,237,0.2);
          border-radius: 12px;
          padding: 14px 16px;
          margin-bottom: 24px;
        }
        .info-box p { font-size: 12px; color: #7c3aed; line-height: 1.6; }

        /* ── Action button ── */
        .action-btn {
          width: 100%;
          padding: 16px;
          background: linear-gradient(135deg, #7c3aed, #2563eb);
          border: none; border-radius: 14px;
          color: #fff; font-size: 16px; font-weight: 700;
          cursor: pointer;
          transition: opacity 0.2s, transform 0.15s, box-shadow 0.2s;
          letter-spacing: 0.2px;
        }
        .action-btn:hover:not(:disabled) {
          opacity: 0.92;
          transform: translateY(-1px);
          box-shadow: 0 8px 24px rgba(124,58,237,0.3);
        }
        .action-btn:disabled {
          opacity: 0.5; cursor: not-allowed;
        }

        /* ── Liquidate danger button ── */
        .action-btn.danger {
          background: linear-gradient(135deg, #dc2626, #7c3aed);
        }
        .action-btn.danger:hover:not(:disabled) {
          box-shadow: 0 8px 24px rgba(220,38,38,0.3);
        }

        /* ── Feedback ── */
        .feedback { margin-top: 16px; }
        .tx-success {
          background: rgba(74,222,128,0.08);
          border: 1px solid rgba(74,222,128,0.2);
          border-radius: 12px;
          padding: 12px 16px;
          font-size: 12px;
          color: #4ade80;
          word-break: break-all;
        }
        .tx-success a {
          color: #4ade80; text-decoration: underline;
        }
        .tx-error {
          background: rgba(248,113,113,0.08);
          border: 1px solid rgba(248,113,113,0.2);
          border-radius: 12px;
          padding: 12px 16px;
          font-size: 12px;
          color: #f87171;
          word-break: break-all;
        }

        /* ── Loading spinner ── */
        @keyframes spin { to { transform: rotate(360deg); } }
        .spinner {
          display: inline-block;
          width: 16px; height: 16px;
          border: 2px solid rgba(255,255,255,0.3);
          border-top-color: #fff;
          border-radius: 50%;
          animation: spin 0.7s linear infinite;
          vertical-align: middle; margin-right: 8px;
        }

        /* ── Connect prompt ── */
        .connect-prompt {
          text-align: center;
          padding: 80px 32px;
        }
        .connect-prompt .big-icon { font-size: 64px; margin-bottom: 20px; }
        .connect-prompt h2 { font-size: 24px; font-weight: 700; margin-bottom: 10px; }
        .connect-prompt p  { color: #64748b; font-size: 14px; margin-bottom: 32px; line-height: 1.6; }

        /* ── Protocol badge ── */
        .protocol-info {
          display: flex; gap: 8px; flex-wrap: wrap;
          margin-bottom: 32px;
        }
        .proto-chip {
          padding: 5px 12px;
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 100px;
          font-size: 11px; color: #94a3b8;
        }
        .proto-chip span { color: #7c3aed; font-weight: 600; }
      `}</style>

      {/* Background orbs */}
      <div className="bg-orb" style={{ width: 600, height: 600, background: "#7c3aed", top: -200, left: -200 }} />
      <div className="bg-orb" style={{ width: 400, height: 400, background: "#2563eb", bottom: -100, right: -100 }} />

      <div className="app-wrapper">
        {/* ── Header ── */}
        <header className="header">
          <div className="logo">
            <div className="logo-icon">🏦</div>
            <div className="logo-text">
              <h1>stbl-lend</h1>
              <p>Polkadot Hub EVM · Paseo Testnet</p>
            </div>
          </div>
          {!account ? (
            <button className="connect-btn" onClick={connectWallet}>Connect Wallet</button>
          ) : (
            <div className="account-badge">
              <span className="dot" />
              {account.slice(0, 6)}…{account.slice(-4)}
            </div>
          )}
        </header>

        {!account ? (
          <div className="connect-prompt">
            <div className="big-icon">🔐</div>
            <h2>Stablecoin Micro-Lending</h2>
            <p>
              Deposit WDOT as collateral and borrow MockUSDC against it.<br />
              10% APR · 150% min collateral · 5% liquidation bonus.
            </p>
            <div className="protocol-info" style={{ justifyContent: "center" }}>
              <div className="proto-chip">Min Collateral <span>150%</span></div>
              <div className="proto-chip">Liquidation <span>120%</span></div>
              <div className="proto-chip">APR <span>10%</span></div>
              <div className="proto-chip">Bonus <span>5%</span></div>
            </div>
            <button className="connect-btn" onClick={connectWallet} style={{ fontSize: 16, padding: "14px 40px" }}>
              Connect Wallet
            </button>
          </div>
        ) : (
          <>
            {/* ── Position stats ── */}
            {position && (
              <>
                <div className="stats-grid">
                  <div className="stat-card">
                    <div className="stat-label">Collateral</div>
                    <div className="stat-value">{parseFloat(position.collateral).toFixed(4)}</div>
                    <div className="stat-sub">WDOT deposited</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-label">Debt</div>
                    <div className="stat-value">{parseFloat(position.debt).toFixed(2)}</div>
                    <div className="stat-sub">USDC borrowed</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-label">Health Factor</div>
                    <div className="stat-value" style={{ color: hfColor(position.healthFactor) }}>
                      {position.healthFactor}
                    </div>
                    <div className="stat-sub">≥ 1.0 is safe</div>
                  </div>
                  <div className="stat-card" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                    <div>
                      <div className="stat-label">Wallet</div>
                      <div style={{ fontSize: 14, fontWeight: 600 }}>{position.wdotBalance} WDOT</div>
                      <div style={{ fontSize: 14, fontWeight: 600, marginTop: 4 }}>{position.usdcBalance} USDC</div>
                    </div>
                    <button className="refresh-btn" onClick={fetchPosition} disabled={refreshing}>
                      {refreshing ? "↻ Refreshing…" : "↻ Refresh"}
                    </button>
                  </div>
                </div>
              </>
            )}

            {/* ── Main action card ── */}
            <div className="main-card">
              {/* Tabs */}
              <div className="tabs">
                {tabs.map(t => (
                  <button
                    key={t.id}
                    className={`tab-btn${activeTab === t.id ? " active" : ""}`}
                    onClick={() => { setActiveTab(t.id); setAmount(""); setError(""); setTxHash(""); }}
                  >
                    <span>{t.icon}</span> {t.label}
                  </button>
                ))}
              </div>

              {/* Panel */}
              <div className="panel">
                <div className="panel-title">{cfg.title}</div>
                <div className="panel-desc">{cfg.desc}</div>

                <div className="info-box">
                  <p>
                    {activeTab === "deposit"   && <>Depositing WDOT increases your borrow limit. Your wallet has <strong>{position?.wdotBalance ?? "–"} WDOT</strong>.</>}
                    {activeTab === "borrow"    && <>You can borrow up to 66% of your collateral value in USDC. Current debt: <strong>{position?.debt ?? "–"} USDC</strong>.</>}
                    {activeTab === "repay"     && <>Repaying reduces your debt and improves your Health Factor. Total owed (approx): <strong>{position?.debt ?? "–"} USDC</strong>.</>}
                    {activeTab === "withdraw"  && <>Withdrawing reduces your collateral. Position must remain ≥ 150% collateralised.</>}
                    {activeTab === "liquidate" && <>Paste a borrower's address whose Health Factor is below 1.0. You'll receive their collateral + 5% bonus.</>}
                  </p>
                </div>

                <label className="field-label">{cfg.label}</label>

                {activeTab === "liquidate" ? (
                  <input
                    className="address-input"
                    placeholder="0x… borrower address"
                    value={borrowerAddr}
                    onChange={e => setBorrowerAddr(e.target.value)}
                  />
                ) : (
                  <div className="input-wrap">
                    <input
                      type="number"
                      placeholder="0.00"
                      min="0"
                      value={amount}
                      onChange={e => setAmount(e.target.value)}
                    />
                    {cfg.unit && <span className="input-unit">{cfg.unit}</span>}
                  </div>
                )}

                <button
                  className={`action-btn${activeTab === "liquidate" ? " danger" : ""}`}
                  disabled={loading || (activeTab === "liquidate" ? !borrowerAddr : !amount || parseFloat(amount) <= 0)}
                  onClick={() => {
                    if (activeTab === "deposit")   handleDeposit();
                    else if (activeTab === "borrow")    handleBorrow();
                    else if (activeTab === "repay")     handleRepay();
                    else if (activeTab === "withdraw")  handleWithdraw();
                    else if (activeTab === "liquidate") handleLiquidate();
                  }}
                >
                  {loading
                    ? <><span className="spinner" />{activeTab === "deposit" ? "Approving & Depositing…" : "Processing…"}</>
                    : cfg.title
                  }
                </button>

                <div className="feedback">
                  {txHash && (
                    <div className="tx-success">
                      ✅ Transaction confirmed!{" "}
                      <a
                        href={`https://blockscout.polkadothub.io/tx/${txHash}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {txHash.slice(0, 20)}…
                      </a>
                    </div>
                  )}
                  {error && (
                    <div className="tx-error">
                      ⚠️ {error.length > 200 ? error.slice(0, 200) + "…" : error}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}

// Extend Window for MetaMask
declare global {
  interface Window {
    ethereum?: unknown;
  }
}
