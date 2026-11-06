/** Reports an element's content width, so charts draw at real pixels. */
export function measure(element: HTMLElement, onWidth: (width: number) => void) {
  const observer = new ResizeObserver(entries => {
    const width = Math.round(entries[0].contentRect.width);
    if (width > 0) onWidth(width);
  });
  observer.observe(element);
  return {destroy: () => observer.disconnect()};
}
