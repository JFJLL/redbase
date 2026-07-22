const CHINESE_YEAR_DIGITS = { 零: "0", 〇: "0", "○": "0", 一: "1", 二: "2", 两: "2", 三: "3", 四: "4", 五: "5", 六: "6", 七: "7", 八: "8", 九: "9" };
const PRICE_AMOUNT_AT_START_PATTERN = /^\s*(\d+(?:[.,]\d+)?|[零〇○一二两三四五六七八九十百千万几数]+(?:点[零〇○一二两三四五六七八九]+)?)/u;
const PRICE_AMOUNT_ANYWHERE_PATTERN = /(?:\d+(?:[.,]\d+)?|[零〇○一二两三四五六七八九十百千万几数]+(?:点[零〇○一二两三四五六七八九]+)?)/u;
const NON_PRICE_QUANTITY_UNIT_PATTERN = /^(?:小时|分钟|秒|天|周|月|年|人|次|轮|步|招|点|倍|档|层|篇|条|张|场|份|个|盏|套|项|组|类|种|款|版|期|章|页|帧|公里|米|厘米|毫米|克|千克|公斤|升|毫升|盒|瓶|包|袋|箱|件|区域)/u;
const NON_PRICE_YUAN_SUFFIX_PATTERN = /^(?:旦|宵|节|月|年|组|素|数据|宇宙|乳业|材料|催化|锂|关系|对立|函数|方程|结构|模型|体系|组合|次)/u;
const STRONG_PRICE_CONTEXT_LABEL_PATTERN = /(?:到手价|售价|活动价|秒杀价|会员价|现价|促销价|优惠价|券后价?|折后价?|套餐价|低至|优惠后|补贴后|人均|客单价|价格|报价)/gu;
const CONDITIONAL_PRICE_CONTEXT_LABEL_PATTERN = /(?:到手|仅|只要)/gu;
const COST_CONTEXT_LABEL_PATTERN = /(?:成本|预算|花费|投入)/gu;
const APPROXIMATE_PRICE_AMOUNT_PATTERN = /^(?:几|数|上)(?:十|百|千|万)/u;

function normalizeTrendCopy(value) {
  return String(value || "").normalize("NFKC");
}

function getExplicitTrendYears(value) {
  const text = normalizeTrendCopy(value);
  const years = [];
  for (const match of text.matchAll(/(?<!\d)((?:19|20)\d{2})(?!\d)/g)) {
    const suffix = text.slice(match.index + match[0].length);
    if (/^\s*[x×*]\s*\d{3,4}(?!\d)/iu.test(suffix)) continue;
    years.push(Number(match[1]));
  }
  for (const match of text.matchAll(/([二〇○零一两三四五六七八九]{4})\s*年/g)) {
    const numeric = Number([...match[1]].map((character) => CHINESE_YEAR_DIGITS[character] || "").join(""));
    if (Number.isInteger(numeric)) years.push(numeric);
  }
  for (const match of text.matchAll(/(?<!\d)(\d{2})\s*年/g)) {
    const prefix = text.slice(Math.max(0, match.index - 8), match.index);
    if (/(?:品牌|成立|创立|深耕|专注|发展|历经|走过|持续)\s*$/u.test(prefix)) continue;
    years.push(2000 + Number(match[1]));
  }
  return [...new Set(years)];
}

function readPriceAmount(value) {
  const match = PRICE_AMOUNT_AT_START_PATTERN.exec(value);
  if (!match) return null;
  return {
    amount: match[1],
    rest: value.slice(match[0].length).trimStart(),
  };
}

function hasExplicitPriceUnit(rest, options = {}) {
  if (rest.startsWith("元")) return options.inPriceContext || !NON_PRICE_YUAN_SUFFIX_PATTERN.test(rest.slice(1));
  if (rest.startsWith("块钱")) return true;
  if (!rest.startsWith("块")) return false;
  if (options.inPriceContext) return true;
  return /^块\s*(?:钱|的?\s*(?:促销|优惠|套餐|到手|售价|价格|预算|折扣))/u.test(rest);
}

function readContextualPriceAmount(tail) {
  const searchable = tail.slice(0, 12);
  const amountMatch = PRICE_AMOUNT_ANYWHERE_PATTERN.exec(searchable);
  if (!amountMatch || amountMatch.index > 8) return null;
  const amount = readPriceAmount(searchable.slice(amountMatch.index));
  return amount ? { ...amount, prefix: searchable.slice(0, amountMatch.index) } : null;
}

function hasStrongContextualPriceAmount(tail) {
  const amount = readContextualPriceAmount(tail);
  if (!amount) return false;
  if (hasExplicitPriceUnit(amount.rest, { inPriceContext: true })) return true;
  return !NON_PRICE_QUANTITY_UNIT_PATTERN.test(amount.rest) && !/^%/u.test(amount.rest);
}

function hasConditionalContextualPriceAmount(tail) {
  const amount = readContextualPriceAmount(tail);
  if (!amount) return false;
  if (hasExplicitPriceUnit(amount.rest, { inPriceContext: true })) return true;
  return !NON_PRICE_QUANTITY_UNIT_PATTERN.test(amount.rest) && !/^%/u.test(amount.rest);
}

function hasCostContextualPriceAmount(tail) {
  const amount = readContextualPriceAmount(tail);
  if (!amount) return false;
  if (hasExplicitPriceUnit(amount.rest, { inPriceContext: true })) return true;
  if (NON_PRICE_QUANTITY_UNIT_PATTERN.test(amount.rest) || /^%/u.test(amount.rest)) return false;
  return APPROXIMATE_PRICE_AMOUNT_PATTERN.test(amount.amount) || /^\d{3,}(?:[.,]\d+)?$/u.test(amount.amount);
}

function hasVolatileTrendPrice(value) {
  const text = normalizeTrendCopy(value);
  const amountSource = "(?:\\d+(?:[.,]\\d+)?|[零〇○一二两三四五六七八九十百千万几数]+(?:点[零〇○一二两三四五六七八九]+)?)";
  if (new RegExp(`(?:[¥￥]|RMB|CNY|人民币)\\s*${amountSource}`, "iu").test(text)) return true;

  for (const match of text.matchAll(new RegExp(amountSource, "gu"))) {
    const amount = readPriceAmount(text.slice(match.index));
    if (!amount) continue;
    const isArabicAmount = /^\d/u.test(amount.amount);
    if (isArabicAmount && hasExplicitPriceUnit(amount.rest)) return true;
    if (!isArabicAmount && /^元\s*(?:$|[/／]\s*(?:件|盒|瓶|包|袋|箱))/u.test(amount.rest)) return true;
    if (!isArabicAmount && amount.rest.startsWith("元") && !NON_PRICE_YUAN_SUFFIX_PATTERN.test(amount.rest.slice(1))
      && /^元[^，。；;]{0,8}(?:促销|优惠|套餐|折扣|到手|售价|价格|包邮|起)/u.test(amount.rest)) return true;
    if (isArabicAmount && /^(?:包邮|起)/u.test(amount.rest)) return true;
    if (/^块钱/u.test(amount.rest) || /^块\s*(?:钱|包邮|的?\s*(?:促销|优惠|套餐|到手|售价|价格|预算|折扣))/u.test(amount.rest)) return true;
  }

  for (const match of text.matchAll(STRONG_PRICE_CONTEXT_LABEL_PATTERN)) {
    if (hasStrongContextualPriceAmount(text.slice(match.index + match[0].length))) return true;
  }
  for (const match of text.matchAll(CONDITIONAL_PRICE_CONTEXT_LABEL_PATTERN)) {
    if (hasConditionalContextualPriceAmount(text.slice(match.index + match[0].length))) return true;
  }
  for (const match of text.matchAll(COST_CONTEXT_LABEL_PATTERN)) {
    if (hasCostContextualPriceAmount(text.slice(match.index + match[0].length))) return true;
  }
  return false;
}

module.exports = {
  getExplicitTrendYears,
  hasVolatileTrendPrice,
};
