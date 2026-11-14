import {mount} from 'svelte';
import './styles/app.css';
import App from './App.svelte';

const snapshot = document.querySelector<HTMLMetaElement>('meta[name="transit-snapshot"]')?.content
  || (import.meta.env.DEV && new URLSearchParams(location.search).get('snapshot') === 'cta' ? './snapshot/index.json' : null);
document.querySelector('#boot-status')?.remove();
mount(App, {target: document.querySelector('#app')!, props: {snapshot}});
