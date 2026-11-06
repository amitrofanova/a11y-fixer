<script setup lang="ts">
import ChildButton from './ChildButton.vue'

const show = true
const kind = 'dyn'
</script>

<template>
  <main>
    <button class="a">A</button>
    <button class="b">B</button>
    <button v-for="n in 3" :key="n" class="loop">{{ n }}</button>
    <button v-if="show" class="conditional">C</button>
    <button :class="kind" class="dynamic">D</button>
    <button class="icon" type="button"></button>
    <button v-for="n in 3" :key="n" class="repeat"></button>
    <button class="named" :aria-label="kind"></button>
    <button class="labelled" aria-label="Close"></button>
    <img class="missing" src="/photo.png">
    <img class="decorative" alt="" src="/photo.png">
    <ChildButton />
  </main>
</template>
