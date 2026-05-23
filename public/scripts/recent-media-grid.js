// Flickr-style justified gallery for /tool/recent-media?view=grid.
// Reads `data-aspect-ratio` (width/height) from each .media-tile, packs
// tiles into rows of variable count, and scales each row to fill the
// container width at a near-constant row height.
(function () {
  const TARGET_ROW_HEIGHT = 200;
  const MAX_ROW_HEIGHT = 320;
  const ROW_GAP_PX = 4;
  const TILE_GAP_PX = 4;
  const DEFAULT_ASPECT = 4 / 3;

  const galleries = Array.from(document.querySelectorAll('[data-justified-gallery]'));
  if (!galleries.length) return;

  const layoutGallery = (gallery) => {
    const tiles = Array.from(gallery.children).filter(
      (el) => el instanceof HTMLElement && el.classList.contains('media-tile')
    );
    if (!tiles.length) return;

    // Switch from fallback grid to flex flow before measuring container
    // width so we measure the flex container, not the grid container
    // (they have the same width here, but be explicit).
    gallery.classList.add('is-justified');

    const containerWidth = gallery.clientWidth;
    if (containerWidth <= 0) return;

    const aspects = tiles.map((tile) => {
      const raw = Number(tile.getAttribute('data-aspect-ratio'));
      return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ASPECT;
    });

    let cursor = 0;
    while (cursor < tiles.length) {
      const row = [];
      let rowAspectSum = 0;
      while (cursor < tiles.length) {
        row.push(cursor);
        rowAspectSum += aspects[cursor];
        cursor += 1;
        const gapTotal = TILE_GAP_PX * (row.length - 1);
        const available = containerWidth - gapTotal;
        const widthIfTarget = rowAspectSum * TARGET_ROW_HEIGHT;
        if (widthIfTarget >= available) break;
      }

      const gapTotal = TILE_GAP_PX * (row.length - 1);
      const available = containerWidth - gapTotal;
      const fittedHeight = available / rowAspectSum;
      const isLastRow = cursor >= tiles.length;
      // For the last partial row, don't stretch tiles past the target —
      // an underfilled row should look natural, not zoomed in.
      const rowHeight =
        isLastRow && fittedHeight > TARGET_ROW_HEIGHT
          ? TARGET_ROW_HEIGHT
          : Math.min(fittedHeight, MAX_ROW_HEIGHT);

      row.forEach((idx) => {
        const tile = tiles[idx];
        const tileWidth = aspects[idx] * rowHeight;
        tile.style.width = `${tileWidth}px`;
        tile.style.height = `${rowHeight}px`;
      });
    }

    gallery.style.rowGap = `${ROW_GAP_PX}px`;
  };

  const layoutAll = () => {
    galleries.forEach(layoutGallery);
  };

  layoutAll();

  let resizeFrame = 0;
  window.addEventListener('resize', () => {
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(layoutAll);
  });
})();
