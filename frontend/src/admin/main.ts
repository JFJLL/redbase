import { createApp } from "vue";
import { createPinia } from "pinia";
import AdminApp from "./AdminApp.vue";
import { createAdminRouter } from "./router";
import "@/shared/styles/base.css";

const app = createApp(AdminApp);
app.use(createPinia());
app.use(createAdminRouter());
app.mount("#admin");
