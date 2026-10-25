import { createApp } from 'vue';
import App from './App.vue';
import './styles.css';
import { setTheme, state } from './state.js';

setTheme(state.theme);
createApp(App).mount('#app');
