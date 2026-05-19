// "+ New session" pill. Sibling to RunningTerminalsPill in the breadcrumb
// nav. The cluster (running + new) is right-aligned; this pill is always
// visible while the running pill only renders when count > 0.

export function NewSessionPill({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="nsp-pill"
      onClick={onClick}
      title="Start a new Claude session (⌘/)"
    >
      <span aria-hidden="true">+</span>
      <span>New session</span>
    </button>
  );
}
