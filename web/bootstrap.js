import init from '../.build/pkg/gtfsrt_dashboard.js';
import wasmURL from '../.build/pkg/gtfsrt_dashboard_bg.wasm';

try {
  await init({module_or_path: new URL(wasmURL, import.meta.url)});
  document.querySelector('#boot-status')?.remove();
} catch (error) {
  const status = document.querySelector('#boot-status');
  if (status) status.textContent = `The dashboard could not start: ${error.message}. Reload this page in a current desktop Chrome or Edge browser. If it still fails, check that WASM is allowed and every release asset was deployed.`;
}
