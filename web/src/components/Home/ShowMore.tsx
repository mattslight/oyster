// "Show more" pager used under both Memories and Artefacts sections.
// Extracted from Home/index.tsx.
export function ShowMore({
  onClick, remaining, searchHint = false,
}: { onClick: () => void; remaining: number; searchHint?: boolean }) {
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
      </span>
    </div>
  );
}
