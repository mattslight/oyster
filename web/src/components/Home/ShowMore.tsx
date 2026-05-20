// "Show more" pager used under Sessions, Memories, and Artefacts sections.
// Extracted from Home/index.tsx. Optional keyboard hints surface the
// global shortcuts where they make sense (search anywhere; new-session
// in the Sessions section).
export function ShowMore({
  onClick,
  remaining,
  searchHint = false,
  newSessionHint = false,
}: {
  onClick: () => void;
  remaining: number;
  searchHint?: boolean;
  newSessionHint?: boolean;
}) {
  return (
    <div className="home-show-more">
      <button type="button" className="home-memories-toggle" onClick={onClick}>
        Show more
      </button>
      <span className="home-show-more-hint">
        {remaining} more
        {searchHint && (
          <>
            {" · "}<kbd>⌘K</kbd> to search
          </>
        )}
        {newSessionHint && (
          <>
            {" · "}<kbd>⌘/</kbd> new session
          </>
        )}
      </span>
    </div>
  );
}
