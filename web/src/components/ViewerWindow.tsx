import { WindowChrome } from "./WindowChrome";

interface Props {
  title: string;
  path: string;
  defaultX: number;
  defaultY: number;
  zIndex: number;
  onFocus?: () => void;
  onClose: () => void;
}

export function ViewerWindow({ title, path, defaultX, defaultY, zIndex, onFocus, onClose }: Props) {
  return (
    <WindowChrome
      title={title}
      onFocus={onFocus}
      onClose={onClose}
      defaultX={defaultX}
      defaultY={defaultY}
      defaultW={640}
      defaultH={480}
      zIndex={zIndex}
    >
      <iframe
        src={path}
        className="viewer-iframe"
        title={title}
      />
    </WindowChrome>
  );
}
