import {mount} from 'svelte';
import './styles/app.css';
import App from './App.svelte';

document.querySelector('#boot-status')?.remove();
mount(App, {target: document.querySelector('#app')!});
