// One tooltip for the whole app. It enhances; every value is also in a table.
export interface TipRow { label?: string; value?: string; note?: string; title?: string }

class TooltipState {
  rows = $state<TipRow[] | null>(null);
  x = $state(0);
  y = $state(0);

  show(event: {clientX: number; clientY: number}, rows: TipRow[]) {
    this.rows = rows;
    this.x = event.clientX;
    this.y = event.clientY;
  }

  showFor(element: Element, rows: TipRow[]) {
    const box = element.getBoundingClientRect();
    this.show({clientX: box.left + box.width / 2, clientY: box.top}, rows);
  }

  hide() {
    this.rows = null;
  }
}

export const tooltip = new TooltipState();
