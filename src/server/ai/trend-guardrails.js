function collectTrendClaimTexts(value, key = "") {
  if (["evidenceIds", "id", "score"].includes(key)) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => collectTrendClaimTexts(item));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([childKey, childValue]) => collectTrendClaimTexts(childValue, childKey));
}

function buildCredentialClaimPatterns(subjectPattern) {
  return [
    new RegExp(`${subjectPattern}.{0,8}(?:检测|检验)|(?:通过|完成).{0,8}${subjectPattern}.{0,8}(?:检测|检验)`, "i"),
    new RegExp(`${subjectPattern}.{0,8}认证|(?:通过|获得).{0,8}${subjectPattern}.{0,8}认证`, "i"),
    new RegExp(`${subjectPattern}.{0,8}背书|(?:获得).{0,8}${subjectPattern}.{0,8}背书`, "i"),
  ];
}

const HIGH_RISK_BRAND_CLAIM_PATTERNS = [
  ...buildCredentialClaimPatterns("官方"),
  ...buildCredentialClaimPatterns("国家"),
  ...buildCredentialClaimPatterns("权威(?:机构)?"),
  ...buildCredentialClaimPatterns("专业机构"),
  ...buildCredentialClaimPatterns("第三方"),
  /医疗级/i,
  /医用级/i,
  /临床验证/i,
  /医学验证/i,
  /医生推荐/i,
  /专家推荐/i,
  /零蓝光/i,
  /无蓝光/i,
  /防近视/i,
  /预防近视/i,
  /治疗近视/i,
  /改善视力/i,
  /儿童专用/i,
  /婴幼儿专用/i,
  /孕妇专用/i,
  /零风险/i,
  /绝对安全/i,
  /百分之百安全/i,
  /100\s*%\s*安全/i,
  /无毒无害/i,
];

function getClaimContext(source, index, length) {
  const clauseBoundary = /[，。；;！？!?\n]|(?:但是|但|却|然而|反而|不过)/;
  // A negation in one coordinate clause must not suppress a later positive
  // claim merely because the model omitted punctuation between them.
  const prefixClauseBoundary = /[，。；;！？!?\n]|(?:但是|但|却|然而|反而|不过|同时|并且|而且|另外|此外|再者)/;
  const rawPrefix = source.slice(Math.max(0, index - 48), index);
  const rawSuffix = source.slice(index + length, index + length + 48);
  return {
    rawPrefix,
    rawSuffix,
    prefix: rawPrefix.split(prefixClauseBoundary).at(-1).slice(-24),
    suffix: rawSuffix.split(clauseBoundary)[0].slice(0, 24),
  };
}

function hasScopedClaimNegation(prefix) {
  const source = String(prefix || "").trim();
  if (!source) return false;
  if (/(?:已?被)?(?:辟谣|证伪|驳斥|反驳|批驳)|(?:无法|未能|难以|不足以)(?:证实|确认|验证|证明)|(?:尚无|并无|未有|缺乏|没有).{0,8}(?:证据|依据)(?:支持|表明|证明|证实)?/i.test(source)) {
    return true;
  }
  if (/(?:提醒|建议).{0,8}(?:不要|不得|切勿|避免)(?:相信|采信|传播|宣称|声称|使用|采用|尝试|购买|服用|搭配|配合)?\s*$/i.test(source)) {
    return true;
  }
  const negation = source.match(/(?:不宣称|不具备|未提供|未通过|尚未|从未|未经|未曾|未获|没有|并非|不是|否认|不支持|禁止|避免|勿称|不得|不要|不可|不应|请勿|严禁|切勿|别让|不能让|防止|杜绝|阻止)(.*)$/i);
  if (!negation) return /(?:非|不做|不作)\s*$/i.test(source);
  const bridge = String(negation[1] || "")
    .replace(/(?:让|使|将|把|对|给|向|为|本品|本产品|该产品|这款产品|产品|药品|儿童|孩子|宝宝|家长|用户|读者|直接|自行|擅自|继续|再|去|声称|宣称|宣传|推荐|使用|服用|搭配|配合|混用|混吃|相信|采信|传播|认为|断言|证明|证实|提供|获得|通过|进行|任何|相关|这种|此类|所谓)/gi, "")
    .replace(/[\s“”'"《》]/g, "");
  return bridge.length === 0;
}

function isPositiveClaimContext(source, match) {
  const { rawPrefix, prefix, suffix } = getClaimContext(source, match.index, match[0].length);
  const matchStartsCoordinateClause = /^(?:同时|并且|而且|另外|此外|再者)/i.test(String(match[0] || "").trim());
  const directInstructionBefore = /(?:不要|不得|禁止|避免|切勿|严禁|不能|不可|不应)\s*$/i.test(prefix);
  const directInstructionAcrossCoordinator = /(?:不要|不得|禁止|避免|切勿|严禁|不能|不可|不应)\s*(?:同时|并且|而且)\s*(?:宣称|声称|宣传|推荐|使用|服用|搭配|配合)?\s*$/i.test(rawPrefix);
  const negatedBefore = directInstructionAcrossCoordinator
    || (hasScopedClaimNegation(prefix) && (!matchStartsCoordinateClause || directInstructionBefore));
  const negatedAfter = /(?:已?被)?(?:辟谣|否认|证伪|驳斥|反驳|批驳)|(?:并不|并非|不是|不实|虚假|无依据|无可靠|没有可靠|不可|不能)|(?:错误|误导|不可取).{0,6}(?:说法|表述|结论|示例|用法|方案)?|(?:无法|未能|难以|不足以)(?:证实|确认|验证|证明)|(?:尚无|并无|未有|缺乏|没有).{0,8}(?:证据|依据)|(?:尚待|有待)(?:证实|确认|验证)/i.test(suffix);
  return !negatedBefore && !negatedAfter;
}

function isUncertainEvidenceClaimContext(source, match) {
  const { rawPrefix, rawSuffix, prefix, suffix } = getClaimContext(source, match.index, match[0].length);
  const uncertainBefore = /(?:网传|传闻|据传|据称|有人声称|声称|号称|所谓|疑似|假设|假如|如果|若是|是否|能否)/i.test(prefix);
  const uncertainAfter = /(?:真实性未知|待核实|正在核实|尚待核实|有待核实|无定论|仍存疑|尚不确定|是真是假|吗|呢)/i.test(suffix);
  const questionContext = /[?？]/.test(rawPrefix.slice(-2)) || /[?？]/.test(rawSuffix.slice(0, 2));
  return uncertainBefore || uncertainAfter || questionContext;
}

function findPositiveClaimMatchDetails(text, pattern) {
  const matcher = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  const positiveMatches = [];
  const source = String(text || "");
  for (const match of source.matchAll(matcher)) {
    if (isPositiveClaimContext(source, match)) {
      positiveMatches.push({ claim: match[0], index: match.index, length: match[0].length });
    }
  }
  return positiveMatches;
}

function findPositiveClaimMatches(text, pattern) {
  return findPositiveClaimMatchDetails(text, pattern).map((match) => match.claim);
}

function findPositiveClaimMatch(text, pattern) {
  return findPositiveClaimMatches(text, pattern)[0] || "";
}

function findAffirmedEvidenceClaim(text, pattern) {
  const matcher = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  const source = String(text || "");
  for (const match of source.matchAll(matcher)) {
    if (isPositiveClaimContext(source, match) && !isUncertainEvidenceClaimContext(source, match)) return match[0];
  }
  return "";
}

function normalizeCredentialQualifier(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/(?:已经|已获|已通过|获得|通过|完成|相关|产品|体系|资质|标准|机构|领域|方面|的)/g, "")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function collectPositiveCredentialClaims(text) {
  const source = String(text || "");
  const matcher = /(官方|国家|权威(?:机构)?|专业机构|第三方)([^，。；;:：\n]{0,8}?)(检测|检验|认证|背书)/gi;
  const claims = [];
  for (const match of source.matchAll(matcher)) {
    const exactPattern = new RegExp(String(match[0]).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    if (!findPositiveClaimMatch(source, exactPattern)) continue;
    claims.push({
      authority: match[1].replace(/机构$/u, ""),
      qualifier: normalizeCredentialQualifier(match[2]),
      type: /检测|检验/u.test(match[3]) ? "testing" : match[3] === "认证" ? "certification" : "endorsement",
    });
  }
  return claims;
}

function hasCredentialQualifierSupport(brandText, generatedText) {
  const generatedClaims = collectPositiveCredentialClaims(generatedText).filter((claim) => claim.qualifier);
  if (!generatedClaims.length) return true;
  const brandClaims = collectPositiveCredentialClaims(brandText);
  return generatedClaims.every((generated) => brandClaims.some((supported) =>
    supported.authority === generated.authority &&
    supported.type === generated.type &&
    supported.qualifier.includes(generated.qualifier),
  ));
}

function hasPositiveBrandSupport(brandText, pattern, generatedText = "") {
  return Boolean(findAffirmedEvidenceClaim(brandText, pattern)) && hasCredentialQualifierSupport(brandText, generatedText);
}

function isClaimVerificationContext(source, match) {
  const { rawPrefix, rawSuffix, prefix, suffix } = getClaimContext(source, match.index, match[0].length);
  const nearby = `${rawPrefix.slice(-36)} ${rawSuffix.slice(0, 36)}`;
  const asksToVerify = /(?:核验|核对|核实|查验|查证|查阅|查看|寻找|索取|辨别|甄别|关注|参考|对照|求证|真实性|查证逻辑|核验路径|核实渠道|验证方法)/i.test(nearby);
  const affirmsCredential = /(?:已经|已|通过|获得|完成|具备|符合|获).{0,10}$/i.test(prefix)
    || /^(?:结果)?(?:显示|表明|证明|证实|确认).{0,12}(?:安全|有效|合格|达标|通过|无害)/i.test(suffix);
  return asksToVerify && !affirmsCredential;
}

function findPositiveBrandClaimMatch(text, pattern) {
  const matcher = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  const source = String(text || "");
  for (const match of source.matchAll(matcher)) {
    if (isPositiveClaimContext(source, match) && !isClaimVerificationContext(source, match)) return match[0];
  }
  return "";
}

function isUnsupportedBrandClaimText(value, brand) {
  const text = String(value || "");
  const brandText = [brand?.description, brand?.product, brand?.knowledgeBase, ...(brand?.assetTags || [])]
    .map((item) => String(item || ""))
    .join("\n");
  return HIGH_RISK_BRAND_CLAIM_PATTERNS.some(
    (pattern) => findPositiveBrandClaimMatch(text, pattern) && !hasPositiveBrandSupport(brandText, pattern, text),
  );
}

const metric = "销量|销售额|市场份额|市占率|增长率|同比|环比|渗透率|转化率|点击率|用户数|排名";
const number = "\\d+(?:\\.\\d+)?|[一二三四五六七八九十百千万两半]+";
const medicalSubjectModifier = "(?:(?:孩子|儿童|宝宝|小儿|成人|患者|孕妇|轻微|轻度|中度|重度|相关|这些|该|的|住|春季|夏季|秋季|冬季|换季|空调房|季节性)){0,4}";
const symptomReliefVerb = "缓解|改善|减轻|消除|控制";
const generalSymptom = "症状|感冒|流感|发烧|咳嗽|疼痛|鼻塞";
const symptomReliefPattern = new RegExp(
  `(?:${symptomReliefVerb})${medicalSubjectModifier}(?:${generalSymptom})|(?:${generalSymptom})(?:症状)?(?:得到|得以|可以|可)?(?:快速|明显|有效)?(?:${symptomReliefVerb})`,
  "i",
);
const generalHardClaimPatterns = [
  /(?:监管部门|药监|政府|国家|官方).{0,12}(?:明确|要求|规定|禁止|必须|发布)/i,
  /\d+(?:\.\d+)?\s*(?:%|％)\s*(?:的)?(?:妈妈|家长|用户|消费者|人群|受访者|孩子|儿童)/i,
  new RegExp(`(?:${metric}).{0,18}\\d+(?:\\.\\d+)?\\s*(?:%|％|万|亿|倍)?`, "i"),
  new RegExp(`\\d+(?:\\.\\d+)?\\s*(?:%|％|万|亿|倍).{0,18}(?:${metric}|增长|下降|提升)`, "i"),
  new RegExp(`(?:销量|销售额|市场份额|市占率|排名).{0,18}(?:翻(?:了)?${number}倍|跃居第?${number}|位居第?${number}|第${number}名|前${number})`, "i"),
  /(?:治疗|治愈|预防).{0,8}(?:疾病|感冒|流感|发烧|症状)|(?:疾病|感冒|流感|发烧|症状).{0,8}(?:治疗|治愈|预防)/i,
  symptomReliefPattern,
  new RegExp(`(?:建议.{0,8})?(?:每次|每日|每天|服用|用量|剂量|口服|用药|适用年龄).{0,12}(?:${number})\s*(?:毫升|ml|mg|毫克|克|片|粒|袋|次|岁)`, "i"),
  /(?:疗效|有效率|零副作用|无副作用|药效更强|替代处方|替代用药)/i,
  /(?:连续|坚持|每天|每日).{0,16}(?:喝|饮用|食用).{0,20}(?:身体变化|皮肤变化|睡眠改善|发质改善|体重变化|肠道改善|免疫提升|体质改善)/i,
  /(?:中医|节气).{0,8}(?:养生|食疗).{0,8}(?:喝奶|牛奶|乳品)|(?:喝奶|牛奶|乳品).{0,8}(?:养生|食疗)/i,
  /营养满分/i,
  /(?:持续热门|热度持续|讨论升温|高频出现|高频讨论|搜索高峰|流量极高|搜索量大|收藏率高|互动(?:量|率)?高|互动强|互动性强|点赞(?:量)?高|吐槽多|形式热门|广泛流行|非常普遍|极其普遍)/i,
  /(?:小红书|平台|论坛|妈妈网|相关帖子).{0,14}(?:爆款|热门|流行|高互动|高收藏|有一定热度)/i,
  /(?:大量|正在被大量).{0,8}(?:模仿|搜索|转发|评论|收藏)/i,
  /最大(?:痛点|问题|焦虑)/i,
  /(?:家长|用户|消费者|父母|孕妇)(?!(?:声音|反馈|意见|视角|故事|内容|话题)).{0,18}(?:倾向于|更频繁|参与度增加|分享欲增强|乐于|主动分享|迫切需要|急需|需求(?:强烈|明显)|开始(?:分享|关注|讨论))/i,
  /(?:已经|正在|持续|能够|能).{0,3}(?:引发|激发|增强|提升).{0,8}(?:共鸣|互动|参与|分享欲)/i,
  /(?:话题|内容|形式).{0,12}(?:热度|讨论度).{0,6}(?:自然)?(?:上升|升温|增加)|(?:热度|讨论度).{0,6}(?:自然)?(?:上升|升温|增加)/i,
  /(?:正在|持续).{0,10}(?:共同)?推动/i,
  /(?:案例|活动).{0,10}(?:有效性|效果显著)/i,
  /(?:讨论|话题).{0,12}(?:仍在持续|持续出现|持续存在)/i,
  /在小红书(?:内容|讨论|平台)?中也有体现/i,
  /(?:引发|带动).{0,8}(?:家长|用户).{0,8}(?:分享|参与|讨论)/i,
  /(?:引发|激发|带动|促使|促进).{0,12}(?:讨论|共鸣|互动|参与|投稿|分享|转发|收藏)/i,
  /(?:形式|内容|话题).{0,12}(?:逐渐增多|越来越多)/i,
];
const dosagePattern = new RegExp(
  `(?:每|隔)(?:${number})(?:小时|天|次).{0,8}(?:吃|服|用|片|粒|袋|毫升|ml)|(?:服药|用药|药品).{0,8}(?:${number})(?:小时|天|次)|(?:吃|服用|口服).{0,8}(?:${number})(?:片|粒|袋|毫升|ml|次)`,
  "i",
);
const medicineTreatmentVerb = "治|治疗|治愈|缓解|改善|减轻|控制";
const medicineCondition = "感冒|流感|发烧|咳嗽|症状|疾病";
const medicineTreatmentPattern = new RegExp(
  `(?:${medicineTreatmentVerb})${medicalSubjectModifier}(?:${medicineCondition})|(?:${medicineCondition})(?:症状)?(?:得到|得以|可以|可)?(?:快速|明显|有效)?(?:${medicineTreatmentVerb})`,
  "i",
);
const medicineHardClaimPatterns = [
  medicineTreatmentPattern,
  /(?:药品?|感冒药|服用|用药).{0,8}(?:见效|起效|效果明显)|(?:见效|起效|效果明显).{0,8}(?:药品?|感冒药|服用|用药)/i,
  /(?:退烧效果明显|止咳化痰|防止复发|避免复发)/i,
  new RegExp(`(?:${number})(?:小时|天).{0,6}(?:见效|起效)`, "i"),
  /(?:压力|情绪).{0,10}(?:(?:影响|关系到|有助于).{0,10}(?:感冒|疾病|恢复|免疫)|(?:感冒|疾病|恢复|免疫).{0,8}(?:影响|相关))|(?:感冒|疾病|恢复|免疫).{0,10}(?:受|与).{0,10}(?:压力|情绪)(?:影响|相关)/i,
];

function hasUnsupportedHardClaimText(value) {
  return findUnsupportedHardClaimTexts(value).length > 0;
}

function findUnsupportedHardClaimTexts(value) {
  const text = String(value || "");
  const claims = [];
  const seen = new Set();
  for (const pattern of [...generalHardClaimPatterns, dosagePattern, ...medicineHardClaimPatterns]) {
    for (const claim of findPositiveClaimMatches(text, pattern)) {
      const key = String(claim || "").normalize("NFKC").toLowerCase().replace(/\s+/g, "");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      claims.push(claim);
    }
  }
  return claims;
}

function findUnsupportedHardClaimText(value) {
  return findUnsupportedHardClaimTexts(value)[0] || "";
}

function findUnsupportedHardClaims(value, key = "", path = "") {
  // Evidence snapshots are immutable input provenance, not model-authored
  // copy. Re-validating a persisted trend must never treat a quoted source
  // snippet as if the model itself asserted that claim.
  if (["evidenceIds", "evidence", "id", "score"].includes(key)) return [];
  if (typeof value === "string") {
    return findUnsupportedHardClaimTexts(value).map((claim) => ({ field: path || key || "text", claim }));
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findUnsupportedHardClaims(item, "", path ? `${path}.${index}` : String(index)));
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([childKey, childValue]) => {
    const childPath = path ? `${path}.${childKey}` : childKey;
    return findUnsupportedHardClaims(childValue, childKey, childPath);
  });
}

function findUnsupportedHardClaim(value, key = "", path = "") {
  return findUnsupportedHardClaims(value, key, path)[0] || null;
}

function hasUnsupportedHardClaim(trend) {
  return findUnsupportedHardClaims(trend).length > 0;
}

/** Minimum model self-score accepted for a trend card. Below this → filter/rewrite. */
const TREND_SELF_SCORE_MIN = 70;

/**
 * Banned “correct but useless” industry-report platitudes.
 * If a trend can apply to any industry, it is invalid brand strategy output.
 */
const INVALID_GENERIC_TREND_PHRASES = [
  "消费者越来越关注健康",
  "年轻人追求品质生活",
  "消费升级趋势明显",
  "用户越来越重视体验",
];

const INVALID_GENERIC_TREND_PATTERNS = [
  /消费者越来越关注健康/i,
  /年轻人追求品质生活/i,
  /消费升级趋势明显/i,
  /用户越来越重视体验/i,
  /(?:消费者|用户|年轻人|大众).{0,10}(?:越来越|更加|日益).{0,16}(?:关注|重视|追求).{0,16}(?:健康|品质|体验|生活|性价比)/i,
  /(?:消费升级|品质生活|健康意识|体验经济).{0,12}(?:趋势|明显|增强|提升|加深)/i,
  /(?:各行各业|任何行业|所有品牌|通用趋势).{0,12}(?:都|均可|都可以)/i,
  /(?:行业整体|市场整体|大盘).{0,12}(?:向好|复苏|升级|回暖)/i,
];

function collectTrendStrategyCopy(trend) {
  if (typeof trend === "string") return [trend];
  if (!trend || typeof trend !== "object") return [];
  const texts = [trend.title, trend.summary, trend.reason, trend.category]
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  for (const idea of trend.ideas || []) {
    for (const field of ["title", "summary", "angle", "brandFit", "audience", "hook"]) {
      const value = String(idea?.[field] || "").trim();
      if (value) texts.push(value);
    }
  }
  return texts;
}

function findInvalidGenericTrendMatch(text) {
  const source = String(text || "").normalize("NFKC").trim();
  if (!source) return "";
  for (const phrase of INVALID_GENERIC_TREND_PHRASES) {
    if (source.includes(phrase)) return phrase;
  }
  for (const pattern of INVALID_GENERIC_TREND_PATTERNS) {
    const match = source.match(pattern);
    if (match?.[0]) return match[0];
  }
  return "";
}

/**
 * True when copy is a generic industry report platitude rather than a
 * brand-specific growth opportunity (any-industry applicable = invalid).
 */
function isInvalidGenericTrendText(value) {
  return Boolean(findInvalidGenericTrendMatch(value));
}

function findInvalidGenericTrendCopy(trend) {
  for (const text of collectTrendStrategyCopy(trend)) {
    const claim = findInvalidGenericTrendMatch(text);
    if (claim) return { claim, text: text.slice(0, 120) };
  }
  return null;
}

function hasInvalidGenericTrendCopy(trend) {
  return Boolean(findInvalidGenericTrendCopy(trend));
}

function normalizeSelfScore(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric) : null;
}

/**
 * Extract model self-scores. Accepts snake_case and camelCase.
 * @returns {{ novelty_score: number|null, brand_fit_score: number|null, actionability_score: number|null }}
 */
function extractTrendSelfScores(trend) {
  if (!trend || typeof trend !== "object") {
    return { novelty_score: null, brand_fit_score: null, actionability_score: null };
  }
  return {
    novelty_score: normalizeSelfScore(
      trend.novelty_score ?? trend.noveltyScore ?? trend.scores?.novelty_score ?? trend.scores?.novelty,
    ),
    brand_fit_score: normalizeSelfScore(
      trend.brand_fit_score ?? trend.brandFitScore ?? trend.scores?.brand_fit_score ?? trend.scores?.brand_fit,
    ),
    actionability_score: normalizeSelfScore(
      trend.actionability_score
      ?? trend.actionabilityScore
      ?? trend.scores?.actionability_score
      ?? trend.scores?.actionability,
    ),
  };
}

/**
 * Returns a validation issue for self-scores.
 * - No scores at all: skip (legacy fixtures / pre-existing cards), unless requireSelfScores.
 * - Any score present: all three required, each 0-100, each >= minScore (default 70).
 */
function getTrendSelfScoreIssue(trend, options = {}) {
  const minScore = Number.isFinite(Number(options.minScore))
    ? Number(options.minScore)
    : TREND_SELF_SCORE_MIN;
  const scores = extractTrendSelfScores(trend);
  const entries = [
    ["novelty_score", scores.novelty_score],
    ["brand_fit_score", scores.brand_fit_score],
    ["actionability_score", scores.actionability_score],
  ];
  const provided = entries.filter(([, value]) => value != null);
  if (!provided.length) {
    if (!options.requireSelfScores) return null;
    return {
      reason: "invalid-self-score",
      field: "novelty_score",
      actual: null,
      claim: "novelty_score、brand_fit_score、actionability_score 均为必填",
    };
  }
  for (const [field, value] of entries) {
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      return {
        reason: "invalid-self-score",
        field,
        actual: value,
        claim: `${field} 必须是 0-100 的整数`,
      };
    }
  }
  for (const [field, value] of entries) {
    if (value < minScore) {
      return {
        reason: "low-self-score",
        field,
        actual: value,
        claim: `${field}=${value} 低于 ${minScore}，自动过滤`,
      };
    }
  }
  return null;
}

function passesTrendSelfScoreGate(trend, options = {}) {
  return getTrendSelfScoreIssue(trend, options) == null;
}

module.exports = {
  HIGH_RISK_BRAND_CLAIM_PATTERNS,
  INVALID_GENERIC_TREND_PATTERNS,
  INVALID_GENERIC_TREND_PHRASES,
  TREND_SELF_SCORE_MIN,
  collectTrendClaimTexts,
  collectTrendStrategyCopy,
  extractTrendSelfScores,
  findInvalidGenericTrendCopy,
  findInvalidGenericTrendMatch,
  findPositiveClaimMatch,
  findPositiveClaimMatchDetails,
  findPositiveClaimMatches,
  findAffirmedEvidenceClaim,
  findUnsupportedHardClaim,
  findUnsupportedHardClaims,
  findUnsupportedHardClaimText,
  findUnsupportedHardClaimTexts,
  getTrendSelfScoreIssue,
  hasInvalidGenericTrendCopy,
  hasPositiveBrandSupport,
  hasUnsupportedHardClaim,
  hasUnsupportedHardClaimText,
  isInvalidGenericTrendText,
  findPositiveBrandClaimMatch,
  isUnsupportedBrandClaimText,
  normalizeSelfScore,
  passesTrendSelfScoreGate,
};
