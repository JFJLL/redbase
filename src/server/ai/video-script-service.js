const { callTextModelJson, callVisionModelJson } = require("./text-provider");

const ALLOWED_TOTAL_DURATIONS = [15, 30, 45, 60];

function normalizeTotalDuration(duration) {
  const num = Number(duration);
  if (ALLOWED_TOTAL_DURATIONS.includes(num)) return num;
  if (!Number.isFinite(num) || num <= 20) return 15;
  if (num <= 38) return 30;
  if (num <= 52) return 45;
  return 60;
}

function compactString(value, fallback = "", maxLen = 2000) {
  const text = String(value ?? fallback).trim();
  return text.slice(0, maxLen);
}

function buildSystemPrompt() {
  return `你是一位顶尖的 AI 视频创意总监与分镜提示词工程师（擅长 Kling / 可灵、Hailuo / 海螺、Sora、Runway Gen-3 等现代 AI 视频生成模型）。

【核心使命】
根据用户提供的品牌档案、热点趋势、内容选题以及参考素材（产品图、风格图、品牌标识），生成一套面向现代 AI 视频生成模型直接使用的“结构化视频分镜脚本与完整中文提示词”。

【重要产品原则】
1. 只生成面向 AI 视频生成模型的提示词与分镜描述，严禁生成真人实拍执行内容（禁止出现摄影师安排、相机/镜头/灯具型号、场地勘景、拍摄日程、演员通告、道具采购清单、摄制组分工、机位编号、真人拍摄预算等）。
2. “镜头运动/运镜”“景别”“视角”属于 AI 视频提示词语言，应当保留并详细描述。
3. 视频总时长必须确定为 15、30、45 或 60 秒之一（若用户指定了时长请严格遵循；未指定时由模型智能确定，推荐 15 秒或 30 秒）。
4. 每个分镜片段（Clip）建议时长为 3 至 10 秒，相邻片段首尾时间必须严格连续（第1段从0秒开始，第N段结束时间等于总时长，无重叠、无空档）。
5. 素材角色严格分离：
   - 有产品参考图时：分镜的主体参考（subjectReference）必须准确引用具体产品的造型、材质、包装、色彩与细节；
   - 有风格参考图时：风格图只控制画面的色调、光影、材质质感、构图和整体氛围，严禁将风格图里的人物、产品、文字或具体物体复制到视频画面中；
   - 无参考图时：主体参考使用准确细腻的文字具象化描述。
6. 【中文语言要求】所有输出内容包括分镜生成提示词（prompt）、画面描述、主体动作、镜头运动、环境动态、音频提示等，必须全部使用中文生成！生成丰富、具象、具备电影质感且适合国内主流 AI 视频模型直接执行的中文生成提示词。

【输出格式】
必须严格输出纯 JSON 对象，不得包含任何 Markdown 代码块标签外的额外文字：
{
  "title": "视频脚本标题",
  "creativeConcept": "视频核心创意与传播策略概要",
  "totalDurationSec": 30,
  "aspectRatio": "9:16",
  "globalSubjectReference": "全片主体参考要求",
  "globalStyleReference": "全片视觉色调与风格参考要求",
  "globalContinuity": "全片人物/主体/光影连续性衔接要求",
  "audioDirection": {
    "music": "BGM音乐风格与节奏要求",
    "ambience": "环境音效设计",
    "voiceStyle": "配音/解说语调风格"
  },
  "clips": [
    {
      "index": 1,
      "startSec": 0,
      "endSec": 5,
      "durationSec": 5,
      "purpose": "片段作用（如：开场吸睛/痛点呈现/产品登场/核心亮点/情绪高潮/行动呼吁）",
      "referenceAssets": [
        { "kind": "product", "label": "产品图1", "description": "正面包装与质感" }
      ],
      "subjectReference": "本片段主体参考具体描述",
      "firstFrame": "首帧画面详细描述",
      "lastFrame": "尾帧画面详细描述",
      "scene": "场景环境与空间氛围描述",
      "subjectAction": "主体运动与动态变化过程",
      "cameraMovement": "运镜方式（如：低角度慢速推近、环绕上升特写、平滑横移跟踪等）",
      "environmentMotion": "环境动态（如：光影流转、微风吹拂发丝、空气微粒、水滴飞溅等）",
      "lightingAndStyle": "光线质感、色调、电影感与材质细节",
      "audioPrompt": "音频提示（音效配合点、音乐高潮点）",
      "voiceover": "画外音/旁白文字（如无则留空）",
      "dialogue": "台词/对话文字（如无则留空）",
      "onScreenText": "画面花字/排版字幕（如无则留空）",
      "transition": "与下一段的转场方式（如：匹配剪辑、快速横摇、淡入淡出、运动模糊转场等）",
      "continuity": "与前一片段的人物状态、空间位置或光线连贯性要求",
      "prompt": "可直接复制给 AI 视频模型的完整高质量中文提示词，必须使用中文描述，包含清晰的主体特征、动作细节、场景环境、镜头运动、光影氛围与电影级画质控制词。"
    }
  ]
}`;
}

function buildUserPrompt({ brand, trend, idea, aspectRatio, targetDuration = null, images = [] }) {
  const parts = [];

  parts.push("【任务目标】");
  parts.push("请根据以下品牌信息、选题视角与视频参数要求，创作一份完整的结构化 AI 视频生成脚本与分镜中文提示词。");
  parts.push(`要求输出视频比例：${aspectRatio || "9:16"}`);
  if (targetDuration) {
    parts.push(`指定视频总时长：${targetDuration} 秒（必须严格将所有分镜时长划分并保证总和为 ${targetDuration} 秒）`);
  }

  parts.push("\n【品牌档案】");
  parts.push(`- 品牌名称：${brand?.name || "未命名品牌"}`);
  parts.push(`- 品牌类型：${brand?.profileType === "personal" ? "个人 IP" : "商业品牌"}`);
  if (brand?.industry) parts.push(`- 所属行业：${brand.industry}`);
  if (brand?.description) parts.push(`- 品牌描述：${brand.description}`);
  if (brand?.product) parts.push(`- 产品/服务：${brand.product}`);
  if (brand?.audience) parts.push(`- 目标受众：${brand.audience}`);
  if (brand?.goal) parts.push(`- 品牌目标：${brand.goal}`);
  if (brand?.personaStyle) parts.push(`- 人设/调性：${brand.personaStyle}`);

  parts.push("\n【热点趋势与内容选题】");
  parts.push(`- 趋势热点：${trend?.title || "-"}`);
  if (trend?.category) parts.push(`- 趋势分类：${trend.category}`);
  if (trend?.summary) parts.push(`- 趋势概要：${trend.summary}`);

  parts.push(`- 选题标题：${idea?.title || "-"}`);
  parts.push(`- 内容摘要：${idea?.summary || "-"}`);
  parts.push(`- 切入角度：${idea?.angle || "-"}`);
  parts.push(`- 品牌结合：${idea?.brandFit || "-"}`);
  parts.push(`- 面向人群：${idea?.audience || "-"}`);
  parts.push(`- 开头钩子：${idea?.hook || "-"}`);
  if (Array.isArray(idea?.tags) && idea.tags.length) {
    parts.push(`- 话题标签：${idea.tags.join("、")}`);
  }

  const productImages = images.filter((img) => img.role === "product");
  const styleImages = images.filter((img) => img.role === "style");
  const logoImages = images.filter((img) => img.role === "logo");

  parts.push("\n【素材输入说明】");
  if (productImages.length > 0) {
    parts.push(`- 提供了 ${productImages.length} 张产品参考图。请将这些产品作为画面的核心主体，准确引用产品形态与包装细节。`);
  } else {
    parts.push("- 未提供产品参考图，请通过细腻的文字设定画面主体。");
  }

  if (styleImages.length > 0) {
    parts.push("- 提供了 1 张风格参考图。请将该风格图的色彩体系、光影质感、构图比例与美术风格应用到全部视频分镜中，但不要复制风格图中的具体物体。");
  }

  if (logoImages.length > 0) {
    parts.push(`- 提供了 ${brand?.profileType === "personal" ? "个人头像" : "品牌 Logo"} 参考，注意在片尾或关键时刻保持品牌识别规范。`);
  }

  parts.push("\n请开始生成完整的视频脚本 JSON 对象，所有提示词与描述必须为中文。");
  return parts.join("\n");
}

function validateAndNormalizeVideoScript(raw, { requestedAspectRatio = "9:16", targetDuration = null, idea = {} } = {}) {
  if (!raw || typeof raw !== "object") {
    throw new Error("模型返回的不是有效的脚本对象。");
  }

  const title = compactString(raw.title, idea?.title || "AI 视频脚本", 120);
  const creativeConcept = compactString(raw.creativeConcept, idea?.summary || "视频创意方案", 500);
  const totalDurationSec = targetDuration ? normalizeTotalDuration(targetDuration) : normalizeTotalDuration(raw.totalDurationSec);
  const aspectRatio = compactString(raw.aspectRatio, requestedAspectRatio || "9:16", 20);

  const globalSubjectReference = compactString(raw.globalSubjectReference, "保持全片主体特征与质感一致", 500);
  const globalStyleReference = compactString(raw.globalStyleReference, "电影感光影与统一色调", 500);
  const globalContinuity = compactString(raw.globalContinuity, "分镜间动作与光线自然衔接", 500);

  const rawAudio = raw.audioDirection && typeof raw.audioDirection === "object" ? raw.audioDirection : {};
  const audioDirection = {
    music: compactString(rawAudio.music, "轻快节奏与情绪衬托", 200),
    ambience: compactString(rawAudio.ambience, "逼真环境音效与动态声场", 200),
    voiceStyle: compactString(rawAudio.voiceStyle, "清晰自然、富有感染力的解说语调", 200),
  };

  const rawClips = Array.isArray(raw.clips) ? raw.clips : [];
  if (rawClips.length < 2) {
    throw new Error("视频脚本分镜片段数量不足（至少需要 2 个片段）。");
  }

  // 修复与标准化时间轴
  const clips = [];
  let currentStart = 0;
  const clipCount = Math.min(rawClips.length, 10);

  for (let i = 0; i < clipCount; i++) {
    const rawClip = rawClips[i] || {};
    const isLast = i === clipCount - 1;

    let clipDuration = Number(rawClip.durationSec);
    if (!Number.isFinite(clipDuration) || clipDuration <= 0) {
      const rawDiff = Number(rawClip.endSec) - Number(rawClip.startSec);
      clipDuration = Number.isFinite(rawDiff) && rawDiff > 0 ? rawDiff : Math.round(totalDurationSec / clipCount);
    }

    // 限制单段在 2-15 秒之间
    clipDuration = Math.max(2, Math.min(15, clipDuration));

    let clipEnd = currentStart + clipDuration;
    if (isLast) {
      clipEnd = totalDurationSec;
      clipDuration = Math.max(1, clipEnd - currentStart);
    } else if (clipEnd >= totalDurationSec) {
      clipEnd = totalDurationSec - 2;
      clipDuration = Math.max(2, clipEnd - currentStart);
    }

    const firstFrame = compactString(rawClip.firstFrame, "特写镜头，主体清晰呈现", 500);
    const lastFrame = compactString(rawClip.lastFrame, "主体动作完成，平滑过渡", 500);
    const subjectReference = compactString(rawClip.subjectReference, globalSubjectReference, 500);
    const audioPrompt = compactString(rawClip.audioPrompt, "背景音乐铺垫与环境音效", 300);
    const prompt = compactString(
      rawClip.prompt,
      `电影级高清画质，${compactString(rawClip.scene, "现代生活场景")}，${compactString(rawClip.subjectAction, "主体自然运动")}，${compactString(rawClip.cameraMovement, "平滑推近运镜")}，自然光影氛围，照片级真实细节。`,
      2000,
    );

    if (!prompt) {
      throw new Error(`第 ${i + 1} 个分镜缺少生成提示词。`);
    }

    clips.push({
      index: i + 1,
      startSec: currentStart,
      endSec: clipEnd,
      durationSec: clipDuration,
      purpose: compactString(rawClip.purpose, `分镜 ${i + 1}`, 100),
      referenceAssets: Array.isArray(rawClip.referenceAssets) ? rawClip.referenceAssets : [],
      subjectReference,
      firstFrame,
      lastFrame,
      scene: compactString(rawClip.scene, "生活化场景", 500),
      subjectAction: compactString(rawClip.subjectAction, "主体自然运动", 500),
      cameraMovement: compactString(rawClip.cameraMovement, "平滑推近镜头", 300),
      environmentMotion: compactString(rawClip.environmentMotion, "光影流转与环境微动", 300),
      lightingAndStyle: compactString(rawClip.lightingAndStyle, "自然柔和光照，电影感质感", 300),
      audioPrompt,
      voiceover: compactString(rawClip.voiceover, "", 500),
      dialogue: compactString(rawClip.dialogue, "", 500),
      onScreenText: compactString(rawClip.onScreenText, "", 200),
      transition: compactString(rawClip.transition, "顺畅切换至下一分镜", 200),
      continuity: compactString(rawClip.continuity, "保持主体位置与光线连续", 300),
      prompt,
    });

    currentStart = clipEnd;
  }

  // 最终确保最后一段 endSec 等于 totalDurationSec
  if (clips.length > 0) {
    const last = clips[clips.length - 1];
    last.endSec = totalDurationSec;
    last.durationSec = last.endSec - last.startSec;
  }

  return {
    title,
    creativeConcept,
    totalDurationSec,
    aspectRatio,
    globalSubjectReference,
    globalStyleReference,
    globalContinuity,
    audioDirection,
    clips,
  };
}

async function repairVideoScript(appConfig, brokenScript, errorMessage, context) {
  const systemPrompt = `你是一位脚本修复专家。之前生成的 AI 视频脚本存在以下问题：
${errorMessage}

请修正问题并输出符合完整 Schema 的纯 JSON 脚本，所有提示词和描述必须为中文。`;

  const userPrompt = `请修复以下脚本数据：\n${JSON.stringify(brokenScript, null, 2)}`;

  const raw = await callTextModelJson(appConfig, {
    systemPrompt,
    userPrompt,
    temperature: 0.2,
    maxOutputTokens: 8192,
  });

  return validateAndNormalizeVideoScript(raw, context);
}

async function generateVideoScript(
  appConfig,
  { brand, trend, idea, aspectRatio = "9:16", durationSelection = "auto", images = [] } = {},
) {
  const safeAspectRatio = aspectRatio === "smart" || !aspectRatio ? "9:16" : aspectRatio;
  const targetDuration =
    durationSelection && durationSelection !== "auto" && ALLOWED_TOTAL_DURATIONS.includes(Number(durationSelection))
      ? Number(durationSelection)
      : null;

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt({
    brand,
    trend,
    idea,
    aspectRatio: safeAspectRatio,
    targetDuration,
    images,
  });

  let rawScript;
  if (images && images.length > 0) {
    rawScript = await callVisionModelJson(appConfig, {
      systemPrompt,
      userPrompt,
      images,
      temperature: 0.3,
      maxOutputTokens: 8192,
      maxAttempts: 2,
    });
  } else {
    rawScript = await callTextModelJson(appConfig, {
      systemPrompt,
      userPrompt,
      temperature: 0.3,
      maxOutputTokens: 8192,
      maxAttempts: 2,
    });
  }

  try {
    return validateAndNormalizeVideoScript(rawScript, {
      requestedAspectRatio: safeAspectRatio,
      targetDuration,
      brand,
      idea,
    });
  } catch (validationError) {
    // 允许一次模型修复尝试
    try {
      return await repairVideoScript(appConfig, rawScript, validationError.message, {
        requestedAspectRatio: safeAspectRatio,
        targetDuration,
        brand,
        idea,
      });
    } catch (_repairError) {
      throw validationError;
    }
  }
}

module.exports = {
  ALLOWED_TOTAL_DURATIONS,
  normalizeTotalDuration,
  buildSystemPrompt,
  buildUserPrompt,
  validateAndNormalizeVideoScript,
  generateVideoScript,
};
