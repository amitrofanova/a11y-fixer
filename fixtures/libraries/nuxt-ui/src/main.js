import './assets/css/main.css'
import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import ui from '@nuxt/ui/vue-plugin'
import App from './App.vue'

const app = createApp(App)
app.use(createRouter({ history: createWebHistory(), routes: [] }))
app.use(ui)
app.mount('#app')
