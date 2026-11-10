type SaveHost = {use(name: 'downloads'): Promise<{save(file: {filename: string; data: Blob}): Promise<unknown>} | null>};

// Files are built in the browser. Nothing is sent anywhere.
export function downloadFile(name: string, content: string, type: string) {
  const blob = new Blob([content], {type});
  const host = (globalThis as {claude?: SaveHost}).claude;
  if (typeof host?.use === 'function') {
    // A Claude artifact's frame cannot start downloads. The viewer confirms the save
    // instead; declining is a normal answer, not an error.
    void host.use('downloads').then(downloads => downloads?.save({filename: name, data: blob})).catch(() => {});
    return;
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Quotes a CSV cell and defuses values a spreadsheet would run as a formula. */
export function csvCell(value: unknown) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function downloadCsv(name: string, columns: {label: string; value: (row: any) => unknown}[], rows: any[]) {
  const lines = [columns.map(c => csvCell(c.label)).join(',')];
  for (const row of rows) lines.push(columns.map(c => csvCell(c.value(row))).join(','));
  downloadFile(name, lines.join('\r\n'), 'text/csv;charset=utf-8');
}
