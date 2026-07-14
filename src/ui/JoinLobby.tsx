import { useState } from "react";

interface JoinLobbyProps {
  initialCode: string;
  onBack: () => void;
  /** Called once the host accepts the connection — wired later. For now
   *  the button just simulates "connecting" by setting local UI state. */
  onConnected: () => void;
}

const CODE_PATTERN = /^[A-HJ-NP-Z2-9]{4,8}$/;

export function JoinLobby({ initialCode, onBack, onConnected }: JoinLobbyProps) {
  const [code, setCode] = useState(initialCode.toUpperCase());
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = CODE_PATTERN.test(code);

  const connect = () => {
    if (!valid) {
      setError("Room code must be 4–8 letters/digits (no O, 0, 1, I).");
      return;
    }
    setError(null);
    setConnecting(true);
    // Stub: in the next pass, PeerJS will open a data channel to the host
    // identified by `code` here. For now we just demonstrate the UI
    // transition by going to the loading screen after a short delay.
    window.setTimeout(() => {
      onConnected();
    }, 800);
  };

  return (
    <div className="menu-screen">
      <div className="menu-card">
        <h1 className="menu-title">Join Lobby</h1>
        <p className="menu-subtitle">Enter the host's room code.</p>

        <input
          className="room-input"
          autoFocus
          value={code}
          onChange={(e) => {
            setCode(e.target.value.toUpperCase().replace(/[^A-Z2-9]/g, ""));
            setError(null);
          }}
          placeholder="ABC123"
          maxLength={8}
          disabled={connecting}
          onKeyDown={(e) => {
            if (e.key === "Enter") connect();
          }}
        />

        {error && <p className="lobby-error">{error}</p>}
        {connecting && <p className="lobby-status">Connecting to {code}…</p>}

        <div className="menu-buttons row">
          <button className="menu-btn" onClick={onBack} disabled={connecting}>Back</button>
          <button className="menu-btn primary" onClick={connect} disabled={!valid || connecting}>
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}
