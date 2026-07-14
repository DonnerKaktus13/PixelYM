interface MainMenuProps {
  onSingleplayer: () => void;
  onMakeLobby: () => void;
  onJoinLobby: () => void;
  /** When truthy a Resume button appears at the top of the menu and
   *  invoking it triggers crash-recovery: rebuild the world and overlay
   *  the persisted tribe state on top. Null/undefined hides the button
   *  (no saved session). */
  onResume?: () => void;
  /** Wall-clock timestamp of the save being offered, formatted by the
   *  parent — purely for the "saved 5 min ago" caption next to Resume. */
  resumeLabel?: string | null;
}

export function MainMenu({ onSingleplayer, onMakeLobby, onJoinLobby, onResume, resumeLabel }: MainMenuProps) {
  return (
    <div className="menu-screen">
      <div className="menu-card">
        <h1 className="menu-title">Pixelwargame</h1>
        <div className="menu-buttons">
          {onResume && (
            <button className="menu-btn primary" onClick={onResume}>
              Resume{resumeLabel ? <span className="menu-btn-sub"> ({resumeLabel})</span> : null}
            </button>
          )}
          <button className={`menu-btn${onResume ? "" : " primary"}`} onClick={onSingleplayer}>
            {onResume ? "New Singleplayer Game" : "Play Singleplayer"}
          </button>
          <button className="menu-btn" onClick={onMakeLobby}>
            Make Lobby
          </button>
          <button className="menu-btn" onClick={onJoinLobby}>
            Join Lobby
          </button>
        </div>
      </div>
    </div>
  );
}
