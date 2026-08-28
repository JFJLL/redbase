<template>
  <div class="management-panel">
    <!-- Sub-navigation tabs -->
    <div class="sub-nav-bar">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        class="sub-tab-btn"
        :class="{ active: currentTab === tab.id }"
        :data-test="`manage-tab-${tab.id}`"
        @click="currentTab = tab.id"
      >
        {{ tab.label }}
      </button>
    </div>

    <!-- Tab 1: Users -->
    <div v-if="currentTab === 'users'" class="tab-content">
      <div class="user-management-actions-card">
        <h4 class="card-title">手动加额度</h4>
        <form class="credit-form" data-test="credit-form" @submit.prevent="submitCreditAdjustment">
          <div class="form-row">
            <div class="form-group">
              <label>目标用户</label>
              <div class="user-picker-wrapper">
                <input
                  type="text"
                  class="form-input"
                  data-test="credit-user-search"
                  placeholder="输入手机号或昵称搜索用户..."
                  v-model="creditUserSearch"
                  @focus="showCreditUserDropdown = true"
                />
                <div class="user-dropdown" v-if="showCreditUserDropdown && filteredCreditUsers.length">
                  <div
                    v-for="u in filteredCreditUsers"
                    :key="u.id"
                    class="dropdown-item"
                    :data-credit-user-id="u.id"
                    @click="selectCreditUser(u)"
                  >
                    <span>{{ u.name }}</span>
                    <span class="text-muted">({{ u.phone }})</span>
                  </div>
                </div>
              </div>
            </div>
            <div class="form-group amount-group">
              <label>增加额度</label>
              <input
                type="number"
                class="form-input"
                data-test="credit-amount"
                placeholder="数量"
                min="1"
                v-model="creditAmount"
              />
            </div>
            <div class="form-group note-group">
              <label>加额度原因 / 备注</label>
              <input
                type="text"
                class="form-input"
                data-test="credit-note"
                placeholder="选填备注..."
                v-model="creditNote"
              />
            </div>
            <button type="submit" class="submit-credit-btn" :disabled="creditSubmitting">
              {{ creditSubmitting ? '提交中...' : '确认加额度' }}
            </button>
          </div>
        </form>
      </div>

      <AdminDataTable
        :columns="userColumns"
        :items="usersData.items"
        :total="usersData.total"
        :page="usersData.page"
        :pageSize="usersData.pageSize"
        :loading="usersLoading"
        searchable
        search-placeholder="搜索姓名或手机号..."
        v-model:searchQuery="usersSearch"
        @search="loadUsers(1)"
        @page-change="loadUsers"
      >
        <template #cell-name="{ item }">
          <span data-test="admin-user-row">
            <strong>{{ item.name }}</strong>
            <span class="user-phone-sub">({{ item.phone }})</span>
          </span>
        </template>
        <template #cell-accountType="{ item }">
          <span class="role-badge" :class="item.accountType === 'yimei' ? 'role--yimei' : 'role--customer'">
            {{ item.accountType === 'yimei' ? '易美' : '客户' }}
          </span>
        </template>
        <template #cell-credits="{ item }">
          <span class="font-bold">{{ formatNumber(item.credits) }}</span>
        </template>
        <template #actions="{ item }">
          <button
            type="button"
            class="danger-action-btn"
            data-test="delete-user"
            @click="handleDeleteUser(item)"
          >
            删除
          </button>
        </template>
      </AdminDataTable>
    </div>

    <!-- Tab 2: Brands -->
    <div v-else-if="currentTab === 'brands'" class="tab-content">
      <AdminDataTable
        :columns="brandColumns"
        :items="brandsData.items"
        :total="brandsData.total"
        :page="brandsData.page"
        :pageSize="brandsData.pageSize"
        :loading="brandsLoading"
        searchable
        search-placeholder="搜索品牌名称或行业..."
        v-model:searchQuery="brandsSearch"
        @search="loadBrands(1)"
        @page-change="loadBrands"
      >
        <template #cell-name="{ item }">
          <strong>{{ item.name }}</strong>
          <div class="user-phone-sub" v-if="item.user">归属: {{ item.user.name }} ({{ item.user.phone }})</div>
        </template>
        <template #cell-createdAt="{ item }">
          <span>{{ formatDate(item.createdAt) || '历史档案' }}</span>
        </template>
      </AdminDataTable>
    </div>

    <!-- Tab 3: Generations -->
    <div v-else-if="currentTab === 'generations'" class="tab-content">
      <AdminDataTable
        :columns="generationColumns"
        :items="generationsData.items"
        :total="generationsData.total"
        :page="generationsData.page"
        :pageSize="generationsData.pageSize"
        :loading="generationsLoading"
        searchable
        search-placeholder="搜索标题、摘要或用户..."
        v-model:searchQuery="generationsSearch"
        @search="loadGenerations(1)"
        @page-change="loadGenerations"
      >
        <template #cell-cardTitle="{ item }">
          <div>
            <strong>{{ item.cardTitle || item.ideaTitle || '生成记录' }}</strong>
            <div class="user-phone-sub" v-if="item.user">创建者: {{ item.user.name }} ({{ item.user.phone }})</div>
          </div>
        </template>
        <template #cell-type="{ item }">
          <span>{{ item.channelLabel || item.type }}</span>
        </template>
        <template #cell-assetStatus="{ item }">
          <AdminStatusBadge :status="item.assetStatus" />
        </template>
        <template #cell-preview="{ item }">
          <div style="width: 100px;">
            <AdminMediaPreview
              :media-url="item.previewUrl"
              :asset-status="item.assetStatus"
              :text-summary="item.summary"
            />
          </div>
        </template>
        <template #actions="{ item }">
          <button
            type="button"
            class="danger-action-btn"
            data-test="delete-generation"
            @click="handleDeleteGeneration(item)"
          >
            删除
          </button>
        </template>
      </AdminDataTable>
    </div>

    <!-- Tab 4: Credit Events -->
    <div v-else-if="currentTab === 'credit-events'" class="tab-content">
      <div class="usage-filters-bar" data-test="usage-filters">
        <div class="filter-dropdown" data-test="usage-type-filter" @click="showUsageTypeMenu = !showUsageTypeMenu">
          <span>{{ usageTypeLabel }}</span>
          <div class="dropdown-menu" v-if="showUsageTypeMenu">
            <div class="menu-item" data-type-option="all" @click.stop="setUsageType('')">全部流水</div>
            <div class="menu-item" data-type-option="debit" @click.stop="setUsageType('debit')">仅扣除</div>
            <div class="menu-item" data-type-option="credit" @click.stop="setUsageType('credit')">仅充值/增加</div>
          </div>
        </div>
      </div>

      <AdminDataTable
        :columns="creditColumns"
        :items="filteredCreditItems"
        :total="creditEventsData.total"
        :page="creditEventsData.page"
        :pageSize="creditEventsData.pageSize"
        :loading="creditEventsLoading"
        searchable
        search-placeholder="搜索摘要或流水原因..."
        v-model:searchQuery="creditEventsSearch"
        @search="loadCreditEvents(1)"
        @page-change="loadCreditEvents"
      >
        <template #cell-summary="{ item }">
          <span data-test="usage-event-row">
            <strong>{{ item.actionLabel }}</strong>
            <div class="user-phone-sub">{{ item.summary }}</div>
          </span>
        </template>
        <template #cell-creditDelta="{ item }">
          <span :class="item.creditDelta < 0 ? 'text-danger font-bold' : 'text-success font-bold'">
            {{ item.creditDelta > 0 ? `+${item.creditDelta}` : item.creditDelta }}
          </span>
        </template>
        <template #cell-user="{ item }">
          <span v-if="item.user">{{ item.user.name }} ({{ item.user.phone }})</span>
          <span v-else class="text-muted">-</span>
        </template>
        <template #cell-createdAt="{ item }">
          <span>{{ formatDateTime(item.createdAt) }}</span>
        </template>
      </AdminDataTable>
    </div>

    <!-- Tab 5: Payment Orders -->
    <div v-else-if="currentTab === 'payment-orders'" class="tab-content">
      <AdminDataTable
        :columns="paymentColumns"
        :items="paymentOrdersData.items"
        :total="paymentOrdersData.total"
        :page="paymentOrdersData.page"
        :pageSize="paymentOrdersData.pageSize"
        :loading="paymentOrdersLoading"
        searchable
        search-placeholder="搜索订单号或交易号..."
        v-model:searchQuery="paymentOrdersSearch"
        @search="loadPaymentOrders(1)"
        @page-change="loadPaymentOrders"
      >
        <template #cell-outTradeNo="{ item }">
          <span class="font-mono">{{ item.outTradeNo }}</span>
          <div class="user-phone-sub" v-if="item.user">下单用户: {{ item.user.name }} ({{ item.user.phone }})</div>
        </template>
        <template #cell-amountYuan="{ item }">
          <span class="font-bold text-main">¥{{ item.amountYuan.toFixed(2) }}</span>
        </template>
        <template #cell-provider="{ item }">
          <span>{{ item.provider === 'wxpay' ? '微信支付' : '支付宝' }}</span>
        </template>
        <template #cell-status="{ item }">
          <AdminStatusBadge :status="item.status" />
        </template>
      </AdminDataTable>
    </div>

    <!-- Tab 6: Video Projects -->
    <div v-else-if="currentTab === 'video-projects'" class="tab-content">
      <AdminDataTable
        :columns="videoColumns"
        :items="videoProjectsData.items"
        :total="videoProjectsData.total"
        :page="videoProjectsData.page"
        :pageSize="videoProjectsData.pageSize"
        :loading="videoProjectsLoading"
        searchable
        search-placeholder="搜索请求 ID 或错误..."
        v-model:searchQuery="videoProjectsSearch"
        @search="loadVideoProjects(1)"
        @page-change="loadVideoProjects"
      >
        <template #cell-requestId="{ item }">
          <span class="font-mono">{{ item.requestId }}</span>
          <div class="user-phone-sub" v-if="item.user">用户: {{ item.user.name }} ({{ item.user.phone }})</div>
        </template>
        <template #cell-model="{ item }">
          <span class="font-bold">{{ item.model.toUpperCase() }}</span>
          <span class="text-muted" style="margin-left: 4px;">({{ item.resolution }}, {{ item.aspectRatio }})</span>
        </template>
        <template #cell-status="{ item }">
          <AdminStatusBadge :status="item.status" />
        </template>
        <template #cell-netCredits="{ item }">
          <span class="font-bold">{{ item.netCredits }}</span>
          <span class="text-muted" v-if="item.refundedCredits > 0" style="font-size: 11px;"> (退还 {{ item.refundedCredits }})</span>
        </template>
        <template #actions="{ item }">
          <button type="button" class="view-detail-btn" @click="viewProjectDetail(item.id)">
            查看详情
          </button>
        </template>
      </AdminDataTable>
    </div>

    <!-- Video Project Detail Modal -->
    <div class="modal-backdrop" v-if="selectedProjectDetail" @click.self="selectedProjectDetail = null">
      <div class="modal-dialog video-detail-dialog">
        <div class="modal-header">
          <h3>视频项目详情 (#{{ selectedProjectDetail.id }})</h3>
          <button type="button" class="close-btn" @click="selectedProjectDetail = null">×</button>
        </div>
        <div class="modal-body">
          <div class="project-info-grid">
            <div><strong>模型:</strong> {{ selectedProjectDetail.model.toUpperCase() }} ({{ selectedProjectDetail.mode }})</div>
            <div><strong>画幅 / 分辨率:</strong> {{ selectedProjectDetail.aspectRatio }} / {{ selectedProjectDetail.resolution }}</div>
            <div><strong>状态:</strong> <AdminStatusBadge :status="selectedProjectDetail.status" /></div>
            <div><strong>总时长:</strong> {{ selectedProjectDetail.totalDurationSec }} 秒</div>
            <div><strong>Net 积分:</strong> {{ selectedProjectDetail.netCredits }} (扣除 {{ selectedProjectDetail.chargedCredits }}, 退款 {{ selectedProjectDetail.refundedCredits }})</div>
            <div><strong>资产状态:</strong> <AdminStatusBadge :status="selectedProjectDetail.assetStatus" /></div>
          </div>

          <div class="detail-section" v-if="selectedProjectDetail.scriptConcept">
            <h4>分镜创意概念</h4>
            <p class="concept-text">{{ selectedProjectDetail.scriptConcept }}</p>
          </div>

          <div class="detail-section" v-if="selectedProjectDetail.hasFinalVideo">
            <h4>最终成片预览</h4>
            <AdminMediaPreview
              media-type="video"
              :media-url="`/api/video-projects/${selectedProjectDetail.id}/final`"
              :asset-status="selectedProjectDetail.assetStatus"
            />
          </div>

          <div class="detail-section">
            <h4>分镜列表 ({{ selectedProjectDetail.clips?.length || 0 }} 个片段)</h4>
            <div class="clips-list">
              <div v-for="clip in selectedProjectDetail.clips" :key="clip.id" class="clip-row">
                <span class="clip-idx">#{{ clip.clipIndex }}</span>
                <span class="clip-time">{{ clip.startSec }}s - {{ clip.endSec }}s</span>
                <span class="clip-status"><AdminStatusBadge :status="clip.status" /></span>
                <span class="clip-prompt" :title="clip.prompt">{{ clip.prompt || '默认提示词' }}</span>
                <span class="clip-error text-danger" v-if="clip.error">{{ clip.error }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import type {
  PaginatedResult,
  AdminUserItem,
  AdminBrandItem,
  AdminGenerationItem,
  AdminCreditEventItem,
  AdminPaymentOrderItem,
  AdminVideoProjectItem,
  AdminVideoProjectDetail,
} from "../types";
import {
  fetchDataUsers,
  fetchDataBrands,
  fetchDataGenerations,
  fetchDataCreditEvents,
  fetchDataPaymentOrders,
  fetchDataVideoProjects,
  fetchVideoProjectDetail,
  addUserCredits,
  deleteAdminUser,
  deleteAdminGeneration,
  formatNumber,
  formatDate,
  formatDateTime,
} from "../api";
import AdminDataTable, { type TableColumn } from "../components/AdminDataTable.vue";
import AdminStatusBadge from "../components/AdminStatusBadge.vue";
import AdminMediaPreview from "../components/AdminMediaPreview.vue";

const tabs = [
  { id: "users", label: "用户管理" },
  { id: "brands", label: "品牌档案" },
  { id: "generations", label: "生成内容" },
  { id: "credit-events", label: "积分流水" },
  { id: "payment-orders", label: "支付订单" },
  { id: "video-projects", label: "视频项目" },
];
const currentTab = ref("users");

// Users Tab
const usersLoading = ref(false);
const usersSearch = ref("");
const usersData = ref<PaginatedResult<AdminUserItem>>({ total: 0, page: 1, pageSize: 20, items: [] });

const userColumns: TableColumn[] = [
  { key: "id", label: "ID", width: "60px" },
  { key: "name", label: "用户" },
  { key: "accountType", label: "类型", width: "90px" },
  { key: "credits", label: "剩余积分", align: "right" },
  { key: "brandCount", label: "品牌数", align: "right" },
  { key: "generationCount", label: "生成数", align: "right" },
  { key: "consumedTokens", label: "累计消耗", align: "right" },
  { key: "createdAt", label: "注册时间" },
];

// Credit form state
const creditUserSearch = ref("");
const selectedCreditUser = ref<AdminUserItem | null>(null);
const creditAmount = ref("");
const creditNote = ref("");
const creditSubmitting = ref(false);
const showCreditUserDropdown = ref(false);

const filteredCreditUsers = computed(() => {
  const q = creditUserSearch.value.trim().toLowerCase();
  if (!q) return usersData.value.items.slice(0, 8);
  return usersData.value.items.filter((u) => u.name.toLowerCase().includes(q) || u.phone.includes(q)).slice(0, 8);
});

function selectCreditUser(u: AdminUserItem) {
  selectedCreditUser.value = u;
  creditUserSearch.value = `${u.name} (${u.phone})`;
  showCreditUserDropdown.value = false;
}

async function submitCreditAdjustment() {
  if (!selectedCreditUser.value) {
    alert("请先搜索并选择要加额度的用户。");
    return;
  }
  if (!creditAmount.value || Number(creditAmount.value) <= 0) {
    alert("请输入大于 0 的加额度数量");
    return;
  }
  creditSubmitting.value = true;
  try {
    await addUserCredits(selectedCreditUser.value.id, {
      amount: creditAmount.value,
      note: creditNote.value,
    });
    alert("额度增加成功");
    creditAmount.value = "";
    creditNote.value = "";
    loadUsers(usersData.value.page);
  } catch (err: any) {
    alert(err?.message || "加额度失败");
  } finally {
    creditSubmitting.value = false;
  }
}

async function handleDeleteUser(user: AdminUserItem) {
  if (user.accountType === "yimei" && user.name.includes("管理员")) {
    alert("不能删除当前登录的管理员账号。");
    return;
  }
  const confirmed = confirm(`确定删除用户「${user.name}」吗？账号关联的品牌、生成记录将被彻底删除，匿名历史经营统计仍然保留。`);
  if (!confirmed) return;
  try {
    await deleteAdminUser(user.id);
    alert("用户已删除");
    loadUsers(usersData.value.page);
  } catch (err: any) {
    alert(err?.message || "删除用户失败");
  }
}

async function loadUsers(page = 1) {
  usersLoading.value = true;
  try {
    usersData.value = await fetchDataUsers({ page, pageSize: 20, q: usersSearch.value });
  } catch (_) {}
  finally { usersLoading.value = false; }
}

// Brands Tab
const brandsLoading = ref(false);
const brandsSearch = ref("");
const brandsData = ref<PaginatedResult<AdminBrandItem>>({ total: 0, page: 1, pageSize: 20, items: [] });

const brandColumns: TableColumn[] = [
  { key: "id", label: "ID", width: "60px" },
  { key: "name", label: "品牌名称" },
  { key: "industry", label: "所属行业" },
  { key: "analysisCount", label: "分析次数", align: "right" },
  { key: "trendCount", label: "热点词数", align: "right" },
  { key: "createdAt", label: "创建时间" },
];

async function loadBrands(page = 1) {
  brandsLoading.value = true;
  try {
    brandsData.value = await fetchDataBrands({ page, pageSize: 20, q: brandsSearch.value });
  } catch (_) {}
  finally { brandsLoading.value = false; }
}

// Generations Tab
const generationsLoading = ref(false);
const generationsSearch = ref("");
const generationsData = ref<PaginatedResult<AdminGenerationItem>>({ total: 0, page: 1, pageSize: 20, items: [] });

const generationColumns: TableColumn[] = [
  { key: "id", label: "ID", width: "60px" },
  { key: "preview", label: "媒体预览", width: "110px" },
  { key: "cardTitle", label: "内容标题" },
  { key: "type", label: "功能类型" },
  { key: "assetStatus", label: "资产状态" },
  { key: "createdAt", label: "生成时间" },
];

async function handleDeleteGeneration(gen: AdminGenerationItem) {
  const confirmed = confirm(`确定删除生成内容「${gen.cardTitle || gen.ideaTitle}」吗？业务内容和媒体文件将被删除，聚合分析数据仍保留。`);
  if (!confirmed) return;
  try {
    await deleteAdminGeneration(gen.id);
    alert("生成记录已删除");
    loadGenerations(generationsData.value.page);
  } catch (err: any) {
    alert(err?.message || "删除生成记录失败");
  }
}

async function loadGenerations(page = 1) {
  generationsLoading.value = true;
  try {
    generationsData.value = await fetchDataGenerations({ page, pageSize: 20, q: generationsSearch.value });
  } catch (_) {}
  finally { generationsLoading.value = false; }
}

// Credit Events Tab
const creditEventsLoading = ref(false);
const creditEventsSearch = ref("");
const creditEventsData = ref<PaginatedResult<AdminCreditEventItem>>({ total: 0, page: 1, pageSize: 20, items: [] });
const usageTypeFilter = ref("");
const showUsageTypeMenu = ref(false);

const usageTypeLabel = computed(() => {
  if (usageTypeFilter.value === "debit") return "仅扣除";
  if (usageTypeFilter.value === "credit") return "仅充值/增加";
  return "全部流水";
});

function setUsageType(type: string) {
  usageTypeFilter.value = type;
  showUsageTypeMenu.value = false;
}

const filteredCreditItems = computed(() => {
  let items = creditEventsData.value.items;
  if (usageTypeFilter.value === "debit") {
    items = items.filter((e) => e.creditDelta < 0);
  } else if (usageTypeFilter.value === "credit") {
    items = items.filter((e) => e.creditDelta > 0);
  }
  return items;
});

const creditColumns: TableColumn[] = [
  { key: "id", label: "ID", width: "60px" },
  { key: "summary", label: "流水变动" },
  { key: "creditDelta", label: "积分变动", align: "right" },
  { key: "user", label: "所属用户" },
  { key: "createdAt", label: "发生时间" },
];

async function loadCreditEvents(page = 1) {
  creditEventsLoading.value = true;
  try {
    creditEventsData.value = await fetchDataCreditEvents({ page, pageSize: 20, q: creditEventsSearch.value });
  } catch (_) {}
  finally { creditEventsLoading.value = false; }
}

// Payment Orders Tab
const paymentOrdersLoading = ref(false);
const paymentOrdersSearch = ref("");
const paymentOrdersData = ref<PaginatedResult<AdminPaymentOrderItem>>({ total: 0, page: 1, pageSize: 20, items: [] });

const paymentColumns: TableColumn[] = [
  { key: "outTradeNo", label: "订单号" },
  { key: "planName", label: "套餐" },
  { key: "amountYuan", label: "金额", align: "right" },
  { key: "provider", label: "支付渠道" },
  { key: "status", label: "状态" },
  { key: "createdAt", label: "下单时间" },
];

async function loadPaymentOrders(page = 1) {
  paymentOrdersLoading.value = true;
  try {
    paymentOrdersData.value = await fetchDataPaymentOrders({ page, pageSize: 20, q: paymentOrdersSearch.value });
  } catch (_) {}
  finally { paymentOrdersLoading.value = false; }
}

// Video Projects Tab
const videoProjectsLoading = ref(false);
const videoProjectsSearch = ref("");
const videoProjectsData = ref<PaginatedResult<AdminVideoProjectItem>>({ total: 0, page: 1, pageSize: 20, items: [] });
const selectedProjectDetail = ref<AdminVideoProjectDetail | null>(null);

const videoColumns: TableColumn[] = [
  { key: "id", label: "ID", width: "60px" },
  { key: "requestId", label: "请求标识" },
  { key: "model", label: "视频模型" },
  { key: "totalDurationSec", label: "时长", align: "right" },
  { key: "netCredits", label: "Net 积分", align: "right" },
  { key: "status", label: "状态" },
  { key: "createdAt", label: "发起时间" },
];

async function loadVideoProjects(page = 1) {
  videoProjectsLoading.value = true;
  try {
    videoProjectsData.value = await fetchDataVideoProjects({ page, pageSize: 20, q: videoProjectsSearch.value });
  } catch (_) {}
  finally { videoProjectsLoading.value = false; }
}

async function viewProjectDetail(projectId: number) {
  try {
    const res = await fetchVideoProjectDetail(projectId);
    selectedProjectDetail.value = res.project;
  } catch (err: any) {
    alert(err?.message || "获取视频详情失败");
  }
}

onMounted(() => {
  loadUsers();
  loadBrands();
  loadGenerations();
  loadCreditEvents();
  loadPaymentOrders();
  loadVideoProjects();
});
</script>

<style scoped>
.management-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.sub-nav-bar {
  display: flex;
  gap: 8px;
  border-bottom: 1px solid #e5e7eb;
  padding-bottom: 8px;
}

.sub-tab-btn {
  background: transparent;
  border: none;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 500;
  color: #4b5563;
  cursor: pointer;
  border-radius: 6px;
  transition: all 0.15s;
}
.sub-tab-btn:hover {
  background: #f3f4f6;
  color: #111827;
}
.sub-tab-btn.active {
  background: #fee2e2;
  color: #e11d48;
  font-weight: 600;
}

.tab-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.user-management-actions-card {
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 16px;
}
.card-title {
  font-size: 14px;
  font-weight: 600;
  color: #111827;
  margin: 0 0 12px 0;
}

.form-row {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  flex-wrap: wrap;
}
.form-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.form-group label {
  font-size: 12px;
  font-weight: 500;
  color: #4b5563;
}
.form-input {
  border: 1px solid #d1d5db;
  border-radius: 4px;
  padding: 6px 10px;
  font-size: 13px;
}
.form-input:focus {
  outline: none;
  border-color: #e11d48;
}

.user-picker-wrapper {
  position: relative;
  width: 240px;
}
.user-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  background: #ffffff;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
  max-height: 200px;
  overflow-y: auto;
  z-index: 30;
  margin-top: 2px;
}
.dropdown-item {
  padding: 8px 10px;
  font-size: 13px;
  cursor: pointer;
  display: flex;
  justify-content: space-between;
}
.dropdown-item:hover {
  background: #f3f4f6;
}

.amount-group { width: 100px; }
.note-group { flex: 1; min-width: 160px; }

.submit-credit-btn {
  background: #e11d48;
  color: #ffffff;
  border: none;
  border-radius: 4px;
  padding: 7px 16px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  height: 33px;
}
.submit-credit-btn:hover:not(:disabled) {
  background: #be123c;
}
.submit-credit-btn:disabled {
  opacity: 0.6;
}

.danger-action-btn {
  background: transparent;
  border: 1px solid #fecdd3;
  color: #e11d48;
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
  cursor: pointer;
}
.danger-action-btn:hover {
  background: #fff1f2;
}

.view-detail-btn {
  background: transparent;
  border: 1px solid #d1d5db;
  color: #374151;
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
  cursor: pointer;
}
.view-detail-btn:hover {
  background: #f3f4f6;
}

.role-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
}
.role--yimei {
  background: #fee2e2;
  color: #b91c1c;
}
.role--customer {
  background: #f3f4f6;
  color: #4b5563;
}

.user-phone-sub {
  font-size: 11px;
  color: #9ca3af;
}

.font-bold { font-weight: 700; }
.font-mono { font-family: ui-monospace, monospace; font-size: 12px; }
.text-muted { color: #6b7280; }
.text-main { color: #111827; }
.text-success { color: #059669; }
.text-danger { color: #dc2626; }

/* Usage filter dropdown */
.usage-filters-bar {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-bottom: 8px;
}
.filter-dropdown {
  position: relative;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  padding: 5px 12px;
  font-size: 13px;
  background: #ffffff;
  cursor: pointer;
}
.dropdown-menu {
  position: absolute;
  top: 100%;
  left: 0;
  background: #ffffff;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);
  z-index: 20;
  margin-top: 4px;
  min-width: 120px;
}
.menu-item {
  padding: 6px 12px;
  font-size: 12px;
}
.menu-item:hover {
  background: #f3f4f6;
}

/* Modal styles */
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
  padding: 20px;
}
.modal-dialog {
  background: #ffffff;
  border-radius: 8px;
  width: 100%;
  max-width: 700px;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1);
}
.modal-header {
  padding: 16px 20px;
  border-bottom: 1px solid #e5e7eb;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.modal-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}
.close-btn {
  background: transparent;
  border: none;
  font-size: 20px;
  cursor: pointer;
  color: #6b7280;
}
.modal-body {
  padding: 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.project-info-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
  font-size: 13px;
  background: #f9fafb;
  padding: 12px;
  border-radius: 6px;
}
.detail-section h4 {
  margin: 0 0 8px 0;
  font-size: 14px;
  font-weight: 600;
}
.concept-text {
  margin: 0;
  font-size: 13px;
  color: #4b5563;
  line-height: 1.5;
}
.clips-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.clip-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  padding: 6px 8px;
  background: #f9fafb;
  border-radius: 4px;
}
.clip-idx { font-weight: 700; color: #111827; }
.clip-time { color: #6b7280; }
.clip-prompt { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
