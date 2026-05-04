// web/src/components/PublishedChip.tsx

import { Link2, Check, Lock } from "lucide-react";
import type { ArtefactPublication } from "../../../shared/types";
import { useCopyLink } from "../hooks/useCopyLink";
import "./PublishedChip.css";

interface Props {
  publication: ArtefactPublication;
}

export function PublishedChip({ publication }: Props) {
  const { copied, copy } = useCopyLink(publication.shareUrl);
  const isPassword = publication.shareMode === "password";
  const btnClass = `published-chip__btn${copied ? " published-chip__btn--copied" : ""}`;

  return (
    <span className="published-chip">
      <span className="published-chip__tag" title={publication.shareUrl}>
        {isPassword && <Lock className="published-chip__lock" size={9} strokeWidth={2.5} />}
        Published
      </span>
      <button
        type="button"
        className={btnClass}
        title={copied ? "Copied" : "Copy link"}
        onClick={(e) => {
          e.stopPropagation();
          void copy();
        }}
      >
        {copied ? <Check size={9} strokeWidth={3} /> : <Link2 size={9} strokeWidth={2.4} />}
      </button>
    </span>
  );
}
