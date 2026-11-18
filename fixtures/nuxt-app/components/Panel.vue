<script setup>
const rows = [1, 2, 3]
</script>

<template>
  <main>
    <button tabindex="3">Дальше</button>
    <button class="empty"></button>
    <button v-for="row in rows" :key="row" class="row"></button>
  </main>
</template>
