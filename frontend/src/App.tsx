import React, { useState, useEffect, useCallback } from "react";
import { BrowserProvider, Contract, parseUnits, formatUnits } from "ethers";

// ── Deployed contract addresses (Paseo Asset Hub testnet) ─────────────────────
const LENDING_POOL_ADDRESS = "0xC9FcA5ec58c9C2B3cf42cC25C653293594Ca85a4";
const WDOT_ADDRESS         = "0x3aB375b76E7EE81b6bF0828496bD4EA9ea03Ad95";
const USDC_ADDRESS         = "0x6eadc1da36FeB2A4307027E520977Fdc2A50702b";

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
  "function balanceOf(address account) external view returns (uint256)",
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getProvider() { return new BrowserProvider(window.ethereum as any); }

type Tab = "deposit" | "borrow" | "repay" | "withdraw" | "liquidate";

interface Position {
  collateral: string;
  debt: string;
  healthFactor: string;
  wdotBalance: string;
  usdcBalance: string;
}

// ── DotLend Logo SVG ──────────────────────────────────────────────────────────
function DotLendLogo({ size = 40 }: { size?: number }) {
  const id = "dlg";
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id={id} x1="0" y1="100" x2="100" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0%"   stopColor="#F0287A" />
          <stop offset="100%" stopColor="#8B2A8B" />
        </linearGradient>
      </defs>
      {/* Dot grid — 5 cols × 5 rows, with organic edge trimming matching logo */}
      {[
        [1,0],[2,0],
        [0,1],[1,1],[2,1],[3,1],
        [0,2],[1,2],[2,2],[3,2],[4,2],
        [0,3],[1,3],[2,3],[3,3],[4,3],
        [1,4],[2,4],[3,4],
      ].map(([cx, cy], i) => (
        <circle key={i} cx={10 + cx * 20} cy={10 + cy * 20} r={8} fill={`url(#${id})`} />
      ))}
      {/* Arrow: up-right pointing, bold */}
      <path
        d="M52 22 L78 22 L78 48"
        stroke={`url(#${id})`} strokeWidth="11" strokeLinecap="round" strokeLinejoin="round" fill="none"
      />
      <path
        d="M40 60 L76 24"
        stroke={`url(#${id})`} strokeWidth="11" strokeLinecap="round" fill="none"
      />
    </svg>
  );
}

export default function App(): React.ReactElement {
  const [account, setAccount]           = useState<string>("");
  const [position, setPosition]         = useState<Position | null>(null);
  const [activeTab, setActiveTab]       = useState<Tab>("deposit");
  const [amount, setAmount]             = useState<string>("");
  const [borrowerAddr, setBorrowerAddr] = useState<string>("");
  const [loading, setLoading]           = useState<boolean>(false);
  const [txHash, setTxHash]             = useState<string>("");
  const [error, setError]               = useState<string>("");
  const [refreshing, setRefreshing]     = useState<boolean>(false);

  async function connectWallet() {
    if (!window.ethereum) { alert("MetaMask not detected."); return; }
    setError("");
    try {
      const provider = getProvider();
      await provider.send("eth_requestAccounts", []);
      const signer = await provider.getSigner();
      setAccount(await signer.getAddress());
    } catch (e: unknown) { setError(e instanceof Error ? e.message : String(e)); }
  }

  const fetchPosition = useCallback(async () => {
    if (!account || !window.ethereum) return;
    setRefreshing(true);
    try {
      const provider = getProvider();
      const pool = new Contract(LENDING_POOL_ADDRESS, POOL_ABI, provider);
      const wdot = new Contract(WDOT_ADDRESS, ERC20_ABI, provider);
      const usdc = new Contract(USDC_ADDRESS, ERC20_ABI, provider);
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
    } catch (e: unknown) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setRefreshing(false); }
  }, [account]);

  useEffect(() => { if (account) fetchPosition(); }, [account, fetchPosition]);

  async function approveAndCall(
    tokenAddress: string,
    decimals: number,
    rawAmount: string,
    action: (signer: Awaited<ReturnType<BrowserProvider["getSigner"]>>) => Promise<{ hash: string }>
  ) {
    setLoading(true); setError(""); setTxHash("");
    try {
      const signer = await getProvider().getSigner();
      const token  = new Contract(tokenAddress, ERC20_ABI, signer);
      const parsed = parseUnits(rawAmount, decimals);
      const approveTx = await token.approve(LENDING_POOL_ADDRESS, parsed);
      await approveTx.wait();
      const tx = await action(signer);
      setTxHash(tx.hash);
      await (tx as unknown as { wait: () => Promise<unknown> }).wait();
      await fetchPosition();
      setAmount("");
    } catch (e: unknown) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }

  async function callPool(action: (signer: Awaited<ReturnType<BrowserProvider["getSigner"]>>) => Promise<{ hash: string }>) {
    setLoading(true); setError(""); setTxHash("");
    try {
      const signer = await getProvider().getSigner();
      const tx = await action(signer);
      setTxHash(tx.hash);
      await (tx as unknown as { wait: () => Promise<unknown> }).wait();
      await fetchPosition();
      setAmount(""); setBorrowerAddr("");
    } catch (e: unknown) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }

  const handleDeposit  = () => approveAndCall(WDOT_ADDRESS, 18, amount, async (s) => new Contract(LENDING_POOL_ADDRESS, POOL_ABI, s).depositCollateral(parseUnits(amount, 18)));
  const handleBorrow   = () => callPool(async (s) => new Contract(LENDING_POOL_ADDRESS, POOL_ABI, s).borrowStablecoin(parseUnits(amount, 6)));
  const handleRepay    = () => approveAndCall(USDC_ADDRESS, 6, amount, async (s) => new Contract(LENDING_POOL_ADDRESS, POOL_ABI, s).repayLoan(parseUnits(amount, 6)));
  const handleWithdraw = () => callPool(async (s) => new Contract(LENDING_POOL_ADDRESS, POOL_ABI, s).withdrawCollateral(parseUnits(amount, 18)));
  const handleLiquidate = () => callPool(async (s) => new Contract(LENDING_POOL_ADDRESS, POOL_ABI, s).liquidate(borrowerAddr));

  function hfColor(hf: string) {
    if (hf === "∞") return "#4ade80";
    const v = parseFloat(hf);
    return v >= 1.5 ? "#4ade80" : v >= 1.2 ? "#facc15" : "#f87171";
  }

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: "deposit",   label: "Deposit",   icon: "⬇" },
    { id: "borrow",    label: "Borrow",    icon: "💸" },
    { id: "repay",     label: "Repay",     icon: "↩" },
    { id: "withdraw",  label: "Withdraw",  icon: "⬆" },
    { id: "liquidate", label: "Liquidate", icon: "⚡" },
  ];

  const tabConfig: Record<Tab, { title: string; desc: string; info: React.ReactNode; unit: string; isLiquidate?: boolean }> = {
    deposit:   { title: "Deposit WDOT Collateral",  unit: "WDOT", desc: "Lock WDOT to increase your borrowing power. Requires 150% collateral ratio to borrow.", info: <>Your wallet: <b>{position?.wdotBalance ?? "–"} WDOT</b></> },
    borrow:    { title: "Borrow MockUSDC",           unit: "USDC", desc: "Borrow stablecoin against your locked WDOT. Requires ≥ 150% collateral ratio.", info: <>Current debt: <b>{position?.debt ?? "–"} USDC</b></> },
    repay:     { title: "Repay Loan",                unit: "USDC", desc: "Repay principal + accrued interest (10% APR). Overpayment is automatically capped.", info: <>Total owed (approx): <b>{position?.debt ?? "–"} USDC</b></> },
    withdraw:  { title: "Withdraw Collateral",       unit: "WDOT", desc: "Reclaim your WDOT. Position must remain above 150% collateral ratio after withdrawal.", info: <>Deposited: <b>{position?.collateral ?? "–"} WDOT</b></> },
    liquidate: { title: "Liquidate Position",        unit: "",     desc: "Repay an undercollateralised borrower's debt and receive their WDOT + 5% bonus.", info: <>Target Health Factor must be <b>&lt; 1.0</b></>, isLiquidate: true },
  };

  const cfg = tabConfig[activeTab];

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          font-family: 'Inter', sans-serif;
          background: #0a0610;
          min-height: 100vh;
          color: #f0e8f5;
          overflow-x: hidden;
        }
        .orb {
          position: fixed; border-radius: 50%; filter: blur(130px);
          opacity: 0.18; pointer-events: none; z-index: 0;
        }
        .wrap { position: relative; z-index: 1; max-width: 900px; margin: 0 auto; padding: 32px 16px 80px; }

        /* Header */
        .hdr { display: flex; align-items: center; justify-content: space-between; margin-bottom: 40px; }
        .brand { display: flex; align-items: center; gap: 12px; }
        .brand-text h1 { font-size: 22px; font-weight: 800; letter-spacing: -0.5px; background: linear-gradient(90deg,#F0287A,#8B2A8B); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .brand-text p  { font-size: 11px; color: #7a5a88; }
        .connect-btn {
          padding: 10px 22px;
          background: linear-gradient(135deg,#F0287A,#8B2A8B);
          border: none; border-radius: 12px; color: #fff; font-size: 14px; font-weight: 700;
          cursor: pointer; transition: opacity .2s, transform .15s;
        }
        .connect-btn:hover { opacity: 0.88; transform: translateY(-1px); }
        .acct-badge {
          display: flex; align-items: center; gap: 8px;
          padding: 8px 14px; border-radius: 12px;
          background: rgba(240,40,122,.08); border: 1px solid rgba(240,40,122,.2);
          font-size: 13px; color: #c97ab0;
        }
        .pulse { width: 8px; height: 8px; border-radius: 50%; background: #F0287A; animation: pulse 2s ease infinite; }
        @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.5;transform:scale(.8)} }

        /* Stats */
        .stats { display: grid; grid-template-columns: repeat(auto-fit,minmax(160px,1fr)); gap: 12px; margin-bottom: 24px; }
        .stat {
          background: rgba(240,40,122,.05); border: 1px solid rgba(240,40,122,.12);
          border-radius: 16px; padding: 20px; transition: border-color .2s;
        }
        .stat:hover { border-color: rgba(240,40,122,.3); }
        .stat-lbl { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .6px; color: #7a5a88; margin-bottom: 8px; }
        .stat-val { font-size: 22px; font-weight: 800; letter-spacing: -.5px; }
        .stat-sub { font-size: 11px; color: #5a3a66; margin-top: 4px; }
        .refresh-btn { background: none; border: none; color: #7a5a88; cursor: pointer; font-size: 12px; padding: 4px 8px; border-radius: 8px; transition: color .2s, background .2s; }
        .refresh-btn:hover { color: #F0287A; background: rgba(240,40,122,.1); }
        .balances { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 24px; }
        .bal-chip {
          display: flex; align-items: center; gap: 6px; padding: 6px 14px;
          background: rgba(240,40,122,.06); border: 1px solid rgba(240,40,122,.12);
          border-radius: 100px; font-size: 12px; color: #b07aa8;
        }
        .bal-chip strong { color: #f0e8f5; }

        /* Main card */
        .card {
          background: rgba(30,10,40,.6); border: 1px solid rgba(240,40,122,.12);
          border-radius: 24px; overflow: hidden; backdrop-filter: blur(20px);
        }

        /* Tabs */
        .tabs { display: flex; background: rgba(0,0,0,.3); padding: 6px; gap: 4px; }
        .tab {
          flex: 1; padding: 10px 6px; border: none; border-radius: 12px;
          background: none; color: #7a5a88; font-size: 13px; font-weight: 500;
          cursor: pointer; transition: background .2s, color .2s;
          display: flex; align-items: center; justify-content: center; gap: 5px;
        }
        .tab:hover { color: #c97ab0; background: rgba(240,40,122,.07); }
        .tab.active {
          background: linear-gradient(135deg,rgba(240,40,122,.25),rgba(139,42,139,.25));
          color: #f0e8f5; border: 1px solid rgba(240,40,122,.3);
        }

        /* Panel */
        .panel { padding: 32px; }
        .p-title { font-size: 20px; font-weight: 800; margin-bottom: 6px; }
        .p-desc  { font-size: 13px; color: #7a5a88; margin-bottom: 28px; line-height: 1.6; }
        .field-lbl { display: block; font-size: 11px; font-weight: 700; color: #b07aa8; text-transform: uppercase; letter-spacing: .6px; margin-bottom: 8px; }

        .info-box {
          background: rgba(240,40,122,.07); border: 1px solid rgba(240,40,122,.18);
          border-radius: 12px; padding: 13px 16px; margin-bottom: 24px;
          font-size: 12px; color: #c97ab0; line-height: 1.6;
        }
        .info-box b { color: #f0e8f5; }

        .inp-wrap { position: relative; margin-bottom: 20px; }
        .inp-wrap input, .addr-inp {
          width: 100%; padding: 14px 60px 14px 16px;
          background: rgba(240,40,122,.06); border: 1px solid rgba(240,40,122,.15);
          border-radius: 14px; color: #f0e8f5; font-size: 16px; font-family: 'Inter',sans-serif;
          outline: none; transition: border-color .2s, box-shadow .2s;
        }
        .addr-inp { padding: 14px 16px; font-size: 14px; font-family: 'Inter',monospace; margin-bottom: 20px; }
        .inp-wrap input:focus, .addr-inp:focus {
          border-color: rgba(240,40,122,.6);
          box-shadow: 0 0 0 3px rgba(240,40,122,.15);
        }
        .inp-wrap input::placeholder, .addr-inp::placeholder { color: #4a2a55; }
        .inp-unit { position: absolute; right: 14px; top: 50%; transform: translateY(-50%); font-size: 12px; font-weight: 700; color: #F0287A; }

        .action-btn {
          width: 100%; padding: 16px;
          background: linear-gradient(135deg,#F0287A,#8B2A8B);
          border: none; border-radius: 14px; color: #fff; font-size: 16px; font-weight: 800;
          cursor: pointer; transition: opacity .2s, transform .15s, box-shadow .2s;
        }
        .action-btn:hover:not(:disabled) { opacity: .9; transform: translateY(-1px); box-shadow: 0 8px 28px rgba(240,40,122,.35); }
        .action-btn:disabled { opacity: .45; cursor: not-allowed; }
        .action-btn.danger { background: linear-gradient(135deg,#dc2626,#8B2A8B); }
        .action-btn.danger:hover:not(:disabled) { box-shadow: 0 8px 28px rgba(220,38,38,.3); }

        .feedback { margin-top: 16px; }
        .tx-ok {
          background: rgba(74,222,128,.08); border: 1px solid rgba(74,222,128,.2);
          border-radius: 12px; padding: 12px 16px; font-size: 12px; color: #4ade80; word-break: break-all;
        }
        .tx-ok a { color: #4ade80; }
        .tx-err {
          background: rgba(240,40,122,.08); border: 1px solid rgba(240,40,122,.2);
          border-radius: 12px; padding: 12px 16px; font-size: 12px; color: #f87171; word-break: break-all;
        }

        @keyframes spin { to { transform: rotate(360deg); } }
        .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid rgba(255,255,255,.3); border-top-color: #fff; border-radius: 50%; animation: spin .7s linear infinite; vertical-align: middle; margin-right: 8px; }

        /* Landing */
        .landing { text-align: center; padding: 80px 32px; }
        .landing h2 { font-size: 28px; font-weight: 800; margin: 20px 0 10px; background: linear-gradient(90deg,#F0287A,#8B2A8B); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .landing p { color: #7a5a88; font-size: 14px; margin-bottom: 32px; line-height: 1.7; }
        .chips { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; margin-bottom: 36px; }
        .chip { padding: 5px 14px; background: rgba(240,40,122,.08); border: 1px solid rgba(240,40,122,.18); border-radius: 100px; font-size: 12px; color: #b07aa8; }
        .chip span { color: #F0287A; font-weight: 700; }
      `}</style>

      {/* Orbs */}
      <div className="orb" style={{ width: 600, height: 600, background: "#F0287A", top: -200, left: -200 }} />
      <div className="orb" style={{ width: 400, height: 400, background: "#8B2A8B", bottom: -100, right: -100 }} />

      <div className="wrap">
        {/* Header */}
        <header className="hdr">
          <div className="brand">
            <DotLendLogo size={42} />
            <div className="brand-text">
              <h1>DotLend</h1>
              <p>Polkadot Hub EVM · Paseo Testnet</p>
            </div>
          </div>
          {!account
            ? <button className="connect-btn" onClick={connectWallet}>Connect Wallet</button>
            : <div className="acct-badge"><span className="pulse" />{account.slice(0,6)}…{account.slice(-4)}</div>
          }
        </header>

        {!account ? (
          <div className="landing">
            <DotLendLogo size={80} />
            <h2>Stablecoin Micro-Lending</h2>
            <p>Deposit WDOT as collateral and borrow MockUSDC against it.<br />Simple interest · Aave-style health factor · Instant liquidations.</p>
            <div className="chips">
              <div className="chip">Min Collateral <span>150%</span></div>
              <div className="chip">Liquidation <span>120%</span></div>
              <div className="chip">APR <span>10%</span></div>
              <div className="chip">Liq. Bonus <span>5%</span></div>
            </div>
            <button className="connect-btn" style={{ fontSize: 16, padding: "14px 44px" }} onClick={connectWallet}>Connect Wallet</button>
          </div>
        ) : (
          <>
            {position && (
              <>
                <div className="stats">
                  <div className="stat">
                    <div className="stat-lbl">Collateral</div>
                    <div className="stat-val">{parseFloat(position.collateral).toFixed(4)}</div>
                    <div className="stat-sub">WDOT deposited</div>
                  </div>
                  <div className="stat">
                    <div className="stat-lbl">Debt</div>
                    <div className="stat-val">{parseFloat(position.debt).toFixed(2)}</div>
                    <div className="stat-sub">USDC borrowed</div>
                  </div>
                  <div className="stat">
                    <div className="stat-lbl">Health Factor</div>
                    <div className="stat-val" style={{ color: hfColor(position.healthFactor) }}>{position.healthFactor}</div>
                    <div className="stat-sub">≥ 1.0 is safe</div>
                  </div>
                  <div className="stat" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                    <div>
                      <div className="stat-lbl">Wallet</div>
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

            <div className="card">
              <div className="tabs">
                {tabs.map(t => (
                  <button key={t.id} className={`tab${activeTab === t.id ? " active" : ""}`}
                    onClick={() => { setActiveTab(t.id); setAmount(""); setError(""); setTxHash(""); }}>
                    {t.icon} {t.label}
                  </button>
                ))}
              </div>

              <div className="panel">
                <div className="p-title">{cfg.title}</div>
                <div className="p-desc">{cfg.desc}</div>
                <div className="info-box">{cfg.info}</div>

                <label className="field-lbl">{cfg.isLiquidate ? "Borrower Address" : `Amount (${cfg.unit})`}</label>

                {cfg.isLiquidate ? (
                  <input className="addr-inp" placeholder="0x… borrower address" value={borrowerAddr} onChange={e => setBorrowerAddr(e.target.value)} />
                ) : (
                  <div className="inp-wrap">
                    <input type="number" placeholder="0.00" min="0" value={amount} onChange={e => setAmount(e.target.value)} />
                    {cfg.unit && <span className="inp-unit">{cfg.unit}</span>}
                  </div>
                )}

                <button
                  className={`action-btn${cfg.isLiquidate ? " danger" : ""}`}
                  disabled={loading || (cfg.isLiquidate ? !borrowerAddr : !amount || parseFloat(amount) <= 0)}
                  onClick={() => {
                    if (activeTab === "deposit")   handleDeposit();
                    else if (activeTab === "borrow")   handleBorrow();
                    else if (activeTab === "repay")    handleRepay();
                    else if (activeTab === "withdraw") handleWithdraw();
                    else handleLiquidate();
                  }}
                >
                  {loading ? <><span className="spinner" />Processing…</> : cfg.title}
                </button>

                <div className="feedback">
                  {txHash && (
                    <div className="tx-ok">✅ Confirmed! <a href={`https://blockscout.polkadothub.io/tx/${txHash}`} target="_blank" rel="noreferrer">{txHash.slice(0, 22)}…</a></div>
                  )}
                  {error && <div className="tx-err">⚠️ {error.length > 200 ? error.slice(0, 200) + "…" : error}</div>}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}

declare global {
  interface Window { ethereum?: unknown; }
}
