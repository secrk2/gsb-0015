import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router.js';
import { startOfflineWatch } from './offline.js';
import './styles.css';

startOfflineWatch();
createApp(App).use(router).mount('#app');
