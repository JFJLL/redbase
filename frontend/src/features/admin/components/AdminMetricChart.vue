<template>
  <div class="chart-container">
    <div class="chart-header" v-if="title || $slots.header">
      <div class="chart-title-box">
        <h4 class="chart-title" v-if="title">{{ title }}</h4>
        <span class="chart-subtitle" v-if="subtitle">{{ subtitle }}</span>
      </div>
      <div class="chart-header-actions">
        <button
          type="button"
          class="view-mode-toggle"
          v-if="data && data.length > 0"
          @click="showTable = !showTable"
        >
          {{ showTable ? '显示图表' : '显示表格' }}
        </button>
      </div>
    </div>

    <div v-if="!data || data.length === 0" class="chart-empty">
      <span>暂无数据</span>
    </div>

    <!-- Table view fallback -->
    <div v-else-if="showTable" class="chart-table-fallback">
      <table class="simple-table">
        <thead>
          <tr>
            <th>日期 / 维度</th>
            <th class="text-right">数值</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(item, idx) in data" :key="idx">
            <td>{{ item.date || item.label || item.step || item.name }}</td>
            <td class="text-right">{{ formatNumber(item.value ?? item.count) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- SVG Chart view -->
    <div v-else ref="chartWrapper" class="svg-chart-wrapper">
      <!-- Line Chart -->
      <svg v-if="type === 'line'" :viewBox="`0 0 ${chartWidth} 200`" class="chart-svg" preserveAspectRatio="xMidYMid meet">
        <!-- Grid lines -->
        <line :x1="plotLeft" y1="20" :x2="plotRight" y2="20" stroke="#f3f4f6" stroke-width="1" />
        <line :x1="plotLeft" y1="65" :x2="plotRight" y2="65" stroke="#f3f4f6" stroke-width="1" />
        <line :x1="plotLeft" y1="110" :x2="plotRight" y2="110" stroke="#f3f4f6" stroke-width="1" />
        <line :x1="plotLeft" y1="155" :x2="plotRight" y2="155" stroke="#e5e7eb" stroke-width="1" />

        <!-- Y Axis Labels -->
        <text :x="plotLeft - 8" y="24" class="axis-text" text-anchor="end">{{ formatNumber(maxVal) }}</text>
        <text :x="plotLeft - 8" y="114" class="axis-text" text-anchor="end">{{ formatNumber(Math.round(maxVal / 3)) }}</text>
        <text :x="plotLeft - 8" y="158" class="axis-text" text-anchor="end">0</text>

        <!-- Line & Area Fill -->
        <defs>
          <linearGradient :id="`grad-${chartId}`" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#e11d48" stop-opacity="0.25" />
            <stop offset="100%" stop-color="#e11d48" stop-opacity="0.0" />
          </linearGradient>
        </defs>
        <polygon :points="areaPoints" :fill="`url(#grad-${chartId})`" />
        <polyline :points="polylinePoints" fill="none" stroke="#e11d48" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />

        <!-- Data points -->
        <g
          v-for="(p, i) in pointCoords"
          :key="i"
          class="chart-point-group"
          :aria-label="`${p.date || '数据点'}：${formatNumber(p.val)}`"
          tabindex="0"
          @mouseenter="hoveredPoint = p"
          @mouseleave="hoveredPoint = null"
          @focus="hoveredPoint = p"
          @blur="hoveredPoint = null"
        >
          <circle :cx="p.x" :cy="p.y" r="11" fill="transparent" class="chart-point-hit" />
          <circle :cx="p.x" :cy="p.y" r="4" fill="#ffffff" stroke="#e11d48" stroke-width="2" class="chart-point" />
        </g>

        <g v-if="hoveredPoint" class="chart-tooltip" pointer-events="none">
          <rect :x="tooltipPosition.x" :y="tooltipPosition.y" width="112" height="42" rx="6" fill="#111827" />
          <text :x="tooltipPosition.x + 10" :y="tooltipPosition.y + 16" class="tooltip-date">{{ hoveredPoint.date || '当前数据点' }}</text>
          <text :x="tooltipPosition.x + 10" :y="tooltipPosition.y + 33" class="tooltip-value">数值：{{ formatNumber(hoveredPoint.val) }}</text>
        </g>
      </svg>

      <!-- Bar Chart -->
      <svg v-else-if="type === 'bar'" :viewBox="`0 0 ${chartWidth} 200`" class="chart-svg" preserveAspectRatio="xMidYMid meet">
        <line :x1="plotLeft" y1="155" :x2="plotRight" y2="155" stroke="#e5e7eb" stroke-width="1" />
        <rect
          v-for="(bar, i) in barCoords"
          :key="i"
          :x="bar.x"
          :y="bar.y"
          :width="bar.w"
          :height="bar.h"
          fill="#e11d48"
          rx="3"
        />
      </svg>

      <!-- Funnel Chart -->
      <div v-else-if="type === 'funnel'" class="funnel-container">
        <div v-for="(step, i) in data" :key="i" class="funnel-step-row">
          <div class="funnel-label">{{ step.step || step.label }}</div>
          <div class="funnel-bar-wrapper">
            <div
              class="funnel-bar-fill"
              :style="{ width: `${Math.max(5, (step.rate ?? (step.count / (data[0]?.count || 1) * 100)))}%` }"
            >
              <span class="funnel-val">{{ formatNumber(step.count) }}</span>
            </div>
          </div>
          <div class="funnel-rate" v-if="step.rate !== undefined">
            {{ step.rate !== null ? `${step.rate}%` : '-' }}
          </div>
        </div>
      </div>

      <!-- X-Axis Labels for Line / Bar -->
      <div class="chart-x-labels" v-if="type === 'line' || type === 'bar'">
        <span v-for="(lbl, i) in xLabels" :key="i" class="x-label">{{ lbl }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, onBeforeUnmount, onMounted } from "vue";
import { formatNumber } from "../dateRange";

const props = withDefaults(
  defineProps<{
    type?: "line" | "bar" | "funnel" | "donut";
    title?: string;
    subtitle?: string;
    data?: Array<any>;
  }>(),
  {
    type: "line",
    data: () => [],
  }
);

const showTable = ref(false);
const chartId = Math.random().toString(36).slice(2, 8);
const chartWrapper = ref<HTMLElement | null>(null);
const chartWidth = ref(500);
type ChartPoint = { x: number; y: number; val: number; date: string };
const hoveredPoint = ref<ChartPoint | null>(null);
let resizeObserver: ResizeObserver | null = null;

const plotLeft = 48;
const plotRight = computed(() => Math.max(plotLeft + 1, chartWidth.value - 16));

function updateChartWidth() {
  const width = Math.round(chartWrapper.value?.getBoundingClientRect().width || 0);
  if (width > 0) chartWidth.value = width;
}

onMounted(async () => {
  await nextTick();
  updateChartWidth();
  if (typeof ResizeObserver !== "undefined" && chartWrapper.value) {
    resizeObserver = new ResizeObserver(updateChartWidth);
    resizeObserver.observe(chartWrapper.value);
  }
});

onBeforeUnmount(() => resizeObserver?.disconnect());

const maxVal = computed(() => {
  if (!props.data || !props.data.length) return 10;
  const vals = props.data.map((d) => Number(d.value ?? d.count ?? 0));
  const max = Math.max(...vals);
  return max <= 0 ? 10 : max;
});

const pointCoords = computed(() => {
  if (!props.data || !props.data.length) return [];
  const n = props.data.length;
  const startX = plotLeft + 2;
  const endX = plotRight.value - 8;
  const startY = 20;
  const endY = 155;
  const stepX = n > 1 ? (endX - startX) / (n - 1) : 0;
  const max = maxVal.value;

  return props.data.map((d, i) => {
    const val = Number(d.value ?? d.count ?? 0);
    const x = n === 1 ? 260 : startX + i * stepX;
    const y = endY - (val / max) * (endY - startY);
    return { x, y, val, date: d.date || d.label || "" };
  });
});

const polylinePoints = computed(() => {
  return pointCoords.value.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
});

const areaPoints = computed(() => {
  if (!pointCoords.value.length) return "";
  const pts = pointCoords.value;
  const first = pts[0];
  const last = pts[pts.length - 1];
  return `${first.x.toFixed(1)},155 ${polylinePoints.value} ${last.x.toFixed(1)},155`;
});

const tooltipPosition = computed(() => {
  const point = hoveredPoint.value;
  if (!point) return { x: 0, y: 0 };
  const x = Math.min(Math.max(4, point.x - 56), chartWidth.value - 116);
  const y = point.y < 66 ? point.y + 14 : point.y - 50;
  return { x, y };
});

const barCoords = computed(() => {
  if (!props.data || !props.data.length) return [];
  const n = props.data.length;
  const startX = plotLeft + 2;
  const totalWidth = Math.max(1, plotRight.value - startX - 8);
  const barW = Math.min(24, Math.max(6, Math.floor(totalWidth / (n * 1.5))));
  const stepX = totalWidth / n;
  const startY = 20;
  const endY = 155;
  const max = maxVal.value;

  return props.data.map((d, i) => {
    const val = Number(d.value ?? d.count ?? 0);
    const h = (val / max) * (endY - startY);
    const x = startX + i * stepX + (stepX - barW) / 2;
    const y = endY - h;
    return { x, y, w: barW, h: Math.max(2, h) };
  });
});

const xLabels = computed(() => {
  if (!props.data || !props.data.length) return [];
  const n = props.data.length;
  if (n <= 7) return props.data.map((d) => (d.date ? String(d.date).slice(5) : d.label || ""));
  // pick first, middle, last
  return [
    props.data[0].date?.slice(5) || "",
    props.data[Math.floor(n / 2)].date?.slice(5) || "",
    props.data[n - 1].date?.slice(5) || "",
  ];
});
</script>

<style scoped>
.chart-container {
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 16px;
  display: flex;
  flex-direction: column;
}

.chart-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 12px;
}

.chart-title {
  font-size: 14px;
  font-weight: 600;
  color: #111827;
  margin: 0;
}
.chart-subtitle {
  font-size: 12px;
  color: #6b7280;
  margin-top: 2px;
}

.view-mode-toggle {
  background: transparent;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  padding: 3px 8px;
  font-size: 11px;
  color: #4b5563;
  cursor: pointer;
}
.view-mode-toggle:hover {
  background: #f3f4f6;
}

.chart-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 180px;
  color: #9ca3af;
  font-size: 13px;
}

.svg-chart-wrapper {
  position: relative;
  width: 100%;
}

.chart-svg {
  width: 100%;
  height: 200px;
  display: block;
}

.chart-point-group {
  cursor: crosshair;
  outline: none;
}
.chart-point-group:hover .chart-point,
.chart-point-group:focus .chart-point {
  fill: #e11d48;
  stroke: #ffffff;
  stroke-width: 3;
}
.tooltip-date,
.tooltip-value {
  fill: #ffffff;
  font-family: inherit;
}
.tooltip-date { font-size: 11px; opacity: 0.78; }
.tooltip-value { font-size: 12px; font-weight: 600; }

.axis-text {
  font-size: 10px;
  fill: #9ca3af;
  font-family: inherit;
}

.chart-x-labels {
  display: flex;
  justify-content: space-between;
  padding: 4px 40px 0 45px;
}
.x-label {
  font-size: 10px;
  color: #9ca3af;
}

.chart-table-fallback {
  max-height: 180px;
  overflow-y: auto;
}
.simple-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.simple-table th,
.simple-table td {
  padding: 6px 8px;
  border-bottom: 1px solid #f3f4f6;
  text-align: left;
}
.simple-table th {
  color: #6b7280;
  font-weight: 500;
}
.text-right {
  text-align: right;
}

/* Funnel styles */
.funnel-container {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 0;
}
.funnel-step-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.funnel-label {
  width: 110px;
  font-size: 12px;
  color: #374151;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.funnel-bar-wrapper {
  flex: 1;
  background: #f3f4f6;
  height: 22px;
  border-radius: 4px;
  overflow: hidden;
}
.funnel-bar-fill {
  background: #e11d48;
  height: 100%;
  display: flex;
  align-items: center;
  padding: 0 8px;
  border-radius: 4px;
  transition: width 0.3s ease;
}
.funnel-val {
  color: #ffffff;
  font-size: 11px;
  font-weight: 600;
}
.funnel-rate {
  width: 45px;
  text-align: right;
  font-size: 12px;
  font-weight: 600;
  color: #111827;
}
</style>
