<script setup lang="ts">
// Shared 404 view for unmatched workspace routes.
</script>

<template>
  <section class="not-found">
    <h1>页面不存在</h1>
    <RouterLink to="/">返回工作台</RouterLink>
  </section>
</template>

<style scoped>
.not-found {
  padding: 48px;
  text-align: center;
}

.not-found a {
  color: var(--color-brand);
}
</style>
