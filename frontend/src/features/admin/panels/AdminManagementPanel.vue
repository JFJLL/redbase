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
                  <button
                    v-for="u in filteredCreditUsers"
                    :key="u.id"
                    type="button"
                    class="dropdown-item"
                    :data-credit-user-id="u.id"
                    @click="selectCreditUser(u)"
                  >
                    <span>{{ u.name }}</span>
                    <span class="text-muted">({{ u.phone }})</span>
                  </button>
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
        <template #actions="{ item }">
          <button
            type="button"
            class="view-detail-btn"
            data-test="view-brand-detail"
            @click="selectedBrandDetail = item"
          >
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 10s2.7-4.5 7.5-4.5 7.5 4.5 7.5 4.5-2.7 4.5-7.5 4.5S2.5 10 2.5 10Z"/><circle cx="10" cy="10" r="2"/></svg>
            查看详情
          </button>
        </template>
      </AdminDataTable>
    </div>

    <!-- Tab 3: Generations -->
    <div v-else-if="currentTab === 'generations'" class="tab-content">
      <AdminDataTable
        class="generations-table"
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
          <div class="generation-title-cell">
            <strong class="generation-title">{{ item.cardTitle || item.ideaTitle || '生成记录' }}</strong>
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
          <AdminMediaPreview
            compact
            :media-url="item.previewUrl"
            :asset-status="item.assetStatus"
            :text-summary="item.summary"
          />
        </template>
        <template #cell-createdAt="{ item }">
          <span class="generation-time">{{ formatDateTime(item.createdAt) }}</span>
        </template>
        <template #actions="{ item }">
          <div class="action-buttons">
            <button
              type="button"
              class="view-detail-btn"
              data-test="view-generation-detail"
              @click="selectedGenerationDetail = item"
            >
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 10s2.7-4.5 7.5-4.5 7.5 4.5 7.5 4.5-2.7 4.5-7.5 4.5S2.5 10 2.5 10Z"/><circle cx="10" cy="10" r="2"/></svg>
              查看详情
            </button>
            <button
              type="button"
              class="danger-action-btn"
              data-test="delete-generation"
              @click="handleDeleteGeneration(item)"
            >
              删除
            </button>
          </div>
        </template>
      </AdminDataTable>
    </div>

    <!-- Tab 4: Credit Events -->
    <div v-else-if="currentTab === 'credit-events'" class="tab-content">
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
        <template #filters>
          <div class="usage-filters-bar" data-test="usage-filters">
            <AdminSelect
              :model-value="usageTypeFilter"
              :options="USAGE_TYPE_OPTIONS"
              label="流水类型"
              test-id="usage-type-filter"
              @change="setUsageType"
            />
          </div>
        </template>
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

    <!-- Brand Detail Modal -->
    <div class="modal-backdrop" v-if="selectedBrandDetail" @click.self="selectedBrandDetail = null">
      <section class="modal-dialog detail-dialog" role="dialog" aria-modal="true" aria-labelledby="brand-detail-title">
        <div class="modal-header detail-modal-header">
          <div>
            <span class="detail-eyebrow">品牌档案 · #{{ selectedBrandDetail.id }}</span>
            <h3 id="brand-detail-title">{{ selectedBrandDetail.name }}</h3>
          </div>
          <button type="button" class="close-btn" aria-label="关闭品牌详情" @click="selectedBrandDetail = null">×</button>
        </div>
        <div class="modal-body">
          <div class="detail-summary-grid">
            <div class="detail-stat"><span>所属行业</span><strong>{{ selectedBrandDetail.industry || '未填写' }}</strong></div>
            <div class="detail-stat"><span>档案类型</span><strong>{{ selectedBrandDetail.profileType === 'personal' ? '个人 IP' : '品牌' }}</strong></div>
            <div class="detail-stat"><span>分析 / 热点</span><strong>{{ selectedBrandDetail.analysisCount }} / {{ selectedBrandDetail.trendCount }}</strong></div>
            <div class="detail-stat"><span>创建时间</span><strong>{{ formatDateTime(selectedBrandDetail.createdAt) || '历史档案' }}</strong></div>
          </div>
          <div class="detail-owner" v-if="selectedBrandDetail.user">
            <span class="detail-owner-avatar">{{ selectedBrandDetail.user.name.slice(0, 1) }}</span>
            <div><span>档案归属</span><strong>{{ selectedBrandDetail.user.name }} · {{ selectedBrandDetail.user.phone }}</strong></div>
          </div>
          <div class="detail-section" v-if="selectedBrandDetail.product">
            <h4>产品 / 服务</h4>
            <p class="detail-copy">{{ selectedBrandDetail.product }}</p>
          </div>
          <div class="detail-section" v-if="selectedBrandDetail.audience">
            <h4>目标受众</h4>
            <p class="detail-copy">{{ selectedBrandDetail.audience }}</p>
          </div>
          <div class="detail-section" v-if="selectedBrandDetail.goal">
            <h4>运营目标</h4>
            <p class="detail-copy">{{ selectedBrandDetail.goal }}</p>
          </div>
          <div class="detail-section" v-if="selectedBrandDetail.description">
            <h4>品牌说明</h4>
            <p class="detail-copy">{{ selectedBrandDetail.description }}</p>
          </div>
          <div class="detail-section" v-if="selectedBrandDetail.knowledgeBase">
            <h4>知识库摘要</h4>
            <p class="detail-copy detail-copy--scroll">{{ selectedBrandDetail.knowledgeBase }}</p>
          </div>
          <div class="detail-section" v-if="selectedBrandDetail.assetTags?.length">
            <h4>素材标签</h4>
            <div class="detail-tags"><span v-for="tag in selectedBrandDetail.assetTags" :key="tag">{{ tag }}</span></div>
          </div>
        </div>
      </section>
    </div>

    <!-- Generation Detail Modal -->
    <div class="modal-backdrop" v-if="selectedGenerationDetail" @click.self="selectedGenerationDetail = null">
      <section class="modal-dialog detail-dialog generation-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="generation-detail-title">
        <div class="modal-header detail-modal-header">
          <div>
            <span class="detail-eyebrow">生成内容 · #{{ selectedGenerationDetail.id }}</span>
            <h3 id="generation-detail-title">{{ selectedGenerationDetail.cardTitle || selectedGenerationDetail.ideaTitle || '生成记录' }}</h3>
          </div>
          <button type="button" class="close-btn" aria-label="关闭内容详情" @click="selectedGenerationDetail = null">×</button>
        </div>
        <div class="modal-body generation-detail-body">
          <div class="generation-detail-layout">
            <div class="generation-detail-preview">
              <AdminMediaPreview
                :media-url="selectedGenerationDetail.previewUrl"
                :asset-status="selectedGenerationDetail.assetStatus"
                :text-summary="selectedGenerationDetail.summary"
              />
            </div>
            <div class="detail-summary-grid generation-meta-grid">
              <div class="detail-stat"><span>功能类型</span><strong>{{ selectedGenerationDetail.channelLabel || selectedGenerationDetail.type }}</strong></div>
              <div class="detail-stat"><span>媒体状态</span><AdminStatusBadge :status="selectedGenerationDetail.assetStatus" /></div>
              <div class="detail-stat"><span>关联品牌</span><strong>{{ selectedGenerationDetail.brandName || '未关联' }}</strong></div>
              <div class="detail-stat"><span>生成时间</span><strong>{{ formatDateTime(selectedGenerationDetail.createdAt) }}</strong></div>
              <div class="detail-stat"><span>媒体数量</span><strong>{{ selectedGenerationDetail.assetCount || 0 }}</strong></div>
              <div class="detail-stat"><span>媒体大小</span><strong>{{ formatBytes(selectedGenerationDetail.assetBytes) }}</strong></div>
            </div>
          </div>
          <div class="detail-owner" v-if="selectedGenerationDetail.user">
            <span class="detail-owner-avatar">{{ selectedGenerationDetail.user.name.slice(0, 1) }}</span>
            <div><span>创建者</span><strong>{{ selectedGenerationDetail.user.name }} · {{ selectedGenerationDetail.user.phone }}</strong></div>
          </div>
          <div class="detail-section" v-if="selectedGenerationDetail.trendTitle || selectedGenerationDetail.ideaTitle">
            <h4>创作上下文</h4>
            <div class="context-grid">
              <div v-if="selectedGenerationDetail.trendTitle"><span>热点方向</span><strong>{{ selectedGenerationDetail.trendTitle }}</strong></div>
              <div v-if="selectedGenerationDetail.ideaTitle"><span>内容选题</span><strong>{{ selectedGenerationDetail.ideaTitle }}</strong></div>
            </div>
          </div>
          <div class="detail-section" v-if="selectedGenerationDetail.summary">
            <h4>完整内容</h4>
            <p class="detail-copy detail-copy--content">{{ selectedGenerationDetail.summary }}</p>
          </div>
          <div class="detail-section" v-if="hasPayload(selectedGenerationDetail.payload)">
            <h4>结构化生成数据</h4>
            <pre class="payload-preview">{{ formatPayload(selectedGenerationDetail.payload) }}</pre>
          </div>
        </div>
      </section>
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
import AdminSelect, { type AdminSelectOption } from "../components/AdminSelect.vue";

const tabs = [
  { id: "users", label: "用户管理" },
  { id: "brands", label: "品牌档案" },
  { id: "generations", label: "生成内容" },
  { id: "credit-events", label: "积分流水" },
  { id: "payment-orders", label: "支付订单" },
  { id: "video-projects", label: "视频项目" },
];
const USAGE_TYPE_OPTIONS: AdminSelectOption[] = [
  { value: "", label: "全部流水", description: "显示所有积分变动" },
  { value: "debit", label: "仅扣除", description: "消费与生成扣费" },
  { value: "credit", label: "仅充值 / 增加", description: "充值、赠送与退款" },
];
const currentTab = ref("users");

// Users Tab
const usersLoading = ref(false);
const usersSearch = ref("");
const usersData = ref<PaginatedResult<AdminUserItem>>({ total: 0, page: 1, pageSize: 20, items: [] });

const userColumns: TableColumn[] = [
  { key: "id", label: "ID", width: "60px", align: "center" },
  { key: "name", label: "用户", align: "center" },
  { key: "accountType", label: "类型", width: "90px", align: "center" },
  { key: "credits", label: "剩余积分", align: "center" },
  { key: "brandCount", label: "品牌数", align: "center" },
  { key: "generationCount", label: "生成数", align: "center" },
  { key: "consumedTokens", label: "累计消耗", align: "center" },
  { key: "createdAt", label: "注册时间", align: "center" },
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
const selectedBrandDetail = ref<AdminBrandItem | null>(null);

const brandColumns: TableColumn[] = [
  { key: "id", label: "ID", width: "60px", align: "center" },
  { key: "name", label: "品牌名称", align: "center" },
  { key: "industry", label: "所属行业", align: "center" },
  { key: "analysisCount", label: "分析次数", align: "center" },
  { key: "trendCount", label: "热点词数", align: "center" },
  { key: "createdAt", label: "创建时间", align: "center" },
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
const selectedGenerationDetail = ref<AdminGenerationItem | null>(null);

const generationColumns: TableColumn[] = [
  { key: "id", label: "ID", width: "60px", align: "center" },
  { key: "preview", label: "媒体预览", width: "124px", align: "center" },
  { key: "cardTitle", label: "内容标题", width: "36%", align: "center" },
  { key: "type", label: "功能类型", width: "120px", align: "center" },
  { key: "assetStatus", label: "资产状态", width: "108px", align: "center" },
  { key: "createdAt", label: "生成时间", width: "170px", align: "center" },
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

function setUsageType(type: string) {
  usageTypeFilter.value = type;
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
  { key: "id", label: "ID", width: "60px", align: "center" },
  { key: "summary", label: "流水变动", width: "50%", align: "center" },
  { key: "creditDelta", label: "积分变动", width: "112px", align: "center" },
  { key: "user", label: "所属用户", width: "190px", align: "center" },
  { key: "createdAt", label: "发生时间", width: "170px", align: "center" },
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
  { key: "outTradeNo", label: "订单号", align: "center" },
  { key: "planName", label: "套餐", align: "center" },
  { key: "amountYuan", label: "金额", align: "center" },
  { key: "provider", label: "支付渠道", align: "center" },
  { key: "status", label: "状态", align: "center" },
  { key: "createdAt", label: "下单时间", align: "center" },
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
  { key: "id", label: "ID", width: "60px", align: "center" },
  { key: "requestId", label: "请求标识", align: "center" },
  { key: "model", label: "视频模型", align: "center" },
  { key: "totalDurationSec", label: "时长", align: "center" },
  { key: "netCredits", label: "Net 积分", align: "center" },
  { key: "status", label: "状态", align: "center" },
  { key: "createdAt", label: "发起时间", align: "center" },
];

async function loadVideoProjects(page = 1) {
  videoProjectsLoading.value = true;
  try {
    videoProjectsData.value = await fetchDataVideoProjects({ page, pageSize: 20, q: videoProjectsSearch.value });
  } catch (_) {}
  finally { videoProjectsLoading.value = false; }
}

async function refreshCurrentTab() {
  switch (currentTab.value) {
    case "brands":
      return loadBrands(brandsData.value.page);
    case "generations":
      return loadGenerations(generationsData.value.page);
    case "credit-events":
      return loadCreditEvents(creditEventsData.value.page);
    case "payment-orders":
      return loadPaymentOrders(paymentOrdersData.value.page);
    case "video-projects":
      return loadVideoProjects(videoProjectsData.value.page);
    case "users":
    default:
      return loadUsers(usersData.value.page);
  }
}

async function viewProjectDetail(projectId: number) {
  try {
    const res = await fetchVideoProjectDetail(projectId);
    selectedProjectDetail.value = res.project;
  } catch (err: any) {
    alert(err?.message || "获取视频详情失败");
  }
}

function formatBytes(value?: number): string {
  const bytes = Number(value || 0);
  if (!bytes) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function hasPayload(payload?: Record<string, unknown>): boolean {
  return Boolean(payload && Object.keys(payload).length);
}

function formatPayload(payload?: Record<string, unknown>): string {
  if (!payload) return "";
  const formatted = JSON.stringify(payload, null, 2);
  return formatted.length > 8000 ? `${formatted.slice(0, 8000)}\n… 已省略其余内容` : formatted;
}

onMounted(() => {
  loadUsers();
  loadBrands();
  loadGenerations();
  loadCreditEvents();
  loadPaymentOrders();
  loadVideoProjects();
});

defineExpose({
  refresh: refreshCurrentTab,
});
</script>

<style scoped>
.management-panel {
  display: flex;
  flex-direction: column;
  gap: 20px;
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
  gap: 20px;
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
  display: grid;
  grid-template-columns: minmax(220px, 1fr) 140px minmax(260px, 2fr) auto;
  align-items: flex-end;
  gap: 16px;
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
  width: 100%;
  height: 36px;
  box-sizing: border-box;
}
.form-input:focus {
  outline: none;
  border-color: #e11d48;
}

.user-picker-wrapper {
  position: relative;
  width: 100%;
}
.user-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  box-shadow: 0 14px 35px rgba(15, 23, 42, 0.14), 0 3px 8px rgba(15, 23, 42, 0.08);
  max-height: 200px;
  overflow-y: auto;
  z-index: 30;
  margin-top: 7px;
  padding: 6px;
}
.dropdown-item {
  width: 100%;
  padding: 9px 10px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: #374151;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  display: flex;
  justify-content: space-between;
  text-align: left;
}
.dropdown-item:hover,
.dropdown-item:focus-visible {
  outline: none;
  background: #fff1f2;
  color: #be123c;
}

.amount-group,
.note-group { min-width: 0; }

.submit-credit-btn {
  background: #e11d48;
  color: #ffffff;
  border: none;
  border-radius: 4px;
  padding: 7px 16px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  height: 36px;
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
  border-radius: 6px;
  padding: 5px 9px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.danger-action-btn:hover {
  background: #fff1f2;
}

.view-detail-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  background: #ffffff;
  border: 1px solid #e5e7eb;
  color: #374151;
  border-radius: 6px;
  padding: 5px 9px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease;
}
.view-detail-btn svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
}
.view-detail-btn:hover,
.view-detail-btn:focus-visible {
  outline: none;
  color: #be123c;
  border-color: #fecdd3;
  background: #fff1f2;
}
.action-buttons {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
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
}
.usage-filters-bar :deep(.admin-select) {
  min-width: 158px;
}

.generation-title-cell {
  min-width: 0;
}
.generation-title {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  line-height: 1.45;
}
.generation-time {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
:deep(.generations-table .admin-data-table) {
  min-width: 880px;
  table-layout: fixed;
}
:deep(.generations-table .admin-data-table td) {
  vertical-align: middle;
}

@media (max-width: 1100px) {
  .form-row {
    grid-template-columns: minmax(220px, 1fr) 140px minmax(240px, 1.5fr);
  }
  .submit-credit-btn {
    grid-column: 1 / -1;
    justify-self: end;
  }
}

@media (max-width: 720px) {
  .form-row {
    grid-template-columns: 1fr;
  }
  .submit-credit-btn {
    grid-column: auto;
    width: 100%;
  }
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
  border: 1px solid rgba(255, 255, 255, 0.8);
  border-radius: 14px;
  width: 100%;
  max-width: 700px;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 24px 60px rgba(15, 23, 42, 0.24);
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
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  font-size: 21px;
  line-height: 1;
  cursor: pointer;
  color: #6b7280;
  transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease;
}
.close-btn:hover,
.close-btn:focus-visible {
  outline: none;
  color: #be123c;
  border-color: #fecdd3;
  background: #fff1f2;
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

.detail-dialog {
  max-width: 780px;
}
.generation-detail-dialog {
  max-width: 920px;
}
.detail-modal-header {
  padding: 18px 22px;
  background: linear-gradient(180deg, #fff 0%, #fffafa 100%);
}
.detail-modal-header > div {
  min-width: 0;
}
.detail-modal-header h3 {
  max-width: 700px;
  margin-top: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.detail-eyebrow {
  color: #e11d48;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.detail-summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}
.detail-stat {
  min-height: 72px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 5px;
  padding: 11px 12px;
  border: 1px solid #eef0f3;
  border-radius: 9px;
  background: #fafafa;
}
.detail-stat > span:first-child,
.detail-owner div > span,
.context-grid span {
  color: #9ca3af;
  font-size: 11px;
}
.detail-stat strong,
.detail-owner strong,
.context-grid strong {
  color: #1f2937;
  font-size: 13px;
  line-height: 1.4;
}
.detail-owner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid #ffe4e6;
  border-radius: 10px;
  background: #fff7f8;
}
.detail-owner-avatar {
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  border-radius: 50%;
  background: #e11d48;
  color: #ffffff;
  font-size: 14px;
  font-weight: 700;
}
.detail-owner div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.detail-section {
  min-width: 0;
}
.detail-copy {
  margin: 0;
  padding: 12px 14px;
  border: 1px solid #eef0f3;
  border-radius: 9px;
  background: #fafafa;
  color: #4b5563;
  font-size: 13px;
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.detail-copy--scroll {
  max-height: 180px;
  overflow: auto;
}
.detail-copy--content {
  max-height: 260px;
  overflow: auto;
}
.detail-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}
.detail-tags span {
  padding: 5px 9px;
  border-radius: 999px;
  background: #fff1f2;
  color: #be123c;
  font-size: 11px;
  font-weight: 600;
}
.generation-detail-layout {
  display: grid;
  grid-template-columns: minmax(220px, 0.8fr) minmax(360px, 1.4fr);
  gap: 16px;
  align-items: stretch;
}
.generation-detail-preview {
  min-height: 180px;
  overflow: hidden;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  background: #f9fafb;
}
.generation-detail-preview :deep(.media-preview-container) {
  width: 100%;
  height: 100%;
  min-height: 180px;
  border: 0;
  border-radius: 0;
}
.generation-meta-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.context-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.context-grid > div {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 11px 12px;
  border: 1px solid #eef0f3;
  border-radius: 9px;
  background: #fafafa;
}
.payload-preview {
  max-height: 240px;
  margin: 0;
  overflow: auto;
  padding: 13px 14px;
  border: 1px solid #e5e7eb;
  border-radius: 9px;
  background: #111827;
  color: #e5e7eb;
  font-size: 11px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

@media (max-width: 780px) {
  .detail-summary-grid,
  .generation-meta-grid,
  .context-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .generation-detail-layout {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 520px) {
  .detail-summary-grid,
  .generation-meta-grid,
  .context-grid {
    grid-template-columns: 1fr;
  }
}
</style>
