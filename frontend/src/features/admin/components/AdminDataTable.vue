<template>
  <div class="data-table-container">
    <div class="table-top-bar" v-if="$slots.filters || searchable">
      <div class="table-search-box" v-if="searchable">
        <input
          type="text"
          class="search-input"
          :placeholder="searchPlaceholder || '搜索...'"
          :value="searchQuery"
          @input="$emit('update:searchQuery', ($event.target as HTMLInputElement).value)"
          @keyup.enter="$emit('search')"
        />
        <button type="button" class="search-btn" @click="$emit('search')">查询</button>
      </div>
      <div class="table-extra-filters">
        <slot name="filters"></slot>
      </div>
    </div>

    <div class="table-content-wrapper" :class="{ loading }">
      <div class="table-loading-overlay" v-if="loading">
        <div class="spinner"></div>
      </div>

      <div v-if="!items || items.length === 0" class="table-empty">
        <span>{{ emptyText || '暂无匹配数据' }}</span>
      </div>

      <table v-else class="admin-data-table">
        <thead>
          <tr>
            <th
              v-for="col in columns"
              :key="col.key"
              :class="`text-${col.align || 'left'}`"
              :data-column="col.key"
              :data-align="col.align || 'left'"
              :style="col.width ? { width: col.width } : {}"
            >
              {{ col.label }}
            </th>
            <th v-if="$slots.actions" class="text-center" data-column="actions" data-align="center">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(item, idx) in items" :key="item.id || idx">
            <td
              v-for="col in columns"
              :key="col.key"
              :class="`text-${col.align || 'left'}`"
              :data-column="col.key"
              :data-align="col.align || 'left'"
            >
              <slot :name="`cell-${col.key}`" :item="item" :value="item[col.key]">
                {{ item[col.key] ?? '-' }}
              </slot>
            </td>
            <td v-if="$slots.actions" class="text-center" data-column="actions" data-align="center">
              <slot name="actions" :item="item"></slot>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="table-pagination-bar" v-if="total !== undefined && total > 0">
      <span class="pagination-info">
        共 <strong>{{ total }}</strong> 条记录，第 {{ page }} / {{ Math.ceil(total / pageSize) || 1 }} 页
      </span>
      <div class="pagination-controls">
        <button
          type="button"
          class="page-btn"
          :disabled="page <= 1 || loading"
          @click="$emit('page-change', page - 1)"
        >
          上一页
        </button>
        <button
          type="button"
          class="page-btn"
          :disabled="page * pageSize >= total || loading"
          @click="$emit('page-change', page + 1)"
        >
          下一页
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
export interface TableColumn {
  key: string;
  label: string;
  align?: "left" | "center" | "right";
  width?: string;
}

withDefaults(
  defineProps<{
    columns: TableColumn[];
    items: any[];
    total?: number;
    page?: number;
    pageSize?: number;
    loading?: boolean;
    searchable?: boolean;
    searchQuery?: string;
    searchPlaceholder?: string;
    emptyText?: string;
  }>(),
  {
    page: 1,
    pageSize: 20,
    searchQuery: "",
  }
);

defineEmits<{
  (e: "update:searchQuery", val: string): void;
  (e: "search"): void;
  (e: "page-change", nextPage: number): void;
}>();
</script>

<style scoped>
.data-table-container {
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.table-top-bar {
  padding: 12px 16px;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  flex-wrap: wrap;
  gap: 10px;
  border-bottom: 1px solid #f3f4f6;
  background: #fafafa;
}

.table-search-box {
  display: flex;
  align-items: center;
  gap: 6px;
}

.search-input {
  border: 1px solid #d1d5db;
  border-radius: 4px;
  padding: 6px 10px;
  font-size: 13px;
  width: 220px;
}
.search-input:focus {
  outline: none;
  border-color: #e11d48;
}

.search-btn {
  background: #ffffff;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  padding: 6px 12px;
  font-size: 13px;
  cursor: pointer;
}
.search-btn:hover {
  background: #f3f4f6;
}

.table-content-wrapper {
  position: relative;
  overflow-x: auto;
  min-height: 120px;
}

.table-loading-overlay {
  position: absolute;
  inset: 0;
  background: rgba(255, 255, 255, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 5;
}

.spinner {
  width: 24px;
  height: 24px;
  border: 2px solid #fee2e2;
  border-top-color: #e11d48;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  100% { transform: rotate(360deg); }
}

.table-empty {
  padding: 40px 20px;
  text-align: center;
  color: #9ca3af;
  font-size: 13px;
}

.admin-data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.admin-data-table th {
  background: #f9fafb;
  color: #4b5563;
  font-weight: 600;
  padding: 10px 14px;
  border-bottom: 1px solid #e5e7eb;
  text-align: left;
  white-space: nowrap;
}

.admin-data-table td {
  padding: 10px 14px;
  border-bottom: 1px solid #f3f4f6;
  color: #1f2937;
}

.admin-data-table tr:hover td {
  background: #fcfcfc;
}

.admin-data-table .text-left { text-align: left; }
.admin-data-table .text-center { text-align: center; }
.admin-data-table .text-right { text-align: right; }

.table-pagination-bar {
  padding: 10px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-top: 1px solid #f3f4f6;
  background: #fafafa;
}

.pagination-info {
  font-size: 12px;
  color: #6b7280;
}

.pagination-controls {
  display: flex;
  gap: 6px;
}

.page-btn {
  background: #ffffff;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  padding: 4px 10px;
  font-size: 12px;
  color: #374151;
  cursor: pointer;
}
.page-btn:hover:not(:disabled) {
  background: #f3f4f6;
}
.page-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
