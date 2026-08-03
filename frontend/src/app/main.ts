import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { createAppRouter } from "./router";
import "@/shared/styles/base.css";
import "@/shared/styles/workspace-legacy.css";
import "@/shared/styles/auth-legacy.css";

const app = createApp(App);
app.use(createPinia());
app.use(createAppRouter());
app.mount("#app");
