import { useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

interface MakeLobbyProps {
  onBack: () => void;
  /** Pressed when host is ready to start the world build. For now the lobby
   *  has no real peers and "Start" drops directly into the single-player
   *  flow — networking will be wired later via PeerJS. */
  onStart: () => void;
}

/** Avoids visually-confusable glyphs (0/O, 1/I/l) so a room code spoken
 *  over voice chat or read from a QR shows up unambiguously. */
function generateRoomCode(len = 6): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[(Math.random() * chars.length) | 0];
  return out;
}

export function MakeLobby({ onBack, onStart }: MakeLobbyProps) {
  const code = useMemo(() => generateRoomCode(), []);
  const joinUrl = useMemo(
    () => `${window.location.origin}${window.location.pathname}?join=${code}`,
    [code]
  );
  const [copied, setCopied] = useState(false);

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Older browsers / non-secure contexts: silently no-op.
    }
  };

  return (
    <div className="menu-screen">
      <div className="menu-card lobby-card">
        <h1 className="menu-title">Lobby</h1>
        <p className="menu-subtitle">Share the code or QR with players to invite them.</p>

        <div className="room-code-row">
          <button className="room-code" onClick={copyCode} title="Click to copy">
            {code}
          </button>
          {copied && <span className="room-code-copied">copied</span>}
        </div>

        <div className="qr-wrapper">
          <QRCodeSVG value={joinUrl} size={200} bgColor="#0c1016" fgColor="#e8eaed" />
        </div>

        <p className="lobby-status">Waiting for players… (networking not wired yet)</p>

        <div className="menu-buttons row">
          <button className="menu-btn" onClick={onBack}>Back</button>
          <button className="menu-btn primary" onClick={onStart}>Start</button>
        </div>
      </div>
    </div>
  );
}
