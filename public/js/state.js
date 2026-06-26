import { DEFAULT_TREND_MODE, SIDEBAR_COLLAPSED_KEY } from "./config.js";

export const state = {
  currentPage: "landing",
  currentTab: "brands",
  brands: [],
  generationHistory: [],
  generationHistoryFilters: {
    q: "",
    brandId: "",
    type: "",
    from: "",
    to: "",
  },
  generationHistoryNeedsLatest: false,
  selectedBrandId: null,
  selectedTrendId: null,
  selectedTrendMode: DEFAULT_TREND_MODE,
  brandDetailLoadingId: null,
  xhsCategoryPath: "",
  xhsCategories: [],
  xhsCategoryStatus: "idle",
  xhsCategoryError: "",
  loading: false,
  currentUser: null,
  sessionToken: "",
  productImages: {},
  productImageLibrary: [],
  productImagePickerIdeaIndex: null,
  productImageLibrarySort: "recentUsed",
  brandLogoUsage: {},
  editingIdeas: {},
  styleReferences: {},
  sidebarCollapsed: localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true",
  resumingImageTasks: false,
};

export const mutableRefs = {
  openBrandEditor: () => {},
  pendingBrandDeleteId: null,
};
