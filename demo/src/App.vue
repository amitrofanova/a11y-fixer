<script setup lang="ts">
const rows = [1, 2, 3];
</script>

<template>
  <main>
    <button tabindex="0">Дальше</button>
    <button class="empty"></button>
    <img
      class="photo"
      src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
    />
    <div class="scroller">
      <p>
        Текст для прокрутки. Текст для прокрутки. Текст для прокрутки. Текст для
        прокрутки.
      </p>
      <p>
        Вторая строка длиннее области и остаётся за её нижней границей, поэтому
        регион нужно прокручивать.
      </p>
      <p>
        Третья строка тоже нужна, чтобы высота содержимого была больше высоты
        области.
      </p>
      <p>Четвёртая строка закрепляет прокрутку даже на широком окне.</p>
    </div>
    <div role="presentation" aria-label="Скрытая подпись"></div>
    <button v-for="row in rows" :key="row" class="row"></button>
    <p id="dup">Первый</p>
    <p id="dup">Второй</p>
    <audio autoplay loop src="/silence.wav"></audio>
  </main>
</template>

<style>
.scroller {
  width: 220px;
  height: 48px;
  overflow: auto;
}
</style>
