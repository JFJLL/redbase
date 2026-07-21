function collectTrendClaimTexts(value, key = "") {
  if (["evidenceIds", "id", "score"].includes(key)) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => collectTrendClaimTexts(item));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([childKey, childValue]) => collectTrendClaimTexts(childValue, childKey));
}

const HIGH_RISK_BRAND_CLAIM_PATTERNS = [
  /(?:官方|国家|权威|专业机构|第三方)(?:检测|检验|认证|背书)|(?:通过|获得).{0,6}(?:官方|国家|权威|专业机构|第三方).{0,4}(?:检测|检验|认证)/i,
  /(?:医疗级|医用级|临床验证|医学验证|医生推荐|专家推荐)/i,
  /(?:零蓝光|无蓝光|防近视|预防近视|治疗近视|改善视力)/i,
  /(?:儿童专用|婴幼儿专用|孕妇专用)/i,
  /(?:零风险|绝对安全|百分之百安全|100\s*%\s*安全|无毒无害)/i,
];

function findPositiveClaimMatch(text, pattern) {
  const matcher = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  for (const match of String(text || "").matchAll(matcher)) {
    const prefix = String(text || "").slice(Math.max(0, match.index - 16), match.index);
    if (!/(?:不宣称|不具备|未提供|未通过|没有|并非|不是|禁止|避免|勿称|不得)/i.test(prefix)) {
      return match[0];
    }
  }
  return "";
}

function hasPositiveBrandSupport(brandText, pattern) {
  return Boolean(findPositiveClaimMatch(brandText, pattern));
}

function isUnsupportedBrandClaimText(value, brand) {
  const text = String(value || "");
  const brandText = [brand?.description, brand?.product, brand?.knowledgeBase, ...(brand?.assetTags || [])]
    .map((item) => String(item || ""))
    .join("\n");
  return HIGH_RISK_BRAND_CLAIM_PATTERNS.some(
    (pattern) => findPositiveClaimMatch(text, pattern) && !hasPositiveBrandSupport(brandText, pattern),
  );
}

const metric = "销量|销售额|市场份额|市占率|增长率|同比|环比|渗透率|转化率|点击率|用户数|排名";
const number = "\\d+(?:\\.\\d+)?|[一二三四五六七八九十百千万两半]+";
const generalHardClaimPatterns = [
  /(?:权威数据|数据显示|报告显示|统计显示|官方发布|国家规定|政策要求|法律规定|行业标准)/i,
  /(?:监管部门|药监|政府|国家|官方).{0,12}(?:明确|要求|规定|禁止|必须|发布)/i,
  new RegExp(`(?:${metric}).{0,18}\\d+(?:\\.\\d+)?\\s*(?:%|％|万|亿|倍)?`, "i"),
  new RegExp(`\\d+(?:\\.\\d+)?\\s*(?:%|％|万|亿|倍).{0,18}(?:${metric}|增长|下降|提升)`, "i"),
  new RegExp(`(?:销量|销售额|市场份额|市占率|排名).{0,18}(?:翻(?:了)?${number}倍|跃居第?${number}|位居第?${number}|第${number}名|前${number})`, "i"),
  /(?:治疗|治愈|预防).{0,8}(?:疾病|感冒|流感|发烧|症状)|(?:疾病|感冒|流感|发烧|症状).{0,8}(?:治疗|治愈|预防)/i,
  /(?:缓解|改善|减轻|消除|控制).{0,8}(?:症状|感冒|流感|发烧|咳嗽|疼痛|鼻塞)|(?:症状|感冒|流感|发烧|咳嗽|疼痛|鼻塞).{0,8}(?:缓解|改善|减轻|消除|控制)/i,
  new RegExp(`(?:建议.{0,8})?(?:每次|每日|每天|一次|服用|用量|剂量|口服|用药|适用年龄).{0,12}(?:${number}).{0,4}(?:毫升|ml|mg|毫克|克|片|粒|袋|次|岁)`, "i"),
  /(?:疗效|有效率|零副作用|无副作用|药效更强|替代处方|替代用药)/i,
];
const dosagePattern = new RegExp(
  `(?:每|隔)?(?:${number})(?:小时|天|次).{0,8}(?:吃|服|用|片|粒|袋|毫升|ml)|(?:吃|服|用).{0,8}(?:${number})(?:片|粒|袋|毫升|ml|次)`,
  "i",
);
const medicineHardClaimPatterns = [
  /(?:治|治疗|治愈|缓解|改善|减轻|控制).{0,6}(?:感冒|流感|发烧|咳嗽|症状|疾病)|(?:感冒|流感|发烧|咳嗽|症状|疾病).{0,6}(?:治疗|治愈|缓解|改善|减轻|控制)/i,
  /(?:药品?|感冒药|服用|用药).{0,8}(?:见效|起效|效果明显)|(?:见效|起效|效果明显).{0,8}(?:药品?|感冒药|服用|用药)/i,
  /(?:退烧效果明显|止咳化痰|防止复发|避免复发)/i,
  new RegExp(`(?:${number})(?:小时|天).{0,6}(?:见效|起效)`, "i"),
];

function hasUnsupportedHardClaimText(value) {
  const text = String(value || "");
  return (
    generalHardClaimPatterns.some((pattern) => pattern.test(text)) ||
    dosagePattern.test(text) ||
    medicineHardClaimPatterns.some((pattern) => pattern.test(text))
  );
}

function hasUnsupportedHardClaim(trend) {
  return collectTrendClaimTexts(trend).some(hasUnsupportedHardClaimText);
}

module.exports = {
  HIGH_RISK_BRAND_CLAIM_PATTERNS,
  collectTrendClaimTexts,
  findPositiveClaimMatch,
  hasPositiveBrandSupport,
  hasUnsupportedHardClaim,
  hasUnsupportedHardClaimText,
  isUnsupportedBrandClaimText,
};
